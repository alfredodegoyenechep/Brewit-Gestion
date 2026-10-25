const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('./record-store').fs;
const records = require('./record-store');
const XLSX = require('./record-workbooks');
const { businessClock, addDays } = require('./network-sales');
const { validDate, lastCompleteDay, resolvePeriod, effectiveCutoff } = require('./recurrence');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function createRecurrenceSource({ uploadsRoot, storesFor, filesFor, ordersFor, manifests, today, cutoff }) {
  const fileIdentity = file => { try { const stat = fs.statSync(file.filePath); return [file.filePath, records.descriptor(file.filePath)?.blob || null, stat.size, stat.mtimeMs, file.excludedRanges]; } catch { return [file.filePath, 'missing']; } };
  const history = () => manifests().filter(run => run.publication === 'published' && run.reception === 'complete' && !run.antecedent);
  function coverage(stores) {
    const selected = new Set(stores.map(s => s.id)), now = today(), output = [];
    for (const run of history()) for (const artifact of run.artifacts || []) for (const dataset of artifact.datasets || []) {
      if (!selected.has(dataset.location) || !['mercadopago', 'sales', 'payment-details'].includes(dataset.dataset) || !dataset.complete) continue;
      const range = dataset.range;
      if (!validDate(range?.from) || !validDate(range?.to) || range.from > range.to || !Number.isFinite(Date.parse(artifact.receivedAt || run.finishedAt))) continue;
      const received = businessClock(new Date(artifact.receivedAt || run.finishedAt)).today;
      const to = [range.to, addDays(received, -1), addDays(now, -1)].sort()[0];
      const receipt = businessClock(new Date(artifact.receivedAt || run.finishedAt));
      const through = [`${range.to}T23:59:59`, `${receipt.today}T${receipt.cutoff}`, `${now}T${cutoff()}`].sort()[0];
      output.push({ locationId: dataset.location, source: dataset.dataset, from: range.from, to: to >= range.from ? to : range.from,
        complete: to >= range.from, through, evidenceId: `${run.id}/${artifact.id}`, checkedAt: artifact.receivedAt || run.finishedAt });
    }
    // API source ranges are explicit successful snapshots; imported row ranges are not coverage evidence.
    for (const store of stores) for (const field of ['sales', 'payment-details']) for (const file of filesFor(store.id, field)) {
      if (file.record.origin !== 'toteat-api') continue;
      const range = file.record.confirmedRange, saved = file.record.savedAt;
      if (!validDate(range?.from) || !validDate(range?.to) || !saved) continue;
      const to = [range.to, addDays(businessClock(new Date(saved)).today, -1), addDays(now, -1)].sort()[0];
      if (to >= range.from) output.push({ locationId: store.id, source: field, from: range.from, to, complete: true, evidenceId: file.sourceId, checkedAt: saved });
    }
    return output;
  }
  function fingerprint(query) {
    const stores = storesFor(query.location || 'all');
    const selected = new Set(stores.map(s => s.id));
    const evidence = history().flatMap(run => (run.artifacts || []).flatMap(a => (a.datasets || []).filter(d => selected.has(d.location)).map(d => ({ source: d.dataset, data: [run.id, a.id, a.receivedAt || run.finishedAt, d] }))));
    const mp = [], purchases = [];
    for (const store of stores) for (const field of ['mercadopago', 'sales', 'payment-details']) for (const file of filesFor(store.id, field)) (field === 'mercadopago' ? mp : purchases).push(fileIdentity(file));
    const masterRoot = path.join(uploadsRoot, 'masters');
    if (fs.existsSync(masterRoot)) for (const name of fs.readdirSync(masterRoot).sort()) {
      const file = path.join(masterRoot, name); try { const stat = fs.statSync(file); if (stat.isFile()) purchases.push([name, stat.mtimeMs, stat.size]); } catch {}
    }
    return { mp: hash([stores, mp, evidence.filter(r => r.source === 'mercadopago'), today()]),
      purchases: hash([purchases, evidence.filter(r => r.source !== 'mercadopago')]) };
  }
  function readSource(query) {
    const stores = storesFor(query.location || 'all'), rows = [], warnings = [], unavailable = new Set();
    for (const store of stores) if (!filesFor(store.id, 'mercadopago').length) unavailable.add(store.id);
    for (const store of stores) for (const file of filesFor(store.id, 'mercadopago')) {
      try {
        const book = XLSX.readFile(file.filePath, { cellDates: true });
        for (const name of book.SheetNames) {
          const matrix = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: null, raw: true });
          const index = matrix.findIndex(row => row.some(h => String(h || '').trim().toUpperCase() === 'TRANSACTION_DATE'));
          if (index < 0) { unavailable.add(store.id); warnings.push(`Se omitió una hoja sin encabezados MercadoPago (${store.name}).`); continue; }
          const headers = matrix[index].map(h => String(h || '').trim().toUpperCase());
          for (const values of matrix.slice(index + 1)) {
            if (!values.some(v => v !== null && v !== '')) continue;
            const data = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
            const local = require('./recurrence').localTimestamp(data.TRANSACTION_DATE), date = local?.slice(0, 10);
            if (date && (file.excludedRanges || []).some(r => date >= r.from && date <= r.to)) continue;
            rows.push({ locationId: store.id, data, observedAt: file.record.savedAt, source: file.record.source || file.record.origin });
          }
        }
      } catch { unavailable.add(store.id); warnings.push(`No se pudo leer un archivo MercadoPago de ${store.name}.`); }
    }
    const evidence = coverage(stores);
    for (const store of stores) if (unavailable.has(store.id) && evidence.some(c => c.locationId === store.id && c.source === 'mercadopago')) warnings.push(`No se puede acreditar continuidad con archivos MP ausentes o ilegibles (${store.name}).`);
    return { records: rows, locationIds: stores.map(s => s.id), scope: { location: query.location || 'all', label: query.location && query.location !== 'all' ? stores[0].name : 'Todas las cafeterías', locations: stores.map(s => ({ id: s.id, name: s.name })) },
      secret: process.env.BREWIT_PSEUDONYM_SECRET || `brewit-local:${path.resolve(uploadsRoot)}`, today: today(), cutoff: cutoff(), coverage: evidence.map(c => c.source === 'mercadopago' && unavailable.has(c.locationId) ? { ...c, complete: false, through: null } : c), warnings };
  }
  function cacheCutoff(query) {
    const now = today(), ids = storesFor(query.location || 'all').map(s => s.id), cov = coverage(storesFor(query.location || 'all'));
    const end = query.period === 'custom' ? query.dateTo : query.period && query.period !== 'last-28-days' ? now : addDays(now, -1);
    const D = lastCompleteDay(cov, ids, end, now), period = resolvePeriod(query, now, D);
    const requested = period.to < now ? `${period.to}T23:59:59` : `${now}T${query.serverCutoff || cutoff()}`;
    return { D, period, asOf: effectiveCutoff(cov, ids, requested) };
  }
  return { readSource, fingerprint, cacheCutoff, readOrders: ordersFor };
}
module.exports = { createRecurrenceSource };
