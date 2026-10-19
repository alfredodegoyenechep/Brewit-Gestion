const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { extract, differences, hash, stable } = require('./historical-adapters');
const day = timestamp => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago' }).format(new Date(timestamp));
const read = file => JSON.parse(fs.readFileSync(file));
const gzipRead = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
function write(file, object, compressed = false) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, compressed ? zlib.gzipSync(JSON.stringify(object)) : JSON.stringify(object), { mode: 0o600 }); fs.renameSync(temp, file);
}
const inRange = (date, range) => date && range && date >= range.from && date <= range.to;
function compare(previous, incoming, { master, now, runId, previousRunId, complete, ranges }) {
  const state = structuredClone(previous || { records: {}, coverage: [], seen: false });
  const stored = new Map(Object.entries(state.records));
  const changes = [], ambiguousIds = new Set(incoming.ambiguous.map(r => r.id).filter(Boolean));
  const records = new Map(incoming.records.map(r => [r.id, r]));
  const summary = { modified: 0, deleted: 0, historicalAdded: 0, growth: 0, masterAdded: 0, ambiguous: incoming.ambiguous.length };
  const hadBaseline = state.seen;
  const emit = (type, record, before) => {
    summary[type]++;
    changes.push({ type, id: record.id, operationDate: record.date, previousDate: before?.date || null,
      warehouse: record.warehouse, warehouses:[...new Set([...(record.warehouses || []),...(before?.warehouses || [])])], detectedAt: now, previousRunId: before?.version || previousRunId || null, runId,
      fields: differences(before?.fields, type === 'deleted' ? undefined : record.fields) });
  };
  for (const record of records.values()) {
    const before = stored.get(record.id);
    if (before && !before.deleted) {
      if (stable(before.fields) !== stable(record.fields)) emit('modified', record, before);
    } else if (hadBaseline) {
      if (master) emit('masterAdded', record, null);
      else if (record.date && record.date < day(now) && state.coverage.some(r => inRange(record.date, r))) emit('historicalAdded', record, null);
      else if (record.date) summary.growth++;
    }
    stored.set(record.id, { ...record, version: runId });
  }
  // Unknown identities can conceal an existing record: do not certify deletions
  // for a partition containing any unresolved identity.
  if (complete && !incoming.ambiguous.length) for (const before of stored.values()) {
    if (!before.deleted && !records.has(before.id) && !ambiguousIds.has(before.id) && (master || ranges.some(r => inRange(before.date, r)))) {
      emit('deleted', before, before); stored.set(before.id, { ...before, deleted: true, version: runId });
    }
  }
  if (complete && !incoming.ambiguous.length) state.coverage.push(...ranges);
  else for (const record of records.values()) if (record.date) state.coverage.push({ from: record.date, to: record.date });
  state.coverage = mergeRanges(state.coverage);
  state.seen = state.seen || records.size > 0 || (complete && !incoming.ambiguous.length);
  state.records = Object.fromEntries(stored);
  return { state, changes, summary, status: incoming.ambiguous.length || !complete ? 'partial' : !hadBaseline ? 'baseline' : 'complete' };
}
function mergeRanges(ranges) {
  const result = [];
  for (const range of ranges.filter(r => r?.from && r?.to).sort((a, b) => a.from.localeCompare(b.from))) {
    const last = result.at(-1);
    if (last && range.from <= new Date(Date.parse(last.to + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)) last.to = last.to > range.to ? last.to : range.to;
    else result.push({ ...range });
  }
  return result;
}
function processRun(root, id) {
  const directory = path.join(root, 'runs', id), manifest = read(path.join(directory, 'manifest.json'));
  const prior = fs.readdirSync(path.join(root, 'runs')).filter(n => n !== id).map(n => {
    try { return read(path.join(root, 'runs', n, 'manifest.json')); } catch { return null; }
  }).filter(m => m?.comparison === 'done' && !m.antecedent && (m.completionSequence || m.sequence) < (manifest.completionSequence || manifest.sequence))
    .sort((a, b) => (a.completionSequence || a.sequence) - (b.completionSequence || b.sequence));
  const partitions = new Map(), warehouseNames = {};
  for (const artifact of manifest.artifacts) for (const source of artifact.datasets || []) {
    if (!source.dataset) continue;
    const scope = { location: source.location || manifest.location || 'shared', warehouse: source.warehouse || '*' };
    const origin=artifact.origin || manifest.origin;
    const key = hash([origin, manifest.upstream || null, source.dataset, scope]);
    let partition = partitions.get(key);
    if (!partition) { partition = { key, origin, dataset: source.dataset, ...scope, master: source.master, complete: true, ranges: [], records: [], ambiguous: [], count: 0 }; partitions.set(key, partition); }
    const bytes = zlib.gunzipSync(fs.readFileSync(path.join(directory, artifact.id + '.gz')));
    if (require('node:crypto').createHash('sha256').update(bytes).digest('hex') !== artifact.hash) throw Error('El respaldo no superó la verificación de integridad.');
    const extracted = extract(bytes, artifact, source);
    if (source.dataset === 'warehouses') for (const record of extracted.records) {
      const label = record.fields.name?.translations?.default || record.fields.name || record.fields.custom_id || record.id;
      warehouseNames[record.id] = String(label);
      if (record.fields.custom_id != null) warehouseNames[String(record.fields.custom_id)] = String(label);
    }
    source.recordCount = extracted.count;
    const dates = extracted.records.map(r=>r.date).filter(Boolean).sort();
    source.receivedRange = dates.length ? {from:dates[0],to:dates.at(-1)} : null;
    partition.records.push(...extracted.records); partition.ambiguous.push(...extracted.ambiguous); partition.count += extracted.count;
    partition.complete &&= source.complete === true;
    if (source.range) partition.ranges.push(source.range);
  }
  const report = { runId: id, detectedAt: new Date().toISOString(), sources: [] }, states = {};
  for (const partition of partitions.values()) {
    let previous = null, previousRunId = null;
    for (let i = prior.length - 1; i >= 0; i--) {
      if (prior[i].sourceKeys?.includes(partition.key)) {
        previousRunId = prior[i].id;
        previous = gzipRead(path.join(root, 'runs', previousRunId, 'state.json.gz'))[partition.key]; break;
      }
    }
    // Repeated windows may repeat an identical document. Conflicting instances
    // stay ambiguous; no version is chosen by ordering.
    const unique = new Map();
    for (const r of partition.records) {
      if (unique.has(r.id) && stable(unique.get(r.id).fields) !== stable(r.fields)) partition.ambiguous.push({ id: r.id, reason: 'Versiones incompatibles en la misma recepción' });
      else unique.set(r.id, r);
    }
    for (const r of partition.ambiguous) if (r.id) unique.delete(r.id);
    partition.records = [...unique.values()];
    const result = compare(previous, partition, { ...partition, now: report.detectedAt, runId: id, previousRunId });
    states[partition.key] = result.state;
    report.sources.push({ key: partition.key, origin:partition.origin, dataset: partition.dataset, location: partition.location, warehouse: partition.warehouse,
      warehouses:[...new Set([...partition.records.flatMap(r=>r.warehouses || []),...result.changes.flatMap(r=>r.warehouses || [])])],
      previousRunId, ranges: mergeRanges(partition.ranges), recordCount: partition.count, summary: result.summary, status: result.status,
      changes: result.changes, ambiguous: partition.ambiguous });
  }
  for (const source of report.sources) source.warehouseNames=Object.fromEntries(source.warehouses.filter(id=>warehouseNames[id]).map(id=>[id,warehouseNames[id]]));
  write(path.join(directory, 'state.json.gz'), states, true);
  write(path.join(directory, 'report.json.gz'), report, true);
  manifest.sourceKeys = [...partitions.keys()]; manifest.comparison = 'done'; manifest.comparisonError = null;
  manifest.summaries = report.sources.map(({ changes, ambiguous, ...source }) => source);
  manifest.comparedAt = report.detectedAt;
  write(path.join(directory, 'manifest.json'), manifest);
  return id;
}
if (parentPort) {
  try { parentPort.postMessage({ ok: true, id: processRun(workerData.root, workerData.id) }); }
  catch { parentPort.postMessage({ ok: false, error: 'No se completó la comparación; el respaldo permanece disponible.' }); }
}
module.exports = { compare, mergeRanges, processRun };
