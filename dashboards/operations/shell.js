(() => {
  const { data, queryInfo, project, models, exportedAt } = window.sampleSnapshot
  const root = document.getElementById('workspace')
  const nav = document.querySelector('.desk-nav')
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
  const count = new Intl.NumberFormat('en-US')
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', trailingZeroDisplay: 'stripIfInteger' })
  const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 })
  const calendar = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const calendarYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const localCalendar = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' })
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const day = (date) => calendar.format(new Date(date))
  const rows = (query) => data[query] || []
  const sum = (list, field) => list.reduce((total, row) => total + Number(row[field] ?? 0), 0)
  const service = rows('service_reliability_by_route')
  const staff = rows('headcount_by_department')
  const budget = rows('budget_by_department')
  const checks = rows('risk_detail')
  const routeDays = rows('route_daily')
  const schedule = rows('cta_schedule_reference')
  const routeDayKey = (row) => JSON.stringify([row.service_date, row.route_id])
  const plannedByRouteDay = new Map(schedule.map((row) => [routeDayKey(row), Number(row.total_scheduled_trips)]))
  const reconciledDays = routeDays.filter((row) => plannedByRouteDay.get(routeDayKey(row)) === Number(row.trips_scheduled)).length
  const scheduleMatches = schedule.length > 0 && plannedByRouteDay.size === routeDays.length && reconciledDays === routeDays.length
  const dates = [...new Set(routeDays.map((row) => row.service_date))].sort()
  const workforceDates = new Set(rows('workforce_daily').map((row) => row.work_date))
  const servicePeriod = dates.length ? calendarYear.formatRange(new Date(dates[0]), new Date(dates.at(-1))) : 'Service period unavailable'

  const navItems = [
    ['briefing', 'Shift briefing', '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V2h6v2m-6 5h6m-6 4h6m-6 4h4"/>'],
    ['operations', 'Dispatch & Fleet', '<path d="M3 12h4l3-7 4 14 3-7h4"/>'],
    ['workforce', 'Workforce', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>'],
    ['finance', 'Financial Control', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18m-14 6h4m3 0h2"/>'],
    ['sources', 'Data & Queries', '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14a8 3 0 0 0 16 0V5m-16 7a8 3 0 0 0 16 0"/>'],
  ]

  nav.innerHTML = navItems.map(([key, label, icon]) => `
    <a href="#${key}" ${key === 'sources' ? 'class="sources-link"' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>
      ${escape(label)}
    </a>
  `).join('')

  function kpi(label, value, note, state = '') {
    return `<div class="kpi"><div class="label">${label}</div><div class="value ${state}">${value}</div><small>${note}</small></div>`
  }

  function review(key, title, detail, severity) {
    return `<li class="review-item"><a href="#${escape(key)}">
      <span class="review-dot ${severity}" aria-hidden="true"></span>
      <div><strong>${escape(title)}</strong><p>${escape(detail)}</p></div>
      <span class="review-arrow" aria-hidden="true">↗</span>
    </a></li>`
  }

  function cancellationsChart() {
    if (!dates.length) return ''
    const series = dates.map((date) => [date, sum(routeDays.filter((row) => row.service_date === date), 'trips_cancelled')])
    const peak = Math.max(...series.map(([, value]) => value))
    const label = series.map(([date, value]) => `${day(date)}: ${count.format(value)}`).join(', ')
    return `<figure class="mini-chart">
      <figcaption>Daily trip cancellations</figcaption>
      <div class="chart-columns" role="img" aria-label="${escape(label)}" style="--points:${series.length}">
        ${series.map(([date, value]) => `<span class="chart-bar" style="--height:${100 * value / (peak || 1)}%" ${value === peak ? 'data-peak' : ''} title="${escape(`${day(date)} · ${count.format(value)} cancellations`)}"></span>`).join('')}
      </div>
      <div class="chart-dates"><span>${day(dates[0])}</span><span>Peak ${count.format(peak)}</span><span>${day(dates.at(-1))}</span></div>
    </figure>`
  }

  function briefing() {
    const completed = sum(service, 'trips_completed')
    const critical = rows('fleet_detail').filter((row) => Number(row.critical_orders) > 0)
    const over = budget.filter((row) => Number(row.remaining_budget_total) < 0)
    const pending = sum(budget, 'pending_approval_total')
    const lowest = service.filter((row) => Number(row.trips_completed) > 0).sort((a, b) =>
      a.trips_on_time / a.trips_completed - b.trips_on_time / b.trips_completed)[0]
    const highOvertime = [...rows('workforce_cost_by_department')].sort((a, b) => b.total_overtime_hours - a.total_overtime_hours)[0]
    const directory = [...staff].sort((a, b) => a.department_name.localeCompare(b.department_name))
    root.innerHTML = `<div class="briefing">
      <section class="briefing-hero" aria-labelledby="briefing-title">
        <div class="desk-heading">
          <h1 id="briefing-title">Shift briefing</h1>
          <p>Chicago · ${escape(servicePeriod)}</p>
        </div>
        ${cancellationsChart()}
      </section>
      <section class="kpi-grid briefing-kpis" aria-label="Enterprise at a glance">
        ${kpi('Completed trips', count.format(completed), scheduleMatches ?
          `${count.format(sum(schedule, 'total_scheduled_trips'))} scheduled · ${count.format(sum(service, 'trips_cancelled'))} cancelled` :
          `${count.format(sum(service, 'trips_cancelled'))} cancellations across ${service.length} routes`)}
        ${kpi('On-time rate', completed ? percent.format(sum(service, 'trips_on_time') / completed) : '—', 'Share of completed trips')}
        ${kpi('Active staff', count.format(sum(staff, 'headcount')), `${staff.length} departments · ${workforceDates.size} days of time entries`)}
        ${kpi('Pending invoice approvals', money.format(pending), 'November reporting period')}
      </section>
      <div class="review-grid">
        <section class="panel" aria-labelledby="review-title">
          <h2 id="review-title" class="panel-title">Items for review</h2>
          <ul class="review-list">
            ${critical.map((row) => review('operations?focus=fleet-queue', `${row.vehicle_id} has critical work open`, `${row.department_name} owns this ${row.vehicle_type.toLowerCase()}. ${count.format(row.critical_orders)} critical ${Number(row.critical_orders) === 1 ? 'order' : 'orders'} open.`, 'critical')).join('')}
            ${over.map((row) => review('finance?focus=department-ledger', `${row.department_name} is over budget`, `${money.format(Math.abs(row.remaining_budget_total))} over its November allocation on partial actuals. ${money.format(row.pending_approval_total)} also awaiting invoice approval.`, 'critical')).join('')}
            ${lowest ? review(`operations?focus=daily-service&route=${encodeURIComponent(lowest.route_id)}`, `${lowest.route_id} ${lowest.route_long_name} had the lowest on-time rate`, `${percent.format(lowest.trips_on_time / lowest.trips_completed)} of ${count.format(lowest.trips_completed)} completed trips ran on time.`, 'service') : ''}
            ${highOvertime && Number(highOvertime.total_overtime_hours) > 0 ? review(`workforce?department=${encodeURIComponent(highOvertime.department_name)}`, `${highOvertime.department_name} logged the most overtime`, `${count.format(highOvertime.total_overtime_hours)} hours across the loaded time-entry days.`, 'staffing') : ''}
          </ul>
        </section>
        <section class="panel" aria-labelledby="directory-title">
          <h2 id="directory-title" class="panel-title">Department leads</h2>
          <ul class="directory">${directory.map((row) => `<li><strong>${escape(row.department_name)}</strong><span class="manager">${escape(row.manager_name)}</span></li>`).join('')}</ul>
        </section>
      </div>
    </div>`
  }

  function sources() {
    const budgetMonths = [...new Set(rows('budget_by_month').map((row) => row.report_month))].sort()
    const latestBudget = budgetMonths.at(-1)
    const budgetCoverage = latestBudget ? `${month.format(new Date(latestBudget))} is budget-only in this snapshot.` : ''
    const exported = localCalendar.format(new Date(exportedAt))
    root.innerHTML = `<div class="sources">
      <header class="desk-heading"><h1>Data &amp; Queries</h1><p>Coverage, check outcomes and the Malloy expressions behind the dashboards.</p></header>
      <section class="panel" aria-labelledby="cover-title">
        <h2 id="cover-title" class="panel-title">Snapshot coverage</h2>
        <p>Exported ${escape(exported)} from BigQuery project <strong>${escape(project)}</strong> using MonoRail’s installed ${models.map((name) => `<code>${escape(name)}</code>`).join(' and ')} models.</p>
        <p>Service covers ${escape(servicePeriod)}. Workforce time entries cover ${workforceDates.size} business days. November financial actuals cover a partial period. ${escape(budgetCoverage)}</p>
        <p>The enterprise, its staff, delivered service and financial amounts are fictional. The six route IDs and GTFS schedules come from CTA reference data.</p>
        ${schedule.length ? `<p>${count.format(reconciledDays)} of ${count.format(routeDays.length)} route-days match the planned trip count in <code>cta.malloy</code>. The reference query returned ${count.format(sum(schedule, 'total_scheduled_trips'))} scheduled trips.</p>` : ''}
      </section>
      <section class="panel" aria-labelledby="checks-title">
        <h2 id="checks-title" class="panel-title">Integrity and business risk checks</h2>
        <div class="checks-wrap"><table class="checks-table"><thead><tr><th scope="col">Check</th><th scope="col">Kind</th><th scope="col">Outcome</th><th scope="col">Rows flagged</th></tr></thead>
        <tbody>${checks.map((row) => `<tr><td><code>${escape(row.check_name)}</code></td><td>${row.check_kind === 'DemonstrationRisk' ? 'Seeded business risk' : escape(row.check_kind)}</td><td class="${Number(row.failed_rows) ? 'flag' : 'pass'}">${escape(row.status)}</td><td>${count.format(row.failed_rows)} / ${count.format(row.tested_rows)}</td></tr>`).join('')}</tbody>
        </table></div>
      </section>
      <section class="panel" aria-labelledby="query-title">
        <h2 id="query-title" class="panel-title">Malloy expressions</h2>
        <div class="source-list">${Object.entries(queryInfo).map(([name, info]) => `<details><summary><code>${escape(name)}</code> <span>· ${escape(info.model)} · ${count.format(info.rows)} rows</span></summary><pre><code>${escape(info.query)}</code></pre></details>`).join('')}</div>
      </section>
    </div>`
  }

  function render() {
    const [key, search] = location.hash.slice(1).split('?')
    const context = new URLSearchParams(search)
    const [active, title] = navItems.find(([id]) => id === key) || navItems[0]
    document.title = `${title} · MonoRail Operations`
    document.getElementById('current-desk').textContent = title
    document.getElementById('coverage').textContent = `Sample data · Exported ${localCalendar.format(new Date(exportedAt))}`
    for (const link of nav.querySelectorAll('a')) {
      if (link.hash === `#${active}`) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    root.replaceChildren()
    root.dataset.dashboard = active
    if (active === 'briefing') briefing()
    else if (active === 'sources') sources()
    else window.sampleDashboards[active](root, data, context)
    const sectionId = context.get('focus')
    const section = sectionId ? document.getElementById(sectionId) : null
    return root.contains(section) ? section : root
  }

  document.querySelector('.skip-link').addEventListener('click', (event) => {
    event.preventDefault()
    root.focus()
    root.scrollIntoView()
  })
  window.addEventListener('hashchange', () => {
    const destination = render()
    if (destination === root) window.scrollTo(0, 0)
    else destination.scrollIntoView({ block: 'start' })
    destination.focus({ preventScroll: true })
  })
  const initialDestination = render()
  if (initialDestination !== root) initialDestination.scrollIntoView({ block: 'start' })
})()
