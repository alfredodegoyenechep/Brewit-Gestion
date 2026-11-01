(() => {
  const byId = id => document.getElementById(`gender-review-${id}`);
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  let initialized = false, page = 1, preview = null, query = '', loadSequence = 0, categories = {};
  async function request(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || 'No se pudo completar la operación.'); error.details = data.errors || []; throw error; }
    return data;
  }
  function selectedQuery() {
    return new URLSearchParams({ location: byId('location').value, dateFrom: byId('from').value, dateTo: byId('to').value,
      status: byId('state').value, name: byId('name').value, search: byId('search').value.trim() }).toString();
  }
  async function load(reset = false) {
    if (reset) page = 1;
    const seq = ++loadSequence, current = selectedQuery();
    byId('status').textContent = 'Leyendo pedidos y comentarios…'; byId('export').disabled = true;
    try {
      const data = await request(`/api/sales/gender-review?${current}&page=${page}`);
      if (seq !== loadSequence) return;
      query = current; categories = data.categories;
      byId('summary').replaceChildren(...[['Pedidos del período', data.summary.total], ['Pendientes', data.summary.pending], ['Con asignación M/F', data.summary.assigned], ['Revisados', data.summary.reviewed]].map(([label, value]) => {
        const card = element('div', null, 'recurrence-kpi'); card.append(element('h4', label), element('strong', value.toLocaleString('es-CL'))); return card;
      }));
      const body = byId('body'); body.replaceChildren();
      for (const row of data.rows) {
        const tr = element('tr'), place = element('td', row.date); place.append(element('small', row.location));
        const name = element('td', row.name || '—'); name.append(element('small', data.nameStates[row.nameStatus]), element('small', row.nameReason));
        if (row.suggestion) name.append(element('small', `Sugerencia para revisar: ${row.suggestion}`));
        const state = element('td', data.reviewStates[row.reviewState]);
        if (row.reviewedAt) state.append(element('small', [row.reviewer, new Date(row.reviewedAt).toLocaleString('es-CL')].filter(Boolean).join(' · ')));
        if (row.note) state.append(element('small', row.note));
        const history = element('details'), summary = element('summary', 'Historial'); history.append(summary);
        let historyLoaded = false;
        history.addEventListener('toggle', async () => {
          if (!history.open || historyLoaded) return; historyLoaded = true;
          const content = element('div', 'Cargando…'); history.append(content);
          try {
            const data = await request(`/api/sales/gender-review/history?${new URLSearchParams({ location: row.locationId, orderId: row.orderId })}`);
            content.replaceChildren(...data.entries.map(entry => element('p', [new Date(entry.at).toLocaleString('es-CL'), entry.reviewer, categories[entry.category], entry.filename, entry.note].filter(Boolean).join(' · '))));
            if (!data.entries.length) content.textContent = 'Sin revisiones manuales.';
          } catch (error) { content.textContent = error.message; historyLoaded = false; }
        });
        state.append(history);
        tr.append(place, element('td', row.orderId), element('td', row.comment || 'Sin comentario', 'gender-review-comment'), name, element('td', categories[row.category]), state); body.append(tr);
      }
      if (!data.rows.length) { const tr = element('tr'), td = element('td', 'No hay pedidos con estos filtros.'); td.colSpan = 6; tr.append(td); body.append(tr); }
      byId('status').textContent = `${data.total.toLocaleString('es-CL')} registros encontrados.${data.warnings.length ? ` ${data.warnings.join(' ')}` : ''}`;
      byId('page').textContent = `Página ${page} de ${Math.max(1, Math.ceil(data.total / data.limit))}`;
      byId('prev').disabled = page <= 1; byId('next').disabled = page * data.limit >= data.total;
      byId('export').disabled = data.total === 0;
    } catch (error) { if (seq === loadSequence) byId('status').textContent = error.message; }
  }
  function clearPreview() { preview = null; byId('preview').hidden = true; }
  function errors(error) {
    byId('import-status').textContent = error.message;
    byId('errors').replaceChildren(...(error.details || []).map(text => element('p', text)));
    byId('errors').hidden = !error.details?.length;
  }
  byId('filters').addEventListener('submit', event => { event.preventDefault(); load(true); });
  byId('all-history').addEventListener('click', () => { byId('from').value = ''; byId('to').value = ''; load(true); });
  byId('prev').addEventListener('click', () => { page--; load(); });
  byId('next').addEventListener('click', () => { page++; load(); });
  byId('export').addEventListener('click', async () => {
    byId('export').disabled = true;
    try {
      const response = await fetch(`/api/sales/gender-review/export?${query}`);
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob()), link = element('a');
      link.href = url; link.download = 'revision-genero-ventas.xlsx'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { byId('status').textContent = error.message; }
    finally { byId('export').disabled = false; }
  });
  byId('upload').addEventListener('submit', async event => {
    event.preventDefault(); clearPreview(); byId('errors').hidden = true;
    byId('preview-button').disabled = true; byId('file').disabled = true; byId('import-status').textContent = 'Validando la planilla…';
    try {
      const body = new FormData(); body.append('file', byId('file').files[0]);
      const data = await request('/api/sales/gender-review/import/preview', { method: 'POST', body }); preview = data;
      byId('preview-file').textContent = `Archivo: ${data.filename}`;
      const assignmentLabel = data.changes === 1 ? 'asignación' : 'asignaciones';
      byId('preview-summary').textContent = `${data.changes} ${assignmentLabel} para aplicar · ${data.unchanged} ya aplicadas · ${data.skipped} filas sin asignación, que se conservarán sin cambios.`;
      byId('preview-categories').replaceChildren(...Object.entries(data.assignments).map(([key, count]) => {
        const card = element('div', null, 'recurrence-kpi'); card.dataset.category = key;
        card.append(element('h4', data.categories[key]), element('strong', count.toLocaleString('es-CL'))); return card;
      }));
      byId('preview').hidden = false; byId('apply').disabled = data.changes === 0;
      byId('apply').textContent = `Confirmar ${data.changes} ${assignmentLabel}`;
      byId('import-status').textContent = data.changes ? 'Archivo validado. Confirma el resumen para aplicar las asignaciones.' : 'El archivo no requiere cambios.';
    } catch (error) { errors(error); }
    finally { byId('preview-button').disabled = false; byId('file').disabled = false; }
  });
  byId('apply').addEventListener('click', async () => {
    if (!preview) return;
    byId('apply').disabled = true; byId('cancel').disabled = true; byId('file').disabled = true; byId('preview-button').disabled = true;
    try {
      const data = await request('/api/sales/gender-review/import/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: preview.id }) });
      clearPreview(); byId('file').value = ''; byId('import-status').textContent = `${data.applied} asignaciones guardadas. Los reportes utilizarán estas revisiones al generarse nuevamente.`;
      window.dispatchEvent(new CustomEvent('sales-gender-updated')); await load(true);
    } catch (error) { errors(error); byId('apply').disabled = false; }
    finally { byId('cancel').disabled = false; byId('file').disabled = false; byId('preview-button').disabled = false; }
  });
  byId('cancel').addEventListener('click', () => { clearPreview(); byId('import-status').textContent = 'Vista previa cancelada. No se aplicaron cambios.'; });
  byId('file').addEventListener('change', () => { clearPreview(); byId('import-status').textContent = ''; byId('errors').hidden = true; });
  window.openGenderReview = async () => {
    if (!initialized) {
      byId('status').textContent = 'Preparando revisión de ventas…';
      try {
        const data = await request('/api/sales/gender-review/options');
        byId('location').replaceChildren(...[{ id: 'all', name: 'Todas las cafeterías' }, ...data.locations].map(location => { const option = element('option', location.name); option.value = location.id; return option; }));
        const date = new Date(`${data.today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - 1); byId('to').value = date.toISOString().slice(0, 10);
        date.setUTCDate(date.getUTCDate() - 27); byId('from').value = date.toISOString().slice(0, 10); initialized = true;
      } catch (error) { byId('status').textContent = error.message; return; }
    }
    await load(true);
  };
})();
