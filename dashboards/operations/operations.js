(function () {
  'use strict';

  const numberFormat = new Intl.NumberFormat('en-US');
  const rateFormat = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const costFormat = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  });
  const perTripCostFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const dateFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const fullDateFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const serviceFields = ['trips_completed', 'trips_cancelled', 'trips_on_time'];
  const fleetFields = ['open_orders', 'critical_orders', 'open_parts_cost'];
  const missing = '—';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function numeric(value) {
    const raw = value?.value ?? value;
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function format(value, formatter = numberFormat) {
    const parsed = numeric(value);
    return parsed === null ? missing : formatter.format(parsed);
  }

  function label(value) {
    return String(value?.value ?? value ?? '').trim();
  }

  function dateKey(value) {
    const raw = value?.value ?? value;
    if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.toISOString().slice(0, 10) : '';
    const key = typeof raw === 'string' ? raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0] : '';
    return key && Number.isFinite(Date.parse(key)) ? key : '';
  }

  function dateLabel(key, formatter = dateFormat) {
    return formatter.format(new Date(`${key}T00:00:00Z`));
  }

  function loadedWindow(dates) {
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (!first) return 'Service dates unavailable';
    if (first === last) return dateLabel(first, fullDateFormat);
    const startFormat = first.slice(0, 4) === last.slice(0, 4) ? dateFormat : fullDateFormat;
    return `${dateLabel(first, startFormat)} – ${dateLabel(last, fullDateFormat)}`;
  }

  function rows(data, key) {
    return Array.isArray(data?.[key]) ? data[key].filter(row => row && typeof row === 'object') : [];
  }

  function totals(input, fields) {
    return Object.fromEntries(fields.map(field => {
      let total = null;
      for (const row of input) {
        const value = numeric(row[field]);
        if (value !== null) total = (total ?? 0) + value;
      }
      return [field, total];
    }));
  }

  function groupBy(input, keyFor) {
    const groups = new Map();
    for (const row of input) {
      const key = keyFor(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return groups;
  }

  function ratio(numerator, denominator) {
    const n = numeric(numerator);
    const d = numeric(denominator);
    return n !== null && d > 0 ? n / d : null;
  }

  function byDescending(left, right, field) {
    return (numeric(right[field]) ?? -Infinity) - (numeric(left[field]) ?? -Infinity);
  }

  function routeSummaries(service, daily) {
    return Array.from(groupBy(service.length ? service : daily, row => label(row.route_id)), ([id, group]) => ({
      id,
      name: group.map(row => label(row.route_long_name)).find(Boolean) || '',
      owners: [...new Set(group.map(row => label(row.department_name)).filter(Boolean))].sort(),
      ...totals(group, serviceFields),
    })).sort((left, right) => byDescending(left, right, 'trips_cancelled') ||
      (ratio(left.trips_on_time, left.trips_completed) ?? Infinity) -
      (ratio(right.trips_on_time, right.trips_completed) ?? Infinity) || routeOrder(left, right));
  }

  function routeOrder(left, right) {
    return left.id.localeCompare(right.id, 'en-US', { numeric: true });
  }

  function kpi(title, value, detail, attention = false) {
    return `<div class="kpi ops-kpi${attention ? ' ops-kpi-attention' : ''}">
      <dt>${title}</dt><dd class="ops-kpi-value">${value}</dd><dd class="ops-kpi-detail">${detail}</dd>
    </div>`;
  }

  function routeTable(routes, costByRoute, dailyByRoute) {
    if (!routes.length) return '<p class="ops-empty">No route service results are available.</p>';
    const rates = routes.map(route => ratio(route.trips_on_time, route.trips_completed)).filter(rate => rate !== null);
    const lowestRate = Math.min(...rates);
    const hasRateDifference = Math.max(...rates) > lowestRate;
    return `<div class="ops-table-wrap" role="region" aria-label="Service exceptions" tabindex="0">
      <table class="ops-table">
        <thead><tr><th scope="col">Route</th><th scope="col" aria-sort="descending">Cancelled</th>
          <th scope="col">Completed</th><th scope="col">On time</th><th scope="col">Cost / trip</th></tr></thead>
        <tbody>${routes.map(route => {
          const id = escapeHtml(route.id);
          const name = escapeHtml(route.name);
          const routeMark = dailyByRoute.has(route.id) && id
            ? `<button class="ops-route-tag ops-route-button" data-route="${id}" type="button"
                aria-label="Show daily service for route ${id}" aria-pressed="false">${id}</button>`
            : `<span class="ops-route-tag">${id || missing}</span>`;
          const cost = costByRoute.get(route.id);
          const rate = ratio(route.trips_on_time, route.trips_completed);
          const isLowest = hasRateDifference && rate === lowestRate;
          return `<tr><th scope="row"><div class="ops-route-cell">${routeMark}
            <div>${name || (id ? '' : 'Unspecified route')}
              ${route.owners.length ? `<small>${escapeHtml(route.owners.join(', '))}</small>` : ''}</div></div></th>
            <td${route.trips_cancelled > 0 ? ' class="ops-count-warning"' : ''}>${format(route.trips_cancelled)}</td>
            <td>${format(route.trips_completed)}</td>
            <td${isLowest ? ' class="ops-count-warning"' : ''}>${format(rate, rateFormat)}${isLowest ? '<small class="ops-rank-note">Lowest</small>' : ''}</td>
            <td>${format(ratio(cost?.modeled_cost, cost?.completed_service), perTripCostFormat)}</td></tr>`;
        }).join('')}</tbody>
      </table></div>`;
  }

  function fleetQueue(vehicles, owners) {
    const critical = vehicles.filter(vehicle => numeric(vehicle.critical_orders) > 0)
      .sort((left, right) => byDescending(left, right, 'critical_orders') ||
        byDescending(left, right, 'open_orders') || label(left.vehicle_id).localeCompare(label(right.vehicle_id), 'en-US', { numeric: true }));
    const firstVehicles = critical.slice(0, 6);
    const vehicleCount = `${numberFormat.format(critical.length)} ${critical.length === 1 ? 'vehicle' : 'vehicles'}`;
    const queue = critical.length ? `<p class="ops-panel-detail">${firstVehicles.length < critical.length
      ? `Showing ${firstVehicles.length} of ${vehicleCount} with critical open orders.`
      : `${vehicleCount} with critical open orders.`}</p>
      <ul class="ops-vehicle-list">${firstVehicles.map(vehicle => `<li>
        <div><strong>${escapeHtml(label(vehicle.vehicle_id) || 'Unknown vehicle')}</strong>
          <small>${escapeHtml(label(vehicle.department_name) || 'Owner unspecified')}</small></div>
        <div class="ops-vehicle-count"><strong>${format(vehicle.critical_orders)} critical</strong>
          <small>${format(vehicle.open_orders)} open</small></div>
        <div class="ops-vehicle-cost">${format(vehicle.open_parts_cost, costFormat)}<small>open parts</small></div>
      </li>`).join('')}</ul>` : `<p class="ops-empty">${vehicles.some(vehicle => numeric(vehicle.critical_orders) !== null)
      ? 'No vehicles in the loaded detail have critical open orders.' : 'Vehicle-level repair results are unavailable.'}</p>`;
    const orderedOwners = owners.slice().sort((left, right) => byDescending(left, right, 'critical_orders') ||
      byDescending(left, right, 'open_orders') || label(left.department_name).localeCompare(label(right.department_name)));
    const ownerTable = orderedOwners.length ? `<div class="ops-table-wrap" role="region" aria-label="Open work by fleet owner" tabindex="0">
      <table class="ops-table ops-owner-table">
        <thead><tr><th scope="col">Owner</th><th scope="col" aria-sort="descending">Critical</th>
          <th scope="col">Open</th><th scope="col">Parts</th></tr></thead>
        <tbody>${orderedOwners.map(owner => `<tr>
          <th scope="row">${escapeHtml(label(owner.department_name) || 'Owner unspecified')}</th>
          <td${numeric(owner.critical_orders) > 0 ? ' class="ops-count-critical"' : ''}>${format(owner.critical_orders)}</td>
          <td>${format(owner.open_orders)}</td><td>${format(owner.open_parts_cost, costFormat)}</td></tr>`).join('')}
        </tbody>
      </table></div>` : '<p class="ops-empty">No owner totals are available.</p>';
    return `<section class="panel ops-panel ops-fleet" id="fleet-queue" tabindex="-1" aria-label="Fleet repair queue">
      <h2 class="panel-title ops-panel-title">Critical repair queue</h2>
      ${queue}
      <div class="ops-owner-section"><h3>Open work by fleet owner</h3>${ownerTable}</div>
      <p class="ops-note">Critical orders are included in the open count. Parts values cover all open orders in the fleet snapshot.</p>
    </section>`;
  }

  function chartCeiling(peak) {
    if (peak <= 0) return 0;
    const scale = 10 ** Math.floor(Math.log10(peak));
    return Math.ceil(peak / scale * 2) * scale / 2;
  }

  function chartView(input, routeName) {
    const days = Array.from(groupBy(input, row => row.day), ([day, group]) => ({ day, ...totals(group, serviceFields) }))
      .sort((left, right) => left.day.localeCompare(right.day));
    if (!days.length) return '<p class="ops-empty">No daily service results are available for this selection.</p>';
    const counts = totals(days, serviceFields);
    const max = chartCeiling(Math.max(0, ...days.map(day => day.trips_completed ?? 0)));
    const dates = days.map(day => day.day);
    return `<p class="ops-trend-summary"><strong>${escapeHtml(routeName)}</strong>
      <span>${format(counts.trips_completed)} completed</span>
      <span>${format(ratio(counts.trips_on_time, counts.trips_completed), rateFormat)} on time</span>
      <span>${format(counts.trips_cancelled)} cancelled</span></p>
      <figure class="ops-chart">
        <figcaption class="ops-chart-caption">
          <span class="ops-legend-item"><i class="ops-legend-swatch ops-legend-ontime" aria-hidden="true"></i>On time</span>
          <span class="ops-legend-item"><i class="ops-legend-swatch ops-legend-completed" aria-hidden="true"></i>Other completed</span>
          <span class="ops-legend-item"><i class="ops-legend-swatch ops-legend-cancelled" aria-hidden="true"></i>Cancelled count below</span>
        </figcaption>
        <div class="ops-chart-scroll" role="region" aria-label="Daily service chart" tabindex="0">
          <div class="ops-chart-inner" style="--ops-days: ${days.length}">
            <div class="ops-chart-axis" aria-hidden="true"><span>${format(max)}</span><span>${max ? '0' : ''}</span></div>
            <ul class="ops-chart-days" aria-label="${escapeHtml(routeName)} daily service counts">
              ${days.map(day => {
                const bar = max ? Math.max(0, day.trips_completed / max) * 100 : 0;
                const onTime = Math.min(1, Math.max(0, ratio(day.trips_on_time, day.trips_completed) ?? 0)) * 100;
                const tooltip = `${dateLabel(day.day, fullDateFormat)} · ${format(day.trips_completed)} completed · ` +
                  `${format(day.trips_on_time)} on time · ${format(day.trips_cancelled)} cancelled`;
                return `<li class="ops-chart-day" title="${escapeHtml(tooltip)}"><span class="ops-visually-hidden">${escapeHtml(tooltip)}</span>
                  <span class="ops-chart-track" aria-hidden="true"><span class="ops-chart-bar" style="height: ${bar}%">
                    <span class="ops-chart-bar-ontime" style="height: ${onTime}%"></span></span></span>
                  <time datetime="${day.day}" aria-hidden="true">${dateLabel(day.day)}</time>
                  <span class="ops-chart-cancelled${day.trips_cancelled > 0 ? ' ops-count-warning' : ''}" aria-hidden="true">${format(day.trips_cancelled)}</span></li>`;
              }).join('')}
            </ul>
          </div>
        </div>
        <p class="ops-note">${loadedWindow(dates)} · ${numberFormat.format(days.length)} ${days.length === 1 ? 'loaded service date' : 'loaded service dates'}</p>
      </figure>`;
  }

  function renderOperations(root, data, context) {
    const service = rows(data, 'service_reliability_by_route');
    const daily = rows(data, 'route_daily').map(row => ({ ...row, day: dateKey(row.service_date) })).filter(row => row.day);
    const dailyByRoute = groupBy(daily, row => label(row.route_id));
    const owners = rows(data, 'fleet_risk_by_owner');
    const vehicles = rows(data, 'fleet_detail');
    const costs = rows(data, 'route_cost_review');
    const costByRoute = new Map(Array.from(groupBy(costs, row => label(row.route_id)), ([id, group]) => [
      id, totals(group, ['modeled_cost', 'completed_service']),
    ]));
    const routes = routeSummaries(service, daily);
    const routesById = new Map(routes.map(route => [route.id, route]));
    const dailyRoutes = [...dailyByRoute.keys()].filter(Boolean).map(id => ({
      id, name: routesById.get(id)?.name || dailyByRoute.get(id).map(row => label(row.route_long_name)).find(Boolean) || '',
    })).sort(routeOrder);
    const serviceTotal = totals(routes, serviceFields);
    const fleetTotal = totals(owners.length ? owners : vehicles, fleetFields);
    const cancelledRoutes = routes.filter(route => route.trips_cancelled > 0).length;
    const loadedDates = [...new Set(daily.map(row => row.day))].sort();
    const knownRoutes = routes.filter(route => route.id).length;

    root.innerHTML = `<header class="ops-header">
      <div><h1 class="ops-title">Dispatch &amp; Fleet</h1>
        <p>Route exceptions and repair priorities for the fictional MonoRail sample.</p></div>
      <div class="ops-window"><span>Loaded service window</span><strong>${loadedWindow(loadedDates)}</strong></div>
    </header>
    <dl class="kpi-grid ops-kpis" aria-label="Dispatch and fleet totals">
      ${kpi('Completed trips', format(serviceTotal.trips_completed),
        knownRoutes ? `${format(knownRoutes)} ${knownRoutes === 1 ? 'route' : 'routes'} with loaded results` : 'Loaded service')}
      ${kpi('On-time completion', format(ratio(serviceTotal.trips_on_time, serviceTotal.trips_completed), rateFormat),
        `${format(serviceTotal.trips_on_time)} on-time trips of ${format(serviceTotal.trips_completed)} completed`)}
      ${kpi('Cancelled trips', format(serviceTotal.trips_cancelled),
        serviceTotal.trips_cancelled === null ? 'Loaded service' : `${format(cancelledRoutes)} ${cancelledRoutes === 1 ? 'route' : 'routes'} with cancellations`, serviceTotal.trips_cancelled > 0)}
      ${kpi('Critical open orders', format(fleetTotal.critical_orders),
        `${format(fleetTotal.open_orders)} open work orders in the fleet snapshot`, fleetTotal.critical_orders > 0)}
    </dl>
    <div class="dashboard-grid ops-layout">
        <section class="panel ops-panel" aria-label="Service exceptions">
          <h2 class="panel-title ops-panel-title">Service exceptions</h2>
          <p class="ops-panel-detail">Routes ranked by cancellations during the loaded period.</p>
          ${routeTable(routes, costByRoute, dailyByRoute)}
          <p class="ops-note">On time = on-time trips ÷ completed trips. Cost per trip uses modeled labor and allocated approved non-labor costs per completed trip from the cost model.</p>
        </section>
        ${fleetQueue(vehicles, owners)}
        <section class="panel ops-panel ops-trend" id="daily-service" tabindex="-1" aria-label="Daily service">
          <div class="ops-trend-head"><h2 class="panel-title ops-panel-title">Daily service</h2>
            <label class="ops-route-filter">Route
              <select${dailyRoutes.length ? '' : ' disabled'}><option value="">All routes</option>
                ${dailyRoutes.map(route => `<option value="${escapeHtml(route.id)}">${escapeHtml(route.name ? `${route.id} · ${route.name}` : route.id)}</option>`).join('')}
              </select>
            </label></div>
          <div class="ops-trend-content">${chartView(daily, 'All routes')}</div>
          <span class="ops-trend-status ops-visually-hidden" role="status"></span>
        </section>
    </div>
    <p class="ops-provenance">November service actuals cover a partial sample period. Service outcomes, fleet records and modeled costs are fictional.</p>`;

    const select = root.querySelector('.ops-route-filter select');
    const trend = root.querySelector('.ops-trend-content');
    const status = root.querySelector('.ops-trend-status');
    const routeButtons = [...root.querySelectorAll('.ops-route-button')];
    function selectRoute(id) {
      const route = dailyRoutes.find(entry => entry.id === id);
      const name = route ? `${route.id}${route.name ? ` · ${route.name}` : ''}` : 'All routes';
      select.value = route?.id ?? '';
      trend.innerHTML = chartView(route ? dailyByRoute.get(route.id) : daily, name);
      for (const button of routeButtons) button.setAttribute('aria-pressed', String(button.dataset.route === id));
      status.textContent = `Daily service updated for ${name}.`;
    }
    select.addEventListener('change', () => selectRoute(select.value));
    for (const button of routeButtons) button.addEventListener('click', () => {
      selectRoute(button.dataset.route);
      select.focus();
    });
    if (context?.has('route')) selectRoute(context.get('route'));
  }

  window.sampleDashboards = window.sampleDashboards || {};
  window.sampleDashboards.operations = renderOperations;
})();
