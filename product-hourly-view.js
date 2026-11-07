(() => {
  const $ = name => document.getElementById(`product-hourly-${name}`);
  const state = { report: null, controller: null, generation: 0 };
  const number = value => new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(value);
  const money = value => value == null ? 'Sin dato' : formatClp(value);
  const status = (message, type = 'muted') => setStatus($('status'), message, type);

  function syncDates() {
    const mode = $('period').value, today = browserIsoToday();
    for (const name of ['from', 'to']) { $(name).disabled = mode !== 'custom'; $(name).max = today; }
    if (mode === 'custom') return;
    let from = today, to = today;
    if (mode === 'last-30-days') { to = offsetIsoDate(today, -1); from = offsetIsoDate(to, -29); }
    if (mode === 'current-week') from = offsetIsoDate(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
    if (mode === 'current-month') from = `${today.slice(0, 7)}-01`;
    $('from').value = from; $('to').value = to;
  }

  function markDirty() {
    state.generation++;
    state.controller?.abort();
    $('run').disabled = false;
    status(state.report ? 'Los filtros cambiaron. Pulsa Generar reporte para actualizar la matriz.' : 'Selecciona los filtros y pulsa Generar reporte.');
  }

  function topFive(products, metric) {
    return [...products].sort((left, right) => {
      const a = left[metric], b = right[metric];
      if (a == null || b == null) return a == null && b == null ? left.name.localeCompare(right.name, 'es') : a == null ? 1 : -1;
      return b - a || (metric === 'units' ? (right.netSales ?? -Infinity) - (left.netSales ?? -Infinity) : right.units - left.units)
        || left.name.localeCompare(right.name, 'es');
    }).slice(0, 5);
  }

  function render() {
    const report = state.report;
    if (!report) return;
    const metric = $('metric').value;
    const header = $('head').insertRow();
    $('head').replaceChildren(header);
    const hour = document.createElement('th'); hour.scope = 'col'; hour.textContent = 'Franja horaria'; header.append(hour);
    for (const store of report.stores) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = store.name; header.append(th); }
    $('body').replaceChildren();
    for (const block of report.blocks) {
      const tr = $('body').insertRow();
      const label = document.createElement('th'); label.scope = 'row'; label.textContent = block.label; tr.append(label);
      for (const cell of block.stores) {
        const td = tr.insertCell(), products = topFive(cell.products, metric);
        if (!products.length) { td.textContent = 'Sin ventas'; td.className = 'product-hourly-empty'; continue; }
        const list = document.createElement('ol'); list.className = 'product-hourly-top';
        for (const product of products) {
          const li = document.createElement('li'), name = document.createElement('strong'), figures = document.createElement('span');
          name.textContent = product.name;
          figures.className = 'product-hourly-figures';
          const units = document.createElement('span'), sales = document.createElement('span');
          units.textContent = `${number(product.units)} unid.`; sales.textContent = money(product.netSales);
          units.classList.toggle('selected', metric === 'units'); sales.classList.toggle('selected', metric === 'netSales');
          figures.append(units, sales); li.append(name, figures); list.append(li);
        }
        td.append(list);
      }
    }
    $('context').textContent = `${report.scope.label} · ${formatReportDate(report.period.from)} – ${formatReportDate(report.period.to)} · ${report.filters.bar === 'all' ? 'Todas las barras' : { hot: 'Barra Caliente', cold: 'Barra Fría', other: 'Otros / sin barra' }[report.filters.bar]} · ${report.filters.groupFormats ? 'Formatos agrupados' : 'Formatos separados'} · Ranking por ${metric === 'units' ? 'unidades' : 'venta neta'}`;
    $('note').textContent = `${report.definition}${report.warnings?.length ? ` ${report.warnings.join(' ')}` : ''}`;
  }

  $('filters').addEventListener('change', event => { if (event.target === $('period')) syncDates(); markDirty(); });
  $('filters').addEventListener('submit', async event => {
    event.preventDefault();
    markDirty();
    if (!$('from').value || !$('to').value || $('from').value > $('to').value || $('to').value > browserIsoToday()) {
      status('Selecciona fechas válidas, en orden y no futuras.', 'error'); return;
    }
    const generation = state.generation, controller = new AbortController(); state.controller = controller;
    const query = new URLSearchParams({ location: $('location').value, period: 'custom', dateFrom: $('from').value,
      dateTo: $('to').value, bar: $('bar').value, groupFormats: String($('formats').checked) });
    $('run').disabled = true; status('Generando producto horario…');
    try {
      const report = await apiRequest(`/api/sales/product-hourly?${query}`, { signal: controller.signal });
      if (controller.signal.aborted || generation !== state.generation) return;
      state.report = report; $('results').hidden = false; render();
      status(report.warnings?.length ? 'Reporte generado con observaciones.' : 'Reporte generado.', report.warnings?.length ? 'warning' : 'success');
    } catch (error) { if (!controller.signal.aborted && generation === state.generation) status(error.message, 'error'); }
    finally { if (generation === state.generation) $('run').disabled = false; }
  });
  $('metric').addEventListener('change', render);
  window.openProductHourly = () => {};
  syncDates();
})();
