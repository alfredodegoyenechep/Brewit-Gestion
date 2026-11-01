(() => {
  'use strict';
  const root = document.getElementById('board-reports'); if (!root) return;
  const $ = id => root.querySelector(`#board-${id}`); const deck = window.BrewitBoardDeck;
  let report = null, index = 0, job = null, timer = null, opening = false;
  async function api(url, options) { const r = await fetch(url, options); const data = await r.json(); if (!r.ok) throw Error(data.error || 'No se pudo completar la operación.'); return data; }
  function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
  async function archive() {
    const data = await api(`/api/board-reports?month=${encodeURIComponent($('month').value)}`);
    $('versions').replaceChildren(new Option('Versiones guardadas', ''), ...data.versions.map(v => new Option(`${new Date(v.createdAt).toLocaleString('es-CL')} · ${v.pages} páginas · ${v.id.slice(0, 8)}`, v.id)));
    const running = data.jobs.find(j => j.month === $('month').value); if (running && !job) { job = running.id; busy(true); poll(); }
  }
  function busy(value) { $('generate').disabled = value; $('cancel').hidden = !value; $('progress').hidden = !value; $('month').disabled = value; }
  function showPage(next = index) {
    if (!report) return; index = Math.max(0, Math.min(report.deck.pages.length - 1, next)); const page = report.deck.pages[index];
    $('slide').innerHTML = deck.svg(page); $('page').textContent = `${index + 1} / ${report.deck.pages.length}`; $('previous').disabled = index === 0; $('next').disabled = index === report.deck.pages.length - 1;
    for (const b of $('thumbnails').children) b.setAttribute('aria-current', Number(b.dataset.index) === index ? 'page' : 'false');
    if ($('dialog').open) { $('large-slide').innerHTML = deck.svg(page); $('large-page').textContent = `${index + 1} / ${report.deck.pages.length}`; }
  }
  function loadReport(data) {
    report = data; index = 0; $('viewer').hidden = false; $('exports').hidden = false; $('versions').value = data.id;
    $('pdf').href = `/api/board-reports/${data.id}/export?format=pdf`; $('pptx').href = `/api/board-reports/${data.id}/export?format=pptx`;
    $('thumbnails').replaceChildren(...data.deck.pages.map((p, i) => { const b = document.createElement('button'); b.type = 'button'; b.dataset.index = i; b.textContent = `${i + 1}. ${p.section}`; b.title = p.title; b.onclick = () => showPage(i); return b; }));
    $('notes').replaceChildren();
    const add = text => { const p = document.createElement('p'); p.textContent = text; $('notes').append(p); };
    add(`Versión ${data.id} · fuentes ${data.sourceVersion} · ${data.rules.version}`);
    data.criteria.forEach(add); data.warnings.forEach(add);
    data.sources.forEach(s => add(`${s.kind} · ${s.location || ''} · ${s.name || s.version || ''}${s.range ? ' · ' + JSON.stringify(s.range) : ''}`));
    const download = document.createElement('a'); download.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); download.download = `Brewit-cierre-${data.month}-${data.id.slice(0, 8)}.json`; download.textContent = 'Descargar datos y evidencia de esta versión'; $('notes').append(download);
    status(`Versión guardada: ${data.deck.pages.length} páginas, ${data.locations.length} cafetería(s). Las nuevas fuentes no reemplazan este cierre.`); showPage();
  }
  async function poll() {
    clearTimeout(timer); if (!job) return;
    try { const state = await api(`/api/board-reports/jobs/${job}`); $('progress').value = state.progress; status(`${state.message || state.status} · ${Math.round(state.progress)}%`);
      if (state.status === 'complete') { job = null; busy(false); await archive(); loadReport(await api(`/api/board-reports/${state.reportId}`)); }
      else if (['failed', 'cancelled'].includes(state.status)) { job = null; busy(false); status(state.error || 'Generación cancelada.', state.status === 'failed'); }
      else timer = setTimeout(poll, 1800);
    } catch (e) { status(e.message, true); timer = setTimeout(poll, 5000); }
  }
  $('form').addEventListener('submit', async e => { e.preventDefault(); busy(true); status('Enviando cierre a la cola…'); try { const data = await api('/api/board-reports/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month: $('month').value }) }); job = data.id; poll(); } catch (e) { busy(false); status(e.message, true); } });
  $('cancel').onclick = async () => { if (!job) return; try { await api(`/api/board-reports/jobs/${job}`, { method: 'DELETE' }); await poll(); } catch (e) { status(e.message, true); } };
  $('month').onchange = () => { $('viewer').hidden = true; $('exports').hidden = true; status('Selecciona una versión guardada o genera un nuevo cierre.'); archive().catch(e => status(e.message, true)); };
  $('versions').onchange = async () => { if (!$('versions').value) return; try { loadReport(await api(`/api/board-reports/${$('versions').value}`)); } catch (e) { status(e.message, true); } };
  $('previous').onclick = () => showPage(index - 1); $('next').onclick = () => showPage(index + 1);
  $('present').onclick = () => { $('dialog').showModal(); showPage(); };
  $('close').onclick = () => $('dialog').close(); $('large-previous').onclick = () => showPage(index - 1); $('large-next').onclick = () => showPage(index + 1);
  $('dialog').addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); showPage(index + 1); } if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); showPage(index - 1); } });
  window.openBoardReport = async () => {
    if (opening) return; opening = true;
    try { const data = await api('/api/board-reports/options'); const selected = $('month').value; $('month').replaceChildren(...data.months.map(m => new Option(deck.monthName(m), m))); if (data.months.includes(selected)) $('month').value = selected; await archive(); }
    catch (e) { status(e.message, true); } finally { opening = false; }
  };
})();
