(() => {
  const el = id => document.getElementById(id);
  const dialog = el('sales-projection-dialog');
  if (!dialog) return;
  document.body.appendChild(dialog);
  const cache = new Map();
  const model = window.BrewitSalesProjectionModel;
  let report = null, editing = false, busy = false, sequence = 0;
  let referenceDays = 4;
  try {
    const saved = Number(localStorage.getItem('brewit.salesProjection.referenceDays'));
    if (model.REFERENCE_DAYS.includes(saved)) referenceDays = saved;
  } catch { /* The selector also works when browser storage is unavailable. */ }
  el('sales-projection-reference-days').value = String(referenceDays);
  const money = value => formatClp(value);
  const percent = value => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const monthLabel = date => {
    const label = new Intl.DateTimeFormat('es-CL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
    return label[0].toUpperCase() + label.slice(1);
  };
  const dayLabel = date => new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const status = (text, type = '') => setStatus(el('sales-projection-status'), text, type);
  function targets() {
    const selected = el('sales-projection-closure-location').value;
    return selected === 'all' ? report.stores.map(store => store.id) : [selected];
  }
  function setBusy(value) {
    busy = value;
    el('sales-projection-location').disabled = value;
    el('sales-projection-reference-days').disabled = value;
    el('sales-projection-edit-closures').disabled = value || !report?.stores.length;
    el('sales-projection-closure-location').disabled = value;
    dialog.querySelectorAll('button[data-projection-date]').forEach(button => { button.disabled = value || !editing; });
  }
  function configureTargets() {
    const select = el('sales-projection-closure-location'), previous = select.value;
    select.replaceChildren(...(report.stores.length > 1 ? [new Option('Todos los locales mostrados', 'all')] : []),
      ...report.stores.map(store => new Option(store.name, store.id)));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }
  function cellTitle(day) {
    if (day.isActual) return `${dayLabel(day.date)} · Venta neta real: ${money(day.actualSales)}.`;
    return [dayLabel(day.date), ...day.locations.map(location => {
      const reference = report.baselines[location.id][new Date(`${day.date}T12:00:00Z`).getUTCDay()];
      const samples = reference.samples.slice(0, referenceDays).map(sample => `${sample.date}: ${money(sample.netSales)}`).join('; ');
      return `${location.name}: ${location.closed ? 'cerrado; excluido' : 'abierto'} · promedio ${money(location.estimate)} · ${reference.usedSamples.length} fechas con venta positiva de las últimas ${referenceDays} equivalentes (${samples}).`;
    })].join('\n');
  }
  function calendar(month) {
    const section = node('section', undefined, 'sales-projection-month');
    const table = node('table', undefined, 'sales-projection-calendar');
    table.appendChild(node('caption', monthLabel(month.from)));
    const heading = node('tr');
    for (const label of ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']) {
      const th = node('th', label); th.scope = 'col'; heading.appendChild(th);
    }
    const head = node('thead'); head.appendChild(heading); table.appendChild(head);
    const body = node('tbody');
    const offset = (new Date(`${month.from}T12:00:00Z`).getUTCDay() + 6) % 7;
    const size = Math.ceil((offset + month.days.length) / 7) * 7;
    let row;
    for (let index = 0; index < size; index++) {
      if (index % 7 === 0) { row = node('tr'); body.appendChild(row); }
      const td = node('td'), day = month.days[index - offset];
      row.appendChild(td);
      if (!day) { td.className = 'sales-projection-blank'; continue; }
      td.dataset.date = day.date;
      const content = node(day.isActual ? 'div' : 'button', undefined,
        `sales-projection-day ${day.isActual ? 'sales-projection-real' : 'sales-projection-estimate'}${day.closedAll ? ' is-closed' : ''}${day.date === report.today ? ' is-today' : ''}`);
      content.title = cellTitle(day);
      content.appendChild(node('span', String(Number(day.date.slice(-2))), 'sales-projection-date'));
      const shown = day.isActual ? day.actualSales : day.closedAll ? day.forecast : day.includedForecast;
      content.appendChild(node('span', money(shown), 'sales-projection-day-value'));
      if (!day.isActual) {
        content.type = 'button';
        content.dataset.projectionDate = day.date;
        content.disabled = busy || !editing;
        const selected = targets();
        const selectedClosed = selected.every(id => report.closures.locations?.[id]?.includes(day.date));
        content.setAttribute('aria-pressed', String(selectedClosed));
        content.setAttribute('aria-label', `${dayLabel(day.date)}: ${selectedClosed ? 'quitar cierre' : 'marcar cierre'}`);
        content.addEventListener('click', () => toggleClosure(day.date));
        if (day.closedAll) content.appendChild(node('small', 'Cerrado', 'sales-projection-day-note'));
        else if (day.locations.some(location => location.closed)) {
          content.appendChild(node('s', `Cierre: ${money(day.excludedForecast)}`, 'sales-projection-excluded'));
        }
      }
      td.appendChild(content);
    }
    table.appendChild(body); section.appendChild(table);
    return section;
  }
  function render() {
    if (!report) return;
    el('sales-projection-method').textContent = `Cada proyección usa las últimas ${referenceDays} fechas equivalentes ya terminadas de cada local (lunes con lunes, etc.). El promedio considera solo ventas mayores que cero dentro de esas fechas; si todas son cero, el promedio es $0. Total Proyectado = venta real acumulada + proyección de los días restantes abiertos.`;
    el('sales-projection-scope').textContent = `${report.stores.map(store => store.name).join(' · ') || 'Sin cafeterías activas'} · Ventas reales hasta ${formatReportDate(new Date(Date.parse(`${report.today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10))}`;
    el('sales-projection-totals').replaceChildren(...report.months.map(month => {
      const card = node('section', undefined, 'sales-projection-summary');
      card.appendChild(node('h3', monthLabel(month.from)));
      const values = node('dl');
      for (const [kind, label, amount, className, change, comparison] of [
        ['real', 'Total Real Acumulado', month.realAccumulated, 'sales-projection-real', month.realVariationPercent,
          month.previousPeriodTo ? `vs. ${formatReportDate(month.previousPeriodFrom)} al ${formatReportDate(month.previousPeriodTo)}: ${money(month.previousPeriodSales)}` : 'Sin días reales transcurridos'],
        ['projected', 'Total Proyectado', month.projectedTotal, 'sales-projection-estimate', month.projectedVariationPercent,
          `vs. cierre ${month.projectedComparisonIsForecast ? 'proyectado' : 'real'} de ${monthLabel(`${month.previousMonthKey}-01`)}: ${money(month.projectedComparisonValue)}`]
      ]) {
        const item = node('div'), amountNode = node('dd', undefined, className);
        const delta = node('span', percent(change), `sales-projection-variation ${change === null || change === 0 ? 'is-neutral' : change > 0 ? 'is-positive' : 'is-negative'}`);
        delta.dataset.variation = kind;
        delta.title = `${comparison}${change === null ? ' · Sin base positiva para calcular variación.' : ''}`;
        amountNode.append(node('span', money(amount), 'sales-projection-total-value'), delta);
        item.append(node('dt', label), amountNode, node('small', comparison, 'sales-projection-comparison'));
        values.appendChild(item);
      }
      card.appendChild(values); return card;
    }));
    el('sales-projection-calendars').replaceChildren(...report.months.map(calendar));
    el('sales-projection-coverage').textContent = (report.warnings || []).join(' ');
    el('sales-projection-coverage').hidden = !report.warnings?.length;
    el('sales-projection-results').hidden = false;
  }
  async function load(location) {
    const request = ++sequence;
    const cached = cache.get(location);
    if (cached) { report = cached; configureTargets(); render(); }
    else { report = null; el('sales-projection-results').hidden = true; }
    status(cached ? 'Comprobando cierres guardados…' : 'Cargando ventas y referencias…');
    setBusy(true);
    try {
      let result;
      if (cached) {
        const closures = await apiRequest('/api/reports/sales-projection/closures');
        result = closures.today === cached.today ? model.applyClosures(cached, closures)
          : await apiRequest(`/api/reports/sales-projection?location=${encodeURIComponent(location)}`);
      } else result = await apiRequest(`/api/reports/sales-projection?location=${encodeURIComponent(location)}`);
      if (request !== sequence || !dialog.open) return;
      report = model.applyReferenceDays(result, referenceDays); cache.set(location, report); configureTargets(); render(); status('');
    } catch (error) {
      if (request === sequence) status(`${cached ? 'Mostrando los últimos datos disponibles. ' : ''}${error.message}`, 'error');
    } finally {
      if (request === sequence) setBusy(false);
    }
  }
  async function toggleClosure(date) {
    if (busy || !editing) return;
    const request = sequence;
    const currentReport = report;
    const locationIds = targets();
    const closed = !locationIds.every(id => report.closures.locations?.[id]?.includes(date));
    setBusy(true); status('Guardando cierre…');
    try {
      const closures = await apiRequest('/api/reports/sales-projection/closures', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locationIds, date, closed })
      });
      for (const [key, value] of cache) cache.set(key, model.applyClosures(value, closures));
      if (request !== sequence || !dialog.open) return;
      report = model.applyClosures(currentReport, closures); render();
      status(closed ? 'Cierre guardado. Su proyección queda excluida del total.' : 'Cierre quitado. La proyección vuelve a sumarse.', 'success');
    } catch (error) { if (request === sequence) status(error.message, 'error'); }
    finally { if (request === sequence) setBusy(false); }
  }
  function setEditing(value) {
    editing = value;
    dialog.classList.toggle('is-editing', value);
    el('sales-projection-edit-closures').setAttribute('aria-pressed', String(value));
    el('sales-projection-edit-closures').textContent = value ? 'Terminar de marcar cierres' : 'Marcar días de cierre';
    el('sales-projection-closure-scope').hidden = !value;
    el('sales-projection-closure-help').hidden = !value;
    render();
  }
  window.BrewitSalesProjection = { remember(location, value) { if (value) cache.set(location, model.applyReferenceDays(value, referenceDays)); } };
  el('open-sales-projection').addEventListener('click', () => {
    const select = el('sales-projection-location');
    select.replaceChildren(new Option('Todas las cafeterías', 'all'),
      ...Object.values(locationRegistry).filter(location => location.status === 'active' && location.type === 'store').map(location => new Option(location.name, location.id)));
    select.value = el('report-location-filter').value || 'all';
    report = null; setEditing(false); dialog.showModal(); void load(select.value);
  });
  el('close-sales-projection').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { sequence++; });
  el('sales-projection-location').addEventListener('change', event => { void load(event.target.value); });
  el('sales-projection-reference-days').addEventListener('change', event => {
    referenceDays = Number(event.target.value);
    try { localStorage.setItem('brewit.salesProjection.referenceDays', String(referenceDays)); } catch { /* Optional preference storage. */ }
    for (const [key, value] of cache) cache.set(key, model.applyReferenceDays(value, referenceDays));
    if (report) report = model.applyReferenceDays(report, referenceDays);
    render();
  });
  el('sales-projection-edit-closures').addEventListener('click', () => setEditing(!editing));
  el('sales-projection-closure-location').addEventListener('change', render);
})();
