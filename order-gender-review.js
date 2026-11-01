const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { VERSION, hash, analyzeOrderComments } = require('./order-comment-analysis');
const CATEGORIES = { masculine: 'Masculino', feminine: 'Femenino', unattributable: 'No atribuible', missing: 'Sin información' };
const NAME_STATES = { recognized: 'Nombre reconocido', pending: 'Nombre por revisar', ambiguous: 'Nombre ambiguo', absent: 'Sin nombre' };
function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function failure(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function createGenderReviewStore(uploadsRoot) {
  const root = path.join(uploadsRoot, 'reports', '.order-comments'), file = path.join(root, 'reviews.json');
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, revision: '0', current: {}, batches: [] };
  const analyses = new Map();
  function enrich(orders) {
    const state = read();
    for (const order of orders) {
      const comments = [...new Set((order.paymentComments || [order.paymentComment || '']).map(String))];
      const sourceValues = [...new Set(order.sourceGenderValues || [])].sort();
      // Immutable content-addressed analyses reuse repeated comments, rather than
      // copying the entire sales history on every source publication.
      const key = hash([VERSION, comments, sourceValues]);
      let base = analyses.get(key);
      if (!base) {
        const target = path.join(root, 'analyses', `${key}.json`);
        if (fs.existsSync(target)) base = JSON.parse(fs.readFileSync(target, 'utf8'));
        else {
          const { sourceHash, sourceEvidence, ...result } = analyzeOrderComments({ paymentComments: comments, sourceGenderValues: sourceValues });
          base = result; atomic(target, base);
        }
        if (analyses.size >= 5000) analyses.delete(analyses.keys().next().value);
        analyses.set(key, base);
      }
      const analysis = { ...base, sourceHash: hash([order.orderKey, comments, sourceValues]), sourceEvidence: order.commentEvidence || [] };
      const previous = state.current[order.orderKey], current = previous?.sourceHash === analysis.sourceHash ? previous : null;
      const category = current?.category || (analysis.gender || (analysis.genderStatus === 'ambiguous' ? 'unattributable' : 'missing'));
      const assigned = ['masculine', 'feminine'].includes(category);
      order.commentAnalysis = analysis;
      order.genderReview = { category, state: current ? 'reviewed' : previous ? 'stale' : assigned ? 'source' : 'pending',
        revision: previous?.id || '0', name: current?.name || analysis.name.normalizedName, reviewer: current?.reviewer || '',
        reviewedAt: current?.at || '', note: current?.note || '', origin: current ? 'manual' : analysis.genderOrigin };
      order.declaredGender = assigned ? category : 'unknown';
      order.validatedGender = assigned ? category : null;
      order.genderBasis = current ? 'manual' : assigned ? 'explicit' : null;
      order.genderAmbiguous = category === 'unattributable';
      order.mode = analysis.mode.key; order.modeAmbiguous = analysis.mode.ambiguous;
    }
    return orders;
  }
  function fingerprint() { return hash([VERSION, read().revision]); }
  function commit(changes, { reviewer = '', filename, fileHash }) {
    const state = read(), id = crypto.randomUUID(), at = new Date().toISOString();
    // The route validates source and review tokens synchronously immediately before this call.
    const entries = changes.map(change => {
      const previous = state.current[change.orderKey] || null;
      const next = { id: crypto.randomUUID(), sourceHash: change.sourceHash, category: change.category, name: change.name,
        note: change.note, comment: change.comment, reviewer, at, batchId: id };
      state.current[change.orderKey] = next;
      return { orderKey: change.orderKey, previous, next };
    });
    if (entries.length) {
      state.revision = id;
      state.batches.push({ id, at, reviewer, filename, fileHash, entries });
      atomic(file, state);
    }
    return { id: entries.length ? id : null, applied: entries.length, at };
  }
  function history(key) {
    return read().batches.flatMap(batch => batch.entries.filter(e => e.orderKey === key).map(e => ({ ...e.next, filename: batch.filename })));
  }
  return { enrich, fingerprint, commit, history, read, root };
}
module.exports = { CATEGORIES, NAME_STATES, createGenderReviewStore, failure };
