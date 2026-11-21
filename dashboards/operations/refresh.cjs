const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { Runtime } = require('@malloydata/malloy')
const { BigQueryConnection } = require('@malloydata/db-bigquery')
const { OAuth2Client } = require('google-auth-library')

const exec = promisify(execFile)
const modelsRoot = path.resolve(__dirname, '..', '..', 'models', 'malloy')
const project = 'monorail-sample'
const model = 'enterprise.malloy'
const scheduleModel = 'cta.malloy'
const rowLimit = 1000
const maxBytes = 1024 ** 3
const queries = {
  headcount_by_department: 'headcount_by_department',
  workforce_cost_by_department: 'workforce_cost_by_department',
  service_reliability_by_route: 'service_reliability_by_route',
  fleet_risk_by_owner: 'fleet_risk_by_owner',
  budget_by_department: 'budget_by_department',
  vendor_approval_pipeline: 'vendor_approval_pipeline',
  executive_department_review: 'executive_department_review',
  route_cost_review: 'route_cost_review',
  integrity_and_risk_checks: 'integrity_and_risk_checks',
  route_daily: `service_reliability -> {
    group_by: service_date, route_id, route_long_name
    aggregate: trips_completed, trips_cancelled, trips_on_time,
      trips_scheduled is scheduled_trips.sum(), delay_total is delay_minutes.sum()
    order_by: service_date asc, route_id asc
  }`,
  fleet_detail: `fleet_readiness -> {
    group_by: vehicle_id, vehicle_type, department_name is vehicle_owner.department_name
    aggregate: open_orders, critical_orders, open_parts_cost
    order_by: critical_orders desc, open_orders desc, vehicle_id asc
  }`,
  workforce_daily: `workforce -> {
    group_by: work_date is service_date, department_name is department.department_name
    aggregate: total_productive_hours, total_scheduled_hours, total_absence_hours,
      total_overtime_hours, total_labor_cost
    order_by: work_date asc, department_name asc
  }`,
  budget_by_month: `financial_control -> {
    group_by: report_month, department_name, budget_status
    aggregate: budget_total, actual_cost_total, remaining_budget_total, pending_approval_total
    order_by: report_month asc, remaining_budget_total asc
  }`,
  vendor_by_month: `vendor_spend -> {
    group_by: report_month, supplier_name, category
    aggregate: approved_spend, pending_spend, invoices
    order_by: report_month asc, pending_spend desc
  }`,
  risk_detail: `organization_quality -> {
    group_by: check_name, asset, check_kind, status, failed_rows, tested_rows
    order_by: failed_rows desc, check_name asc
  }`,
}

function toJson(value) {
  if (typeof value === 'bigint') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toJson)
  if (value && typeof value === 'object') {
    if (typeof value.toISOString === 'function') return value.toISOString()
    if (typeof value.value === 'string' && Object.keys(value).length === 1) return value.value
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, toJson(field)]))
  }
  return value
}

async function main() {
  for (const modelName of [model, scheduleModel]) {
    const sourceText = await fs.readFile(path.join(modelsRoot, modelName), 'utf8')
    const sources = [...sourceText.matchAll(/bigquery\.table\(['"]([^'"]+)['"]\)/g)]
    if (!sources.length || sources.some(([, table]) => !table.startsWith(`${project}.`))) {
      throw new Error(`${modelName} must reference the ${project} project.`)
    }
  }

  const [command, args] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', 'gcloud.cmd auth print-access-token --quiet']]
    : ['gcloud', ['auth', 'print-access-token', '--quiet']]
  const { stdout } = await exec(command, args, {
    windowsHide: true,
    timeout: 60_000,
  }).catch(() => { throw new Error('The existing Google Cloud CLI sign-in could not issue a token.') })
  const authClient = new OAuth2Client()
  authClient.setCredentials({ access_token: stdout.trim().split(/\r?\n/).at(-1) })
  const connection = new BigQueryConnection({
    name: 'bigquery',
    projectId: project,
    billingProjectId: project,
    location: 'US',
    maximumBytesBilled: String(maxBytes),
    authClient,
  })
  const modelFiles = [model, scheduleModel].map((name) => path.join(modelsRoot, name))
  const runtime = new Runtime({
    connection,
    urlReader: {
      readURL(url) {
        const file = fileURLToPath(url)
        if (!modelFiles.includes(file)) throw new Error('Only the checked-in dashboard models may be read.')
        return fs.readFile(file, 'utf8')
      },
    },
  })
  const loadedModels = new Map(modelFiles.map((file) => [path.basename(file), runtime.loadModel(pathToFileURL(file))]))
  const data = {}
  const queryInfo = {}
  const queue = Object.entries(queries)

  async function capture(name, expression, modelName) {
    const query = `run: ${expression}`
    const prepared = loadedModels.get(modelName).loadQuery(query)
    const sql = await prepared.getSQL()
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error(`${name}: expected a read-only query.`)
    const scanBytes = Number((await connection.estimateQueryCost(sql)).queryCostBytes)
    if (!Number.isFinite(scanBytes) || scanBytes > maxBytes) {
      throw new Error(`${name}: could not verify the query is within the 1 GiB scan limit.`)
    }
    const result = await prepared.run({ rowLimit })
    const rows = result.data.toObject().map(toJson)
    if ((result.totalRows ?? rows.length) > rows.length) throw new Error(`${name}: result was truncated.`)
    data[name] = rows
    queryInfo[name] = { model: modelName, query, rows: rows.length, scanBytes }
    console.log(`${name}: ${rows.length} rows`)
  }

  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [name, expression] = next
      await capture(name, expression, model)
    }
  }

  const workers = await Promise.allSettled([worker(), worker()])
  const failures = workers.filter((result) => result.status === 'rejected')
  if (failures.length) throw new Error(failures.map((result) => result.reason.message).join('\n'))
  const days = [...new Set(data.route_daily.map((row) => String(row.service_date).slice(0, 10)))].sort()
  const routeIds = [...new Set(data.route_daily.map((row) => String(row.route_id)))].sort()
  if (!days.length || days.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day)) || routeIds.some((id) => !id)) {
    throw new Error('The operations model did not return valid service dates and route IDs.')
  }
  const routeFilter = routeIds.map((id) => `route_id = ${JSON.stringify(id)}`).join(' or ')
  await capture('cta_schedule_reference', `scheduled_service -> {
    where: service_date >= @${days[0]}, service_date <= @${days.at(-1)}
    where: ${routeFilter}
    group_by: service_date, route_id
    aggregate: total_scheduled_trips
    order_by: service_date asc, route_id asc
  }`, scheduleModel)

  const orderedEntries = [...Object.keys(queries), 'cta_schedule_reference']
  const snapshot = { project, models: [model, scheduleModel], exportedAt: new Date().toISOString(),
    data: Object.fromEntries(orderedEntries.map((name) => [name, data[name]])),
    queryInfo: Object.fromEntries(orderedEntries.map((name) => [name, queryInfo[name]])) }
  const destination = path.join(__dirname, 'snapshot.json')
  const staging = `${destination}.${process.pid}.tmp`
  await fs.writeFile(staging, `${JSON.stringify(snapshot, null, 2)}\n`)
  await fs.rename(staging, destination)
}

main().catch((error) => {
  console.error(error.message.replace(/ya29\.[\w.-]+|Bearer\s+\S+/gi, '[redacted]'))
  process.exitCode = 1
})
