const assert = require('node:assert/strict')
const fs = require('node:fs')

const graph = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''))
const sources = graph.declarations ?? []
const models = graph.tables ?? []
const assertions = graph.assertions ?? []
const outputs = [...models, ...assertions]

assert.equal(graph.graphErrors?.compilationErrors?.length ?? 0, 0, 'Dataform reported compilation errors')
assert.ok(sources.length && models.length && assertions.length, 'The graph is missing a source, model, or assertion')
assert.ok(!graph.operations?.length, 'This workflow is limited to Dataform models and assertions')

for (const { target } of sources) {
  assert.equal(target.database, 'monorail-sample')
  assert.ok(!target.schema.endsWith('_company_dev'), `Source points at a development dataset: ${target.schema}.${target.name}`)
}
for (const { target } of outputs) {
  assert.equal(target.database, 'monorail-sample')
  assert.ok(target.schema.endsWith('_company_dev'), `Output points outside a development dataset: ${target.schema}.${target.name}`)
}

console.log(`Compiled ${sources.length} declarations, ${models.length} models, and ${assertions.length} assertions.`)
