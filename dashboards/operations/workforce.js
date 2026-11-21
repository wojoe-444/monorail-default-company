(function () {
  const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
  const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const weekdayDate = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'
  });
  const fullDate = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });

  const metrics = {
    scheduled: { field: 'total_scheduled_hours', label: 'Scheduled', color: 'scheduled' },
    productive: { field: 'total_productive_hours', label: 'Productive', color: 'productive' },
    absence: { field: 'total_absence_hours', label: 'Absence', color: 'absence' },
    overtime: { field: 'total_overtime_hours', label: 'Overtime', color: 'overtime' },
    cost: { field: 'total_labor_cost', label: 'Labor cost', color: 'cost' }
  };

  const chartModes = {
    staffing: { label: 'Staffing', metrics: ['scheduled', 'productive'], unit: 'Hours' },
    exceptions: { label: 'Exceptions', metrics: ['absence', 'overtime'], unit: 'Hours' },
    cost: { label: 'Labor cost', metrics: ['cost'], unit: 'USD' }
  };

  function escape(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value).replace(/[&<>"']/g, character => entities[character]);
  }

  function unwrap(value) {
    return value && typeof value === 'object' && 'value' in value ? value.value : value;
  }

  function numeric(value) {
    const raw = unwrap(value);
    if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim())) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function dateKey(value) {
    const raw = unwrap(value);
    if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString().slice(0, 10);
    const key = typeof raw === 'string' && raw.match(/^\d{4}-\d{2}-\d{2}(?=$|T| )/)?.[0];
    if (!key) return '';
    const date = utcDate(key);
    return Number.isFinite(date.getTime()) && date.toISOString().startsWith(key) ? key : '';
  }

  function utcDate(key) {
    return new Date(`${key}T00:00:00Z`);
  }

  function rows(data, query) {
    return Array.isArray(data?.[query]) ? data[query].filter(row => row && typeof row === 'object') : [];
  }

  function departmentName(row) {
    const name = unwrap(row.department_name);
    return typeof name === 'string' && name.trim() ? name.trim() : 'Unassigned department';
  }

  function totals(reportRows) {
    const result = {};
    for (const [key, metric] of Object.entries(metrics)) {
      const values = reportRows.map(row => numeric(row[metric.field])).filter(value => value !== null);
      result[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    }
    return result;
  }

  function format(value, formatter = number) {
    return value === null ? '—' : formatter.format(value);
  }

  function ratio(value, base) {
    return value !== null && base > 0 ? percent.format(value / base) : '';
  }

  function metricValue(key, value) {
    if (value === null) return '—';
    return key === 'cost' ? format(value, money) : `${format(value)} h`;
  }

  function countLabel(value, singular, plural = `${singular}s`) {
    return `${format(value)} ${value === 1 ? singular : plural}`;
  }

  function scaleFor(largest) {
    if (largest <= 0) return 4;
    const step = largest / 4;
    const magnitude = 10 ** Math.floor(Math.log10(step));
    const factor = [1, 2, 2.5, 5, 10].find(candidate => candidate * magnitude >= step);
    return 4 * (factor ?? 10) * magnitude;
  }

  function renderKpis(department, roster, rosterCount, activeStaff, report, hasRows) {
    const rate = ratio(report.productive, report.scheduled);
    let rosterNote = department ? 'Manager unavailable' : countLabel(rosterCount, 'roster department');
    if (department) rosterNote = roster?.manager || (roster ? 'Manager unavailable' : 'No roster record');
    if (!department && !rosterCount) rosterNote = 'Roster unavailable';
    const noHours = hasRows ? 'Hours unavailable' : 'No time records in scope';
    const cards = [
      ['roster', 'Active roster', format(activeStaff), rosterNote],
      ['productive', 'Productive hours', metricValue('productive', report.productive),
        rate ? `${rate} of ${metricValue('scheduled', report.scheduled)} scheduled` :
          report.scheduled === null ? (hasRows ? 'Scheduled hours unavailable' : noHours) :
            `${metricValue('scheduled', report.scheduled)} scheduled`],
      ['overtime', 'Overtime', metricValue('overtime', report.overtime),
        report.absence === null ? noHours : `${metricValue('absence', report.absence)} of absence also logged`],
      ['cost', 'Labor cost', metricValue('cost', report.cost), report.cost === null ?
        (hasRows ? 'Cost unavailable' : 'No time records in scope') : 'Reported labor cost in USD']
    ];
    return cards.map(([kind, label, value, note]) => `
      <div class="kpi wf-kpi wf-kpi--${kind}">
        <div class="wf-kpi-label">${label}</div>
        <strong class="wf-kpi-value">${escape(value)}</strong>
        <div class="wf-kpi-note">${escape(note)}</div>
      </div>`).join('');
  }

  function renderChart({ dates, dailyTotals, department, selectedDate, mode }) {
    const { metrics: keys, unit } = chartModes[mode];
    const max = scaleFor(Math.max(0, ...dates.flatMap(date => keys.map(key => dailyTotals.get(date)[key] ?? 0))));
    const modeButtons = Object.entries(chartModes).map(([id, item]) => `
      <button type="button" data-wf-mode="${id}" aria-pressed="${mode === id}">${item.label}</button>`).join('');
    const legend = keys.map(key => `
      <span class="wf-legend-item"><span class="wf-swatch wf-color-${metrics[key].color}" aria-hidden="true"></span>${metrics[key].label}</span>`).join('');
    const tickLabels = [1, 0.75, 0.5, 0.25, 0].map(fraction => {
      const value = max * fraction;
      return `<span>${unit === 'USD' ? '$' : ''}${compact.format(value)}</span>`;
    }).join('');
    const days = dates.map(date => {
      const day = dailyTotals.get(date);
      const caption = `${weekdayDate.format(utcDate(date))}, ${date.slice(0, 4)}`;
      const quantities = keys.map(key => `${metrics[key].label} ${metricValue(key, day[key])}`);
      const description = `${caption}. ${day.hasRows ? quantities.join('. ') : 'No time records.'}`;
      const bars = keys.map(key => {
        const value = day[key];
        const height = Math.max(0, (value ?? 0) / max * 100);
        const dataState = value === null ? 'missing' : value === 0 ? 'zero' : 'present';
        return `<span class="wf-bar wf-color-${metrics[key].color}" data-value="${dataState}" style="--wf-height:${height}%"></span>`;
      }).join('');
      return `
        <button class="wf-day${selectedDate && selectedDate !== date ? ' wf-day--muted' : ''}"
          type="button" data-wf-day="${date}" aria-label="${escape(description)}" aria-pressed="${selectedDate === date}">
          <span class="wf-day-bars" aria-hidden="true">${bars}</span>
          <span class="wf-day-date" aria-hidden="true">${escape(shortDate.format(utcDate(date)))}</span>
          <span class="wf-tooltip" aria-hidden="true">${escape(description)}</span>
        </button>`;
    }).join('');
    let chart = '<div class="wf-empty">Daily time entries are unavailable for this reporting period.</div>';
    if (dates.length) {
      const hasDailyRows = [...dailyTotals.values()].some(day => day.hasRows);
      chart = `
        <div class="wf-chart-meta"><span>${unit}</span><div class="wf-legend">${legend}</div></div>
        <div class="wf-chart-body">
          <div class="wf-axis" aria-hidden="true">${tickLabels}</div>
          <div class="wf-plot-scroll">
            <div class="wf-plot" style="--wf-days:${dates.length}">
              <div class="wf-gridlines" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
              <div class="wf-days">${days}</div>
            </div>
          </div>
        </div>
        <div class="wf-chart-note">${hasDailyRows ? 'Select a day to view its staffing report.' : `No daily time entries for ${escape(department || 'this scope')}.`}</div>`;
    }
    return `
      <div class="wf-panel-head">
        <div><h2 class="panel-title">Daily time report</h2><p>${escape(department || 'All departments')}</p></div>
        ${dates.length ? `<div class="wf-modes" role="group" aria-label="Chart metric">${modeButtons}</div>` : ''}
      </div>
      ${chart}`;
  }

  function renderBrief({ report, leader, selectedDate, hasRows }) {
    const base = Math.max(report.absence ?? 0, report.overtime ?? 0, 1);
    const comparisons = ['absence', 'overtime'].map(key => {
      const value = report[key];
      const share = ratio(value, report.scheduled);
      return `
        <div class="wf-exception">
          <div class="wf-exception-label"><span>${metrics[key].label}</span><strong>${metricValue(key, value)}</strong></div>
          <div class="wf-meter" aria-hidden="true"><span class="wf-color-${metrics[key].color}" style="width:${Math.max(0, (value ?? 0) / base * 100)}%"></span></div>
          ${share ? `<span class="wf-exception-share">${share} of scheduled hours</span>` : ''}
        </div>`;
    }).join('');
    let finding = '';
    if (leader) {
      finding = `
        <div class="wf-finding">
          <span>${escape(leader.label)}</span>
          <strong>${escape(leader.name)}</strong>
          <p>${escape(leader.detail)}</p>
        </div>`;
    }
    return `
      <div class="wf-panel-head">
        <div><h2 class="panel-title">Shift exceptions</h2><p>${selectedDate ? 'Selected reporting day' : 'Loaded reporting period'}</p></div>
      </div>
      ${hasRows ? comparisons + finding : '<div class="wf-empty">No time entries in this selection.</div>'}`;
  }

  function renderRoster({ names, roster, reports, selectedDate, dates, department }) {
    const reported = [...reports.values()].filter(report => report.hasRows).length;
    const rosterSummary = `${countLabel(roster.size, 'department')} on the roster · ${countLabel(reported, 'department')} reporting`;
    const body = names.map(name => {
      const record = roster.get(name);
      const report = reports.get(name);
      const active = department === name;
      let reporting = 'No rows';
      if (report.hasRows) {
        reporting = !selectedDate && dates.length ? `${report.days} / ${dates.length} days` : 'Reported';
      }
      return `
        <tr${active ? ' class="wf-selected-row"' : ''}>
          <th scope="row">
            <button type="button" class="wf-department" data-wf-department="${escape(name)}" aria-pressed="${active}">${escape(name)}</button>
            <span class="wf-manager">${escape(record?.manager || (record ? 'Manager unavailable' : 'No roster record'))}</span>
          </th>
          <td>${format(record?.headcount ?? null)}</td>
          <td><span class="wf-coverage${report.hasRows ? ' wf-coverage--recorded' : ''}">${reporting}</span></td>
          <td>${metricValue('productive', report.productive)}</td>
          <td>${metricValue('absence', report.absence)}</td>
          <td>${metricValue('overtime', report.overtime)}</td>
          <td>${metricValue('cost', report.cost)}</td>
        </tr>`;
    }).join('');
    return `
      <div class="wf-panel-head">
        <div><h2 class="panel-title">Department roster</h2><p>${escape(rosterSummary)}</p></div>
      </div>
      ${names.length ? `
        <div class="wf-table-scroll" tabindex="0" role="region" aria-label="Department roster and time reporting">
          <table class="wf-table">
            <thead><tr>
              <th scope="col">Department / manager</th><th scope="col">Active staff</th><th scope="col">Reporting</th>
              <th scope="col">Productive</th><th scope="col">Absence</th><th scope="col">Overtime</th><th scope="col">Labor cost</th>
            </tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <p class="wf-source-note">Active staff and managers come from the current roster. Reporting reflects time entries ${dates.length ? 'for the selected dates' : 'in the loaded period'}.</p>` :
        '<div class="wf-empty">Roster and department time reports are unavailable.</div>'}`;
  }

  function workforce(root, data, context) {
    const roster = new Map(rows(data, 'headcount_by_department').map(row => [departmentName(row), {
      manager: unwrap(row.manager_name), headcount: numeric(row.headcount)
    }]));
    const daily = rows(data, 'workforce_daily').map(row => ({
      ...row, date: dateKey(row.work_date), name: departmentName(row)
    })).filter(row => row.date);
    const summary = rows(data, 'workforce_cost_by_department').map(row => ({ ...row, name: departmentName(row) }));
    const dates = [...new Set(daily.map(row => row.date))].sort();
    const names = [...new Set([...roster.keys(), ...daily.map(row => row.name), ...summary.map(row => row.name)])].sort((a, b) =>
      (roster.get(b)?.headcount ?? -1) - (roster.get(a)?.headcount ?? -1) || a.localeCompare(b));
    const rosterValues = [...roster.values()].flatMap(record => record.headcount === null ? [] : [record.headcount]);
    const totalHeadcount = rosterValues.length ? rosterValues.reduce((sum, value) => sum + value, 0) : null;
    const first = dates[0];
    const last = dates[dates.length - 1];
    const dateRange = !first ? 'Dates unavailable' : first === last ? fullDate.format(utcDate(first)) :
      fullDate.formatRange(utcDate(first), utcDate(last));

    const initialDepartment = context?.get('department');
    let department = names.includes(initialDepartment) ? initialDepartment : '';
    let selectedDate = '';
    let mode = 'staffing';

    root.innerHTML = `
      <div class="wf-desk">
        <header class="wf-header">
          <div class="wf-heading">
            <p class="wf-eyebrow">People operations</p>
            <h1>Workforce Desk</h1>
            <p class="wf-period">${escape(dateRange)}${dates.length ? `<span>${countLabel(dates.length, 'business day')}</span>` : ''}</p>
          </div>
          <div class="wf-filters">
            <label><span>Department</span><select data-wf-filter="department">
              <option value="">All departments</option>
              ${names.map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join('')}
            </select></label>
            <label><span>Reporting dates</span><select data-wf-filter="date"${dates.length ? '' : ' disabled'}>
              <option value="">${dates.length ? `All ${countLabel(dates.length, 'reporting day')}` : 'Loaded period'}</option>
              ${dates.map(date => `<option value="${date}">${escape(weekdayDate.format(utcDate(date)))}</option>`).join('')}
            </select></label>
          </div>
        </header>
        <div class="wf-sr-only" aria-live="polite" data-wf-status></div>
        <section class="kpi-grid wf-kpis" aria-label="Workforce figures"></section>
        <div class="dashboard-grid wf-grid">
          <section class="panel wf-panel wf-chart" aria-label="Daily time report"></section>
          <section class="panel wf-panel wf-brief" aria-label="Shift exceptions"></section>
        </div>
        <section class="panel wf-panel wf-roster" aria-label="Department roster"></section>
      </div>`;

    const desk = root.querySelector('.wf-desk');
    const kpis = desk.querySelector('.wf-kpis');
    const chart = desk.querySelector('.wf-chart');
    const brief = desk.querySelector('.wf-brief');
    const rosterPanel = desk.querySelector('.wf-roster');
    const departmentFilter = desk.querySelector('[data-wf-filter="department"]');
    const dateFilter = desk.querySelector('[data-wf-filter="date"]');
    const status = desk.querySelector('[data-wf-status]');

    function update(focus) {
      const chartScroll = chart.querySelector('.wf-plot-scroll')?.scrollLeft ?? 0;
      const tableScroll = rosterPanel.querySelector('.wf-table-scroll')?.scrollLeft ?? 0;
      const periodRows = dates.length ? daily.filter(row => !selectedDate || row.date === selectedDate) : summary;
      const scopeRows = periodRows.filter(row => !department || row.name === department);
      const report = totals(scopeRows);
      const reports = new Map(names.map(name => {
        const departmentRows = periodRows.filter(row => row.name === name);
        return [name, { ...totals(departmentRows), hasRows: departmentRows.length > 0, days: new Set(departmentRows.map(row => row.date)).size }];
      }));
      const dailyTotals = new Map(dates.map(date => {
        const day = daily.filter(row => row.date === date && (!department || row.name === department));
        return [date, { ...totals(day), hasRows: day.length > 0 }];
      }));

      let leader;
      if (!department) {
        const top = [...reports].reduce((highest, entry) => (entry[1].overtime ?? 0) > (highest?.[1].overtime ?? 0) ? entry : highest, null);
        if (top) {
          const share = ratio(top[1].overtime, report.overtime);
          leader = { label: 'Most overtime', name: top[0], detail: `${metricValue('overtime', top[1].overtime)} · ${share} of reported overtime` };
        }
      } else if (selectedDate) {
        const period = totals(daily.filter(row => row.name === department));
        const share = ratio(report.overtime, period.overtime);
        if (share) {
          leader = { label: 'Share of department overtime', name: share, detail: `${metricValue('overtime', report.overtime)} on this day of ${metricValue('overtime', period.overtime)} in the loaded period` };
        }
      } else if (dates.length) {
        const top = [...dailyTotals].reduce((highest, entry) => (entry[1].overtime ?? 0) > (highest?.[1].overtime ?? 0) ? entry : highest, null);
        if (top) {
          leader = { label: 'Highest-overtime day', name: weekdayDate.format(utcDate(top[0])), detail: `${metricValue('overtime', top[1].overtime)} overtime in ${department}` };
        }
      }

      const activeStaff = department ? roster.get(department)?.headcount ?? null : totalHeadcount;
      departmentFilter.value = department;
      dateFilter.value = selectedDate;
      kpis.innerHTML = renderKpis(department, roster.get(department), roster.size, activeStaff, report, scopeRows.length > 0);
      chart.innerHTML = renderChart({ dates, dailyTotals, department, selectedDate, mode });
      brief.innerHTML = renderBrief({ report, leader, selectedDate, hasRows: scopeRows.length > 0 });
      rosterPanel.innerHTML = renderRoster({ names, roster, reports, selectedDate, dates, department });
      const chartViewport = chart.querySelector('.wf-plot-scroll');
      const tableViewport = rosterPanel.querySelector('.wf-table-scroll');
      if (chartViewport) chartViewport.scrollLeft = chartScroll;
      if (tableViewport) tableViewport.scrollLeft = tableScroll;
      if (focus) {
        const button = [...desk.querySelectorAll(`button[${focus.attribute}]`)].find(item => item.getAttribute(focus.attribute) === focus.value);
        button?.focus({ preventScroll: true });
      }
      status.textContent = `${department || 'All departments'}. ${selectedDate ? fullDate.format(utcDate(selectedDate)) : dates.length ? 'All reporting dates' : 'Loaded period'}.`;
    }

    departmentFilter.addEventListener('change', () => {
      department = departmentFilter.value;
      update();
    });
    dateFilter.addEventListener('change', () => {
      selectedDate = dateFilter.value;
      update();
    });
    desk.addEventListener('click', event => {
      const button = event.target.closest('button[data-wf-day], button[data-wf-mode], button[data-wf-department]');
      if (!button) return;
      if (button.hasAttribute('data-wf-day')) {
        const value = button.dataset.wfDay;
        selectedDate = selectedDate === value ? '' : value;
        update({ attribute: 'data-wf-day', value });
      } else if (button.hasAttribute('data-wf-mode')) {
        mode = button.dataset.wfMode;
        update({ attribute: 'data-wf-mode', value: mode });
      } else {
        const value = button.dataset.wfDepartment;
        department = department === value ? '' : value;
        update({ attribute: 'data-wf-department', value });
      }
    });

    update();
  }

  window.sampleDashboards = window.sampleDashboards || {};
  window.sampleDashboards.workforce = workforce;
}());
