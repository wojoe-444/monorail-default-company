#!/usr/bin/env node
/**
 * MonoRail Dataform Blast-Radius, Lineage DAG, Schema Diff & SQL Inspector.
 *
 * Zero-dependency Node.js analyzer that turns `dataform compile --json` output
 * plus `models/malloy/*.malloy` into:
 *   1. An interactive Mermaid lineage & blast-radius diagram for GitHub PRs
 *   2. A risk score + downstream model / assertion / Malloy impact breakdown
 *   3. A base-vs-head Schema & Contract Diff (columns, model type, tags, deps)
 *   4. On-demand compiled BigQuery SQL inspection for `/compile <model>`
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function targetKey(t) {
  if (!t) return ''
  return `${t.schema}.${t.name}`
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

function parseMalloySources(repoRoot) {
  const malloyDir = path.join(repoRoot, 'models', 'malloy')
  const sources = []
  if (!fs.existsSync(malloyDir)) return sources

  const files = fs.readdirSync(malloyDir).filter((f) => f.endsWith('.malloy')).sort()
  const sourceRe = /^\s*source:\s*([A-Za-z0-9_]+)\s+is\s+bigquery\.table\(\s*['"]([^'"]+)['"]\s*\)/gm

  for (const fname of files) {
    const relPath = normPath(path.join('models', 'malloy', fname))
    const text = fs.readFileSync(path.join(malloyDir, fname), 'utf8')
    let match
    while ((match = sourceRe.exec(text)) !== null) {
      const sourceName = match[1]
      const fullTable = match[2]
      const parts = fullTable.split('.')
      const canonical = parts.length >= 3 ? `${parts[1]}.${parts[2]}` : fullTable
      sources.push({
        id: `malloy:${fname.replace(/\.malloy$/, '')}.${sourceName}`,
        kind: 'malloy',
        name: sourceName,
        schema: `malloy/${fname.replace(/\.malloy$/, '')}`,
        canonicalKey: `malloy:${fname.replace(/\.malloy$/, '')}.${sourceName}`,
        fileName: relPath,
        backingCanonical: canonical,
        tags: ['malloy'],
        type: 'semantic-source',
        columns: [],
        deps: [],
      })
    }
  }
  return sources
}

function buildGraph(compiled, repoRoot) {
  const nodes = new Map() // id -> node
  const byTarget = new Map() // targetKey -> id
  const byCanonical = new Map() // canonicalKey -> id
  const byFile = new Map() // normPath(fileName) -> [id, ...]

  const register = (node) => {
    nodes.set(node.id, node)
    if (node.targetKey) byTarget.set(node.targetKey, node.id)
    if (node.canonicalKey) byCanonical.set(node.canonicalKey, node.id)
    if (node.fileName) {
      const fp = normPath(node.fileName)
      if (!byFile.has(fp)) byFile.set(fp, [])
      byFile.get(fp).push(node.id)
    }
  }

  for (const d of compiled.declarations || []) {
    const tk = targetKey(d.target)
    const ck = targetKey(d.canonicalTarget || d.target)
    register({
      id: `decl:${tk}`,
      kind: 'declaration',
      name: d.target.name,
      schema: (d.canonicalTarget || d.target).schema,
      targetKey: tk,
      canonicalKey: ck,
      fileName: normPath(d.fileName),
      type: 'declaration',
      tags: [],
      description: d.actionDescriptor?.description || '',
      columns: [],
      rawDeps: [],
      query: '',
    })
  }

  for (const t of compiled.tables || []) {
    const tk = targetKey(t.target)
    const ck = targetKey(t.canonicalTarget || t.target)
    const cols = (t.actionDescriptor?.columns || []).map((c) => ({
      name: Array.isArray(c.path) ? c.path.join('.') : String(c.path || ''),
      description: c.description || '',
    }))
    register({
      id: `table:${tk}`,
      kind: 'table',
      name: t.target.name,
      schema: (t.canonicalTarget || t.target).schema,
      targetKey: tk,
      canonicalKey: ck,
      fileName: normPath(t.fileName),
      type: t.type || 'table',
      tags: [...(t.tags || [])].sort(),
      description: t.actionDescriptor?.description || '',
      columns: cols,
      rawDeps: (t.dependencyTargets || []).map(targetKey),
      query: t.query || '',
    })
  }

  for (const a of compiled.assertions || []) {
    const tk = targetKey(a.target)
    const ck = targetKey(a.canonicalTarget || a.target)
    register({
      id: `assert:${tk}`,
      kind: 'assertion',
      name: a.target.name,
      schema: (a.canonicalTarget || a.target).schema,
      targetKey: tk,
      canonicalKey: ck,
      fileName: normPath(a.fileName),
      type: 'assertion',
      tags: [...(a.tags || [])].sort(),
      description: a.actionDescriptor?.description || '',
      columns: [],
      rawDeps: (a.dependencyTargets || []).map(targetKey),
      query: a.query || '',
    })
  }

  const malloySources = parseMalloySources(repoRoot)
  for (const m of malloySources) {
    register({
      ...m,
      targetKey: m.id,
      rawDeps: [],
      description: '',
      query: '',
    })
  }

  // Adjacency lists
  const upstream = new Map() // id -> Set<id>
  const downstream = new Map() // id -> Set<id>
  for (const id of nodes.keys()) {
    upstream.set(id, new Set())
    downstream.set(id, new Set())
  }

  const addEdge = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return
    downstream.get(fromId)?.add(toId)
    upstream.get(toId)?.add(fromId)
  }

  for (const node of nodes.values()) {
    if (node.kind === 'malloy') {
      const targetId = byCanonical.get(node.backingCanonical)
      if (targetId) addEdge(targetId, node.id)
      continue
    }
    for (const depTk of node.rawDeps || []) {
      const depId = byTarget.get(depTk) || byCanonical.get(depTk)
      if (depId) addEdge(depId, node.id)
    }
  }

  return { nodes, byTarget, byCanonical, byFile, upstream, downstream }
}

function collectTransitive(startIds, adjMap) {
  const visited = new Set()
  const queue = []
  for (const id of startIds) {
    for (const nxt of adjMap.get(id) || []) {
      if (!visited.has(nxt) && !startIds.has(nxt)) {
        visited.add(nxt)
        queue.push(nxt)
      }
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const nxt of adjMap.get(cur) || []) {
      if (!visited.has(nxt) && !startIds.has(nxt)) {
        visited.add(nxt)
        queue.push(nxt)
      }
    }
  }
  return visited
}

function computeSchemaDiff(baseGraph, headGraph, changedIds) {
  const diffs = []
  if (!baseGraph) return diffs

  for (const id of changedIds) {
    const headNode = headGraph.nodes.get(id)
    if (!headNode || headNode.kind === 'malloy' || headNode.kind === 'declaration') continue
    const baseId = baseGraph.byCanonical.get(headNode.canonicalKey)
    const baseNode = baseId ? baseGraph.nodes.get(baseId) : null

    if (!baseNode) {
      diffs.push({
        canonicalKey: headNode.canonicalKey,
        fileName: headNode.fileName,
        kind: headNode.kind,
        isNew: true,
        breaking: false,
        typeChange: null,
        addedCols: headNode.columns.map((c) => c.name),
        removedCols: [],
        addedTags: headNode.tags,
        removedTags: [],
        addedDeps: [...(headGraph.upstream.get(id) || [])].map((d) => headGraph.nodes.get(d)?.canonicalKey).filter(Boolean),
        removedDeps: [],
      })
      continue
    }

    const baseCols = new Set(baseNode.columns.map((c) => c.name))
    const headCols = new Set(headNode.columns.map((c) => c.name))
    const addedCols = [...headCols].filter((c) => !baseCols.has(c)).sort()
    const removedCols = [...baseCols].filter((c) => !headCols.has(c)).sort()

    const baseTags = new Set(baseNode.tags)
    const headTags = new Set(headNode.tags)
    const addedTags = [...headTags].filter((t) => !baseTags.has(t)).sort()
    const removedTags = [...baseTags].filter((t) => !headTags.has(t)).sort()

    const baseDeps = new Set(
      [...(baseGraph.upstream.get(baseId) || [])].map((d) => baseGraph.nodes.get(d)?.canonicalKey).filter(Boolean)
    )
    const headDeps = new Set(
      [...(headGraph.upstream.get(id) || [])].map((d) => headGraph.nodes.get(d)?.canonicalKey).filter(Boolean)
    )
    const addedDeps = [...headDeps].filter((d) => !baseDeps.has(d)).sort()
    const removedDeps = [...baseDeps].filter((d) => !headDeps.has(d)).sort()

    const typeChange = baseNode.type !== headNode.type ? `${baseNode.type} → ${headNode.type}` : null
    const hasChanges =
      Boolean(typeChange) ||
      addedCols.length > 0 ||
      removedCols.length > 0 ||
      addedTags.length > 0 ||
      removedTags.length > 0 ||
      addedDeps.length > 0 ||
      removedDeps.length > 0

    if (hasChanges) {
      diffs.push({
        canonicalKey: headNode.canonicalKey,
        fileName: headNode.fileName,
        kind: headNode.kind,
        isNew: false,
        breaking: removedCols.length > 0 || Boolean(typeChange),
        typeChange,
        addedCols,
        removedCols,
        addedTags,
        removedTags,
        addedDeps,
        removedDeps,
      })
    }
  }
  return diffs
}

function safeMermaidId(raw) {
  return 'n_' + String(raw).replace(/[^A-Za-z0-9_]/g, '_')
}

function escapeMermaidLabel(text) {
  return String(text).replace(/"/g, "'")
}

function renderMermaidDag(graph, changedIds, downstreamIds, upstreamIds, { maxNodes = 32 } = {}) {
  const included = new Set([...changedIds, ...downstreamIds, ...upstreamIds])
  if (included.size === 0) return ''

  // Prioritize changed -> downstream -> assertions -> malloy -> upstream if large
  let selected = [...included]
  let truncated = 0
  if (selected.length > maxNodes) {
    const priority = (id) => {
      const n = graph.nodes.get(id)
      if (changedIds.has(id)) return 0
      if (downstreamIds.has(id) && n?.kind === 'assertion') return 1
      if (downstreamIds.has(id) && n?.kind === 'malloy') return 2
      if (downstreamIds.has(id)) return 3
      return 4
    }
    selected.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
    truncated = selected.length - maxNodes
    selected = selected.slice(0, maxNodes)
  }
  const selectedSet = new Set(selected)

  const lines = ['flowchart LR']

  // Node declarations with shape encoding by kind
  for (const id of selected.sort()) {
    const n = graph.nodes.get(id)
    if (!n) continue
    const mid = safeMermaidId(id)
    const label = escapeMermaidLabel(
      n.kind === 'malloy'
        ? `Malloy: ${n.name}`
        : `${n.schema}.${n.name}`
    )
    let decl
    if (n.kind === 'declaration') {
      decl = `  ${mid}[("${label}")]`
    } else if (n.kind === 'assertion') {
      decl = `  ${mid}{{"${label}"}}`
    } else if (n.kind === 'malloy') {
      decl = `  ${mid}(["${label}"])`
    } else {
      decl = `  ${mid}["${label}"]`
    }
    lines.push(decl)
  }

  // Edges among selected nodes
  const edges = []
  for (const fromId of selectedSet) {
    for (const toId of graph.downstream.get(fromId) || []) {
      if (selectedSet.has(toId)) {
        const isCritical = changedIds.has(fromId) || downstreamIds.has(fromId)
        const arrow = isCritical ? '==>' : '-->'
        edges.push(`  ${safeMermaidId(fromId)} ${arrow} ${safeMermaidId(toId)}`)
      }
    }
  }
  edges.sort()
  lines.push(...edges)

  // Accessible dark/light-friendly styles
  lines.push(
    '  classDef changed fill:#f59e0b,stroke:#b45309,stroke-width:3px,color:#111827',
    '  classDef impacted fill:#ef4444,stroke:#991b1b,stroke-width:2px,color:#ffffff',
    '  classDef assertion fill:#10b981,stroke:#047857,stroke-width:2px,color:#ffffff',
    '  classDef malloy fill:#8b5cf6,stroke:#5b21b6,stroke-width:2px,color:#ffffff',
    '  classDef upstream fill:#334155,stroke:#64748b,stroke-width:1px,color:#f8fafc'
  )

  for (const id of selected) {
    const n = graph.nodes.get(id)
    const mid = safeMermaidId(id)
    if (changedIds.has(id)) {
      lines.push(`  class ${mid} changed`)
    } else if (n?.kind === 'assertion') {
      lines.push(`  class ${mid} assertion`)
    } else if (n?.kind === 'malloy') {
      lines.push(`  class ${mid} malloy`)
    } else if (downstreamIds.has(id)) {
      lines.push(`  class ${mid} impacted`)
    } else {
      lines.push(`  class ${mid} upstream`)
    }
  }

  return {
    mermaid: lines.join('\n'),
    truncated,
  }
}

function computeRisk({ changedNodes, downstreamModels, downstreamAssertions, downstreamMalloy, schemaDiffs }) {
  let score = 0
  score += Math.min(25, changedNodes.length * 8)
  score += Math.min(35, downstreamModels.length * 7)
  score += Math.min(20, downstreamMalloy.length * 6)

  const hasBreaking = schemaDiffs.some((d) => d.breaking)
  if (hasBreaking) score += 25

  const touchesExecutive = [...changedNodes, ...downstreamModels].some(
    (n) => n.schema === 'executive_reporting'
  )
  if (touchesExecutive) score += 10

  // Small risk reduction when assertions actively cover the subgraph
  if (downstreamAssertions.length > 0 && score > 15) {
    score = Math.max(10, score - 5)
  }

  score = Math.min(100, Math.max(0, score))

  let level, emoji
  if (score >= 70 || hasBreaking) {
    level = 'High'
    emoji = '🔴'
  } else if (score >= 45) {
    level = 'Elevated'
    emoji = '🟠'
  } else if (score >= 20) {
    level = 'Moderate'
    emoji = '🟡'
  } else {
    level = 'Low'
    emoji = '🟢'
  }

  const filled = Math.round(score / 10)
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
  return { score, level, emoji, bar, hasBreaking }
}

function resolveModelQuery(graph, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return null

  const normalizedPath = normPath(q)
  if (graph.byFile.has(normalizedPath)) {
    return graph.byFile.get(normalizedPath)[0]
  }

  // Exact canonicalKey or name match
  for (const node of graph.nodes.values()) {
    if (node.canonicalKey.toLowerCase() === q) return node.id
    if (node.targetKey.toLowerCase() === q) return node.id
    if (node.name.toLowerCase() === q) return node.id
    if (node.fileName.toLowerCase().endsWith(`/${q}`) || node.fileName.toLowerCase().endsWith(`/${q}.sqlx`)) {
      return node.id
    }
  }

  // Fuzzy substring match
  for (const node of graph.nodes.values()) {
    if (node.canonicalKey.toLowerCase().includes(q) || node.fileName.toLowerCase().includes(q)) {
      return node.id
    }
  }
  return null
}

function fileLink(fileName, repo, sha) {
  if (repo && sha && fileName) {
    return `[\`${fileName}\`](https://github.com/${repo}/blob/${sha}/${fileName})`
  }
  return fileName ? `\`${fileName}\`` : '—'
}

function renderBlastRadiusMarkdown({
  graph,
  changedIds,
  downstreamIds,
  upstreamIds,
  schemaDiffs,
  risk,
  repo,
  sha,
  heading = '### 🌊 Dataform Lineage & Blast-Radius Radar',
  includeLegend = true,
}) {
  const changedNodes = [...changedIds].map((id) => graph.nodes.get(id)).filter(Boolean)
  const downstreamNodes = [...downstreamIds].map((id) => graph.nodes.get(id)).filter(Boolean)
  const downstreamModels = downstreamNodes.filter((n) => n.kind === 'table')
  const downstreamAssertions = downstreamNodes.filter((n) => n.kind === 'assertion')
  const downstreamMalloy = downstreamNodes.filter((n) => n.kind === 'malloy')

  const lines = [heading, '']

  if (changedNodes.length === 0) {
    lines.push(
      '> [!NOTE]',
      '> No Dataform `.sqlx` models or Malloy `.malloy` sources were modified in this PR — warehouse lineage blast radius is **0**.',
      ''
    )
    return lines.join('\n')
  }

  if (risk.hasBreaking) {
    lines.push(
      '> [!CAUTION]',
      '> **Breaking Schema / Materialization Change Detected!** A modified model removed documented columns or changed its materialization type (`view` ↔ `table`). Review downstream models and Malloy consumers before merging.',
      ''
    )
  } else if (risk.level === 'High' || risk.level === 'Elevated') {
    lines.push(
      '> [!WARNING]',
      `> **${risk.level} Blast Radius (${risk.score}/100):** Changes ripple into **${downstreamModels.length}** downstream model(s), **${downstreamMalloy.length}** Malloy semantic source(s), and **${downstreamAssertions.length}** Dataform assertion(s).`,
      ''
    )
  }

  lines.push(
    '| Dimension | Metric | Details |',
    '| :--- | :---: | :--- |',
    `| **Blast-Radius Risk** | ${risk.emoji} **${risk.level}** | \`${risk.bar}\` **${risk.score}/100** |`,
    `| **Directly Changed Nodes** | **${changedNodes.length}** | ${changedNodes.slice(0, 6).map((n) => `\`${n.canonicalKey}\``).join(', ')}${changedNodes.length > 6 ? ` +${changedNodes.length - 6} more` : ''} |`,
    `| **Downstream Models** | **${downstreamModels.length}** | ${downstreamModels.length ? downstreamModels.slice(0, 6).map((n) => `\`${n.canonicalKey}\``).join(', ') + (downstreamModels.length > 6 ? ` +${downstreamModels.length - 6} more` : '') : 'None (leaf node)'} |`,
    `| **Malloy Semantic Impact** | **${downstreamMalloy.length}** | ${downstreamMalloy.length ? downstreamMalloy.map((n) => `\`${n.name}\``).join(', ') : 'No Malloy sources impacted'} |`,
    `| **Covering Assertions** | **${downstreamAssertions.length}** | ${downstreamAssertions.length ? downstreamAssertions.map((n) => `\`${n.name}\``).join(', ') : 'None directly downstream'} |`,
    ''
  )

  const dag = renderMermaidDag(graph, changedIds, downstreamIds, upstreamIds)
  if (dag && dag.mermaid) {
    lines.push('```mermaid', dag.mermaid, '```', '')
    if (includeLegend) {
      lines.push(
        '<sub>**Legend:** 🟨 Directly Changed · 🟥 Downstream Model · 🟩 Dataform Assertion · 🟪 Malloy Semantic Source · ⬛ Direct Upstream Input' +
          (dag.truncated > 0 ? ` · *(+${dag.truncated} additional nodes truncated for readability)*` : '') +
          '</sub>',
        ''
      )
    }
  }

  if (schemaDiffs.length > 0) {
    lines.push(
      '#### 📐 Schema & Config Contract Diff (`base` → `head`)',
      '',
      '| Model | Type | Columns Diff | Tags / Deps Diff |',
      '| :--- | :--- | :--- | :--- |'
    )
    for (const d of schemaDiffs) {
      const colParts = []
      if (d.isNew) {
        colParts.push(`🆕 New model (${d.addedCols.length} cols)`)
      } else {
        if (d.addedCols.length) colParts.push(`➕ ${d.addedCols.map((c) => `\`${c}\``).join(', ')}`)
        if (d.removedCols.length) colParts.push(`➖ **${d.removedCols.map((c) => `\`${c}\``).join(', ')}**`)
        if (!colParts.length) colParts.push('Unchanged')
      }
      const metaParts = []
      if (d.addedTags.length) metaParts.push(`+tags: ${d.addedTags.map((t) => `\`${t}\``).join(', ')}`)
      if (d.removedTags.length) metaParts.push(`-tags: ${d.removedTags.map((t) => `\`${t}\``).join(', ')}`)
      if (d.addedDeps.length) metaParts.push(`+deps: ${d.addedDeps.map((x) => `\`${x}\``).join(', ')}`)
      if (d.removedDeps.length) metaParts.push(`-deps: ${d.removedDeps.map((x) => `\`${x}\``).join(', ')}`)

      lines.push(
        `| ${fileLink(d.fileName, repo, sha)} | ${d.typeChange ? `⚠️ \`${d.typeChange}\`` : '`unchanged`'} | ${colParts.join('<br>')} | ${metaParts.join('<br>') || '—'} |`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

function renderCompileInspectMarkdown(graph, query, { repo, sha } = {}) {
  const nodeId = resolveModelQuery(graph, query)
  if (!nodeId) {
    const sampleModels = [...graph.nodes.values()]
      .filter((n) => n.kind === 'table' || n.kind === 'assertion')
      .map((n) => `\`${n.canonicalKey}\``)
      .sort()
      .slice(0, 12)
    return [
      `> [!WARNING]`,
      `> Could not find a Dataform model or assertion matching \`${query}\`.`,
      ``,
      `Try one of: ${sampleModels.join(', ')}`,
    ].join('\n')
  }

  const node = graph.nodes.get(nodeId)
  const focusSet = new Set([nodeId])
  const downstreamIds = collectTransitive(focusSet, graph.downstream)
  const upstreamIds = new Set(graph.upstream.get(nodeId) || [])
  const dag = renderMermaidDag(graph, focusSet, downstreamIds, upstreamIds, { maxNodes: 24 })

  const downstreamModels = [...downstreamIds].map((id) => graph.nodes.get(id)).filter((n) => n?.kind === 'table')
  const downstreamMalloy = [...downstreamIds].map((id) => graph.nodes.get(id)).filter((n) => n?.kind === 'malloy')
  const downstreamAssertions = [...downstreamIds].map((id) => graph.nodes.get(id)).filter((n) => n?.kind === 'assertion')

  const lines = [
    `### 🔬 Compiled Dataform Inspector — \`${node.canonicalKey}\``,
    '',
    '| Property | Value |',
    '| :--- | :--- |',
    `| **Source File** | ${fileLink(node.fileName, repo, sha)} |`,
    `| **Target Relation** | \`monorail-sample.${node.targetKey}\` (\`${node.type}\`) |`,
    `| **Tags** | ${node.tags.length ? node.tags.map((t) => `\`${t}\``).join(', ') : '—'} |`,
    `| **Direct Upstreams** | ${upstreamIds.size ? [...upstreamIds].map((id) => `\`${graph.nodes.get(id)?.canonicalKey}\``).join(', ') : 'None'} |`,
    `| **Transitive Downstreams** | **${downstreamModels.length}** model(s) · **${downstreamMalloy.length}** Malloy source(s) · **${downstreamAssertions.length}** assertion(s) |`,
    '',
  ]

  if (node.description) {
    lines.push(`> ${node.description}`, '')
  }

  if (dag && dag.mermaid) {
    lines.push('```mermaid', dag.mermaid, '```', '')
  }

  if (node.columns.length > 0) {
    lines.push(
      `<details><summary>📋 Documented Schema Contract (${node.columns.length} columns)</summary>`,
      '',
      '| Column | Description |',
      '| :--- | :--- |'
    )
    for (const c of node.columns) {
      lines.push(`| \`${c.name}\` | ${(c.description || '—').replace(/\|/g, '\\|')} |`)
    }
    lines.push('', '</details>', '')
  }

  if (node.query) {
    const trimmedSql = node.query.trim()
    const cappedSql =
      trimmedSql.length > 18000
        ? trimmedSql.slice(0, 18000) + '\n-- ... truncated to fit GitHub comment limits ...'
        : trimmedSql
    lines.push(
      '<details open><summary>🧮 Compiled BigQuery SQL (<code>${ref(...)}</code> resolved)</summary>',
      '',
      '```sql',
      cappedSql,
      '```',
      '',
      '</details>',
      ''
    )
  }

  return lines.join('\n')
}

function parseArgs(argv) {
  const args = {
    head: '',
    base: '',
    changedFiles: '',
    files: [],
    inspect: '',
    mode: 'card',
    repo: '',
    sha: '',
    repoRoot: process.cwd(),
    mdOut: '',
    jsonOut: '',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--head') args.head = argv[++i]
    else if (a === '--base') args.base = argv[++i]
    else if (a === '--changed-files') args.changedFiles = argv[++i]
    else if (a === '--files') args.files.push(...String(argv[++i] || '').split(',').filter(Boolean))
    else if (a === '--inspect') args.inspect = argv[++i]
    else if (a === '--mode') args.mode = argv[++i]
    else if (a === '--repo') args.repo = argv[++i]
    else if (a === '--sha') args.sha = argv[++i]
    else if (a === '--repo-root') args.repoRoot = argv[++i]
    else if (a === '--md-out') args.mdOut = argv[++i]
    else if (a === '--json-out') args.jsonOut = argv[++i]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.head) {
    console.error('Usage: node scripts/pr-blast-radius.cjs --head <compiled.json> [--base <base.json>] [--changed-files <file>] [--inspect <model>] [--mode card|lineage|compile]')
    process.exit(2)
  }

  const headCompiled = readJsonFile(args.head)
  const headGraph = buildGraph(headCompiled, args.repoRoot)
  const baseGraph = args.base && fs.existsSync(args.base)
    ? buildGraph(readJsonFile(args.base), args.repoRoot)
    : null

  if (args.mode === 'compile' && args.inspect) {
    const md = renderCompileInspectMarkdown(headGraph, args.inspect, { repo: args.repo, sha: args.sha })
    if (args.mdOut) fs.writeFileSync(args.mdOut, md, 'utf8')
    else process.stdout.write(md + '\n')
    return
  }

  // Determine focus nodes (either --inspect target or changed files)
  const changedIds = new Set()
  if (args.inspect) {
    const resolved = resolveModelQuery(headGraph, args.inspect)
    if (resolved) changedIds.add(resolved)
  } else {
    const fileList = [...args.files]
    if (args.changedFiles && fs.existsSync(args.changedFiles)) {
      fileList.push(
        ...fs.readFileSync(args.changedFiles, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      )
    }
    for (const rawFile of fileList) {
      const fp = normPath(rawFile)
      for (const id of headGraph.byFile.get(fp) || []) {
        changedIds.add(id)
      }
    }
  }

  const downstreamIds = collectTransitive(changedIds, headGraph.downstream)
  const upstreamIds = new Set()
  for (const id of changedIds) {
    for (const up of headGraph.upstream.get(id) || []) {
      if (!changedIds.has(up) && !downstreamIds.has(up)) {
        upstreamIds.add(up)
      }
    }
  }

  const schemaDiffs = computeSchemaDiff(baseGraph, headGraph, changedIds)
  const changedNodes = [...changedIds].map((id) => headGraph.nodes.get(id)).filter(Boolean)
  const downstreamNodes = [...downstreamIds].map((id) => headGraph.nodes.get(id)).filter(Boolean)
  const downstreamModels = downstreamNodes.filter((n) => n.kind === 'table')
  const downstreamAssertions = downstreamNodes.filter((n) => n.kind === 'assertion')
  const downstreamMalloy = downstreamNodes.filter((n) => n.kind === 'malloy')

  const risk = computeRisk({
    changedNodes,
    downstreamModels,
    downstreamAssertions,
    downstreamMalloy,
    schemaDiffs,
  })

  const heading =
    args.inspect
      ? `### 🌊 Lineage & Blast Radius for \`${changedNodes[0]?.canonicalKey || args.inspect}\``
      : '### 🌊 Dataform Lineage & Blast-Radius Radar'

  const md = renderBlastRadiusMarkdown({
    graph: headGraph,
    changedIds,
    downstreamIds,
    upstreamIds,
    schemaDiffs,
    risk,
    repo: args.repo,
    sha: args.sha,
    heading,
  })

  if (args.jsonOut) {
    const summary = {
      risk,
      changedCount: changedNodes.length,
      downstreamModelCount: downstreamModels.length,
      downstreamAssertionCount: downstreamAssertions.length,
      downstreamMalloyCount: downstreamMalloy.length,
      breakingSchemaChange: risk.hasBreaking,
      schemaDiffCount: schemaDiffs.length,
      changedModels: changedNodes.map((n) => n.canonicalKey),
      downstreamModels: downstreamModels.map((n) => n.canonicalKey),
      downstreamMalloy: downstreamMalloy.map((n) => n.name),
      downstreamAssertions: downstreamAssertions.map((n) => n.name),
    }
    fs.writeFileSync(args.jsonOut, JSON.stringify(summary, null, 2), 'utf8')
  }

  if (args.mdOut) fs.writeFileSync(args.mdOut, md, 'utf8')
  else process.stdout.write(md + '\n')
}

if (require.main === module) {
  main()
}

module.exports = {
  buildGraph,
  collectTransitive,
  computeSchemaDiff,
  computeRisk,
  renderMermaidDag,
  renderBlastRadiusMarkdown,
  renderCompileInspectMarkdown,
  resolveModelQuery,
}
