(function () {
  'use strict';

  const november = '2026-11';
  const december = '2026-12';
  const currency = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', trailingZeroDisplay: 'stripIfInteger',
  });
  const rateCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const count = new Intl.NumberFormat('en-US');
  const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const monthName = new Intl.DateTimeFormat('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function scalar(value) {
    return value && typeof value === 'object' && 'value' in value ? value.value : value;
  }

  function number(value) {
    const raw = scalar(value);
    if (typeof raw !== 'number' && typeof raw !== 'bigint' && typeof raw !== 'string') return null;
    if (typeof raw === 'string' && !raw.trim()) return null;
    const result = Number(raw);
    return Number.isFinite(result) ? result : null;
  }

  function display(value, formatter = currency) {
    return value === null ? '<span class="finance-missing" aria-label="Unavailable">—</span>' : formatter.format(value);
  }

  function rows(data, key) {
    return Array.isArray(data?.[key]) ? data[key].filter((row) => row && typeof row === 'object') : [];
  }

  function monthKey(value) {
    const raw = scalar(value);
    if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.toISOString().slice(0, 7) : null;
    if (typeof raw !== 'string') return null;
    return /^(\d{4}-(?:0[1-9]|1[0-2]))(?:$|-\d{2}(?:$|[T ]))/.exec(raw)?.[1] ?? null;
  }

  function groupMonths(result) {
    const periods = new Map();
    for (const row of result) {
      const month = monthKey(row.report_month);
      if (!month) continue;
      if (!periods.has(month)) periods.set(month, []);
      periods.get(month).push(row);
    }
    return periods;
  }

  function sum(result, key) {
    const amounts = result.map((row) => number(row[key]));
    return amounts.length && amounts.every((value) => value !== null)
      ? amounts.reduce((total, value) => total + value, 0)
      : null;
  }

  function descending(key) {
    return (a, b) => (number(b[key]) ?? -Infinity) - (number(a[key]) ?? -Infinity);
  }

  function statusLabel(value) {
    const status = String(scalar(value) ?? '').trim()
      .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
    return status ? status[0].toUpperCase() + status.slice(1).toLowerCase() : '';
  }

  function departmentName(row) {
    return String(scalar(row.department_name) ?? 'Unnamed department');
  }

  function ledgerRows(result, managers, budgetOnly, ordering, pendingOnly) {
    const visible = result.filter((row) => !pendingOnly || (number(row.pending_approval_total) ?? 0) > 0);
    if (!visible.length) {
      const message = result.length && pendingOnly
        ? 'No departments have a reported pending amount above zero.'
        : 'Department budget results are unavailable for this period.';
      return `<p class="finance-empty">${message}</p>`;
    }

    const byName = (a, b) => departmentName(a).localeCompare(departmentName(b));
    const leastRemaining = (a, b) => (number(a.remaining_budget_total) ?? Infinity)
      - (number(b.remaining_budget_total) ?? Infinity);
    const order = { remaining: leastRemaining, pending: descending('pending_approval_total'), name: byName }[ordering];
    visible.sort((a, b) => order(a, b) || byName(a, b));

    return `<table class="finance-table finance-ledger-table" role="table" aria-label="Department budget ledger">
      <thead role="rowgroup"><tr role="row">
        <th role="columnheader" scope="col">Department</th>
        <th role="columnheader" scope="col">${budgetOnly ? 'Budget' : 'Actuals / budget'}</th>
        <th role="columnheader" scope="col">Remaining</th>
        <th role="columnheader" scope="col">Pending</th>
      </tr></thead>
      <tbody role="rowgroup">${visible.map((row) => {
        const department = departmentName(row);
        const manager = managers.get(department);
        const budget = number(row.budget_total);
        const actual = budgetOnly ? null : number(row.actual_cost_total);
        const remaining = number(row.remaining_budget_total);
        const pending = number(row.pending_approval_total);
        const status = budgetOnly ? '' : statusLabel(row.budget_status);
        const used = actual !== null && budget > 0 ? actual / budget : null;
        const fill = Math.min(100, Math.max(0, (used ?? 0) * 100));

        return `<tr role="row">
          <th role="rowheader" scope="row">
            <span class="finance-department">${escapeHtml(department)}</span>
            ${manager ? `<span class="finance-secondary">${escapeHtml(manager)}</span>` : ''}
          </th>
          <td role="cell">
            <span class="finance-mobile-label" aria-hidden="true">${budgetOnly ? 'Budget' : 'Actuals / budget'}</span>
            <span class="finance-budget-amounts">${budgetOnly ? display(budget) : `${display(actual)} <span class="finance-secondary">/ ${display(budget)}</span>`}</span>
            ${used === null ? '' : `<span class="finance-budget-use${used > 1 ? ' finance-over' : ''}">
              <span class="finance-bar" aria-hidden="true"><span style="width:${fill}%"></span></span>
              <span>${percent.format(used)}</span>
            </span>`}
          </td>
          <td role="cell" class="finance-amount-cell${remaining < 0 ? ' finance-negative' : ''}">
            <span class="finance-mobile-label" aria-hidden="true">Remaining</span>
            <span>${display(remaining)}</span>
            ${status ? `<span class="finance-status">${escapeHtml(status)}</span>` : ''}
          </td>
          <td role="cell" class="finance-amount-cell${pending > 0 ? ' finance-pending' : ''}">
            <span class="finance-mobile-label" aria-hidden="true">Pending</span>
            <span>${display(pending)}</span>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  function supplierRows(result, scope, budgetOnly) {
    if (!result.length) {
      return `<p class="finance-empty">${budgetOnly
        ? 'Supplier invoice results are unavailable for this budget-only period.'
        : 'Supplier invoice results are unavailable for this period.'}</p>`;
    }

    const byPending = descending('pending_spend');
    const byApproved = descending('approved_spend');
    const ranked = [...result].sort((a, b) => byPending(a, b) || byApproved(a, b));
    const scale = Math.max(0, ...ranked.flatMap((row) => [number(row.approved_spend), number(row.pending_spend)]));
    const pendingTotal = sum(result, 'pending_spend');

    function lane(label, value, className) {
      const width = value > 0 && scale > 0 ? 100 * value / scale : 0;
      return `<div class="finance-supplier-lane ${className}">
        <span>${label}</span><span class="finance-bar" aria-hidden="true"><span style="width:${width}%"></span></span>
        <strong>${display(value)}</strong>
      </div>`;
    }

    return `<div class="finance-supplier-summary">
      <p>${escapeHtml(scope)}</p><p><strong>${display(pendingTotal)}</strong> pending</p>
    </div>
    <ul class="finance-supplier-list" aria-label="Supplier invoices by category">
      ${ranked.map((row) => {
        const invoices = number(row.invoices);
        const category = scalar(row.category);
        return `<li>
          <div class="finance-supplier-name">
            <div><strong>${escapeHtml(scalar(row.supplier_name) ?? 'Unnamed supplier')}</strong>
              ${category ? `<span class="finance-secondary">${escapeHtml(category)}</span>` : ''}</div>
            ${invoices === null ? '' : `<span class="finance-secondary">${count.format(invoices)} ${invoices === 1 ? 'invoice' : 'invoices'}</span>`}
          </div>
          ${lane('Pending', number(row.pending_spend), 'finance-supplier-pending')}
          ${lane('Approved', number(row.approved_spend), 'finance-supplier-approved')}
        </li>`;
      }).join('')}
    </ul>`;
  }

  function routeTable(result) {
    if (!result.length) return '<p class="finance-empty">Modeled route cost results are unavailable.</p>';

    return `<div class="finance-route-scroll" tabindex="0" role="region" aria-label="Modeled route costs table">
    <table class="finance-table finance-route-table">
      <thead><tr><th scope="col">Route</th><th scope="col">Modeled cost</th>
        <th scope="col">Completed trips</th><th scope="col">Cost / trip</th></tr></thead>
      <tbody>${[...result].sort(descending('modeled_cost')).map((row) => {
        const routeId = scalar(row.route_id);
        const name = scalar(row.route_long_name);
        const cost = number(row.modeled_cost);
        const trips = number(row.completed_service);
        const costPerTrip = cost !== null && trips > 0 ? cost / trips : null;
        return `<tr>
          <th scope="row"><span class="finance-route-name">
            ${routeId == null ? '' : `<span class="finance-route-id">${escapeHtml(routeId)}</span>`}
            ${name ? `<span>${escapeHtml(name)}</span>` : routeId == null ? 'Unnamed route' : ''}
          </span></th>
          <td>${display(cost)}</td><td>${display(trips, count)}</td><td>${display(costPerTrip, rateCurrency)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }

  function metric(label, amount, note, spotlight = false, unavailableLabel) {
    return `<div class="kpi finance-kpi${spotlight ? ' finance-kpi-review' : ''}">
      <span class="finance-kpi-label">${label}</span>
      <strong class="finance-kpi-value${amount < 0 && !spotlight ? ' finance-negative' : ''}">
        ${amount === null && unavailableLabel
          ? `<span class="finance-kpi-unavailable">${unavailableLabel}</span>`
          : display(amount)}
      </strong>
      ${note ? `<p>${note}</p>` : ''}
    </div>`;
  }

  function monthLabel(month) {
    return monthName.format(new Date(`${month}-01T00:00:00Z`));
  }

  window.sampleDashboards ??= {};
  window.sampleDashboards.finance = function renderFinance(root, data) {
    const budgetPeriods = groupMonths(rows(data, 'budget_by_month'));
    const vendorPeriods = groupMonths(rows(data, 'vendor_by_month'));
    const novemberBudget = rows(data, 'budget_by_department');
    if (!budgetPeriods.has(november) && novemberBudget.length) budgetPeriods.set(november, novemberBudget);

    const managers = new Map(rows(data, 'executive_department_review')
      .map((row) => [departmentName(row), scalar(row.manager_name)]));
    const vendorRollup = rows(data, 'vendor_approval_pipeline');
    const months = [...new Set([...budgetPeriods.keys(), ...vendorPeriods.keys()])].sort().reverse();
    if (!months.length) months.push(november);
    let month = months.includes(november) ? november : months[0];

    root.innerHTML = `<div class="finance-desk">
      <header class="finance-header">
        <div><h1>Financial Control</h1><p class="finance-period-note" data-finance-period-note></p></div>
        <label class="finance-period">
          <span>Reporting month</span>
          <select data-finance-month${months.length === 1 ? ' disabled' : ''}>
            ${months.map((value) => `<option value="${value}"${value === month ? ' selected' : ''}>${escapeHtml(monthLabel(value))}</option>`).join('')}
          </select>
        </label>
      </header>

      <div class="kpi-grid finance-kpis" data-finance-kpis role="group" aria-label="Budget summary"></div>

      <div class="dashboard-grid finance-grid">
        <section class="panel finance-panel finance-ledger" id="department-ledger" tabindex="-1" aria-label="Department budget ledger">
          <div class="finance-panel-heading">
            <h2 class="panel-title">Department ledger</h2>
            <div class="finance-ledger-tools">
              <button type="button" aria-pressed="false" data-finance-pending>Pending only</button>
              <label class="finance-order"><span>Sort by</span>
                <select data-finance-order>
                  <option value="remaining">Least remaining</option>
                  <option value="pending">Most pending</option>
                  <option value="name">Department A–Z</option>
                </select>
              </label>
            </div>
          </div>
          <div data-finance-ledger></div>
        </section>

        <section class="panel finance-panel finance-suppliers" aria-label="Supplier approval pipeline">
          <div class="finance-panel-heading"><h2 class="panel-title">Supplier approvals</h2></div>
          <div data-finance-suppliers></div>
        </section>

        <section class="panel finance-panel finance-routes" aria-label="Modeled route costs">
          <div class="finance-panel-heading">
            <div><h2 class="panel-title">Route cost reference</h2>
              <p>All reported route rows. Costs model labor and allocated approved non-labor expenses.</p></div>
          </div>
          ${routeTable(rows(data, 'route_cost_review'))}
        </section>
      </div>
    </div>`;

    const picker = root.querySelector('[data-finance-month]');
    const periodNote = root.querySelector('[data-finance-period-note]');
    const summary = root.querySelector('[data-finance-kpis]');
    const order = root.querySelector('[data-finance-order]');
    const pending = root.querySelector('[data-finance-pending]');
    const ledger = root.querySelector('[data-finance-ledger]');
    const suppliers = root.querySelector('[data-finance-suppliers]');

    function renderLedger() {
      ledger.innerHTML = ledgerRows(
        budgetPeriods.get(month) ?? [], month === november ? managers : new Map(), month === december,
        order.value, pending.getAttribute('aria-pressed') === 'true',
      );
    }

    function renderPeriod() {
      const budget = budgetPeriods.get(month) ?? [];
      const budgetOnly = month === december;
      const pendingTotal = sum(budget, 'pending_approval_total');
      const pendingDepartments = budget.filter((row) => number(row.pending_approval_total) > 0).length;
      const overBudget = budgetOnly ? 0 : budget.filter((row) => number(row.remaining_budget_total) < 0).length;
      const pendingCaption = pendingDepartments
        ? `${count.format(pendingDepartments)} ${pendingDepartments === 1 ? 'department' : 'departments'} with pending invoices`
        : pendingTotal === 0 ? 'No pending department invoices reported' : 'Department approval totals unavailable';
      const varianceCaption = overBudget
        ? `${count.format(overBudget)} ${overBudget === 1 ? 'department' : 'departments'} over budget` : '';

      periodNote.textContent = budgetOnly ? 'December is a budget-only period.'
        : month === november ? 'November actuals cover a partial reporting period.'
          : 'Pending invoice approvals are tracked separately from actuals.';
      summary.innerHTML = [
        metric('Awaiting invoice review', pendingTotal, pendingCaption, true),
        metric('Department budget', sum(budget, 'budget_total')),
        metric('Loaded actuals', budgetOnly ? null : sum(budget, 'actual_cost_total'),
          budgetOnly ? '' : 'Pending invoices shown separately', false, budgetOnly ? 'No actuals loaded' : undefined),
        metric('Budget remaining', sum(budget, 'remaining_budget_total'), varianceCaption),
      ].join('');

      pending.disabled = !budget.length;
      order.disabled = !budget.length;
      renderLedger();

      const useRollup = !vendorPeriods.size && !budgetOnly;
      const vendorResult = useRollup ? vendorRollup : vendorPeriods.get(month) ?? [];
      suppliers.innerHTML = supplierRows(vendorResult,
        useRollup ? 'All reported supplier months' : monthLabel(month), budgetOnly);
    }

    picker.addEventListener('change', () => {
      month = picker.value;
      pending.setAttribute('aria-pressed', 'false');
      renderPeriod();
    });
    order.addEventListener('change', renderLedger);
    pending.addEventListener('click', () => {
      pending.setAttribute('aria-pressed', String(pending.getAttribute('aria-pressed') !== 'true'));
      renderLedger();
    });

    renderPeriod();
  };
})();
