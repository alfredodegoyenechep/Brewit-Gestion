const crypto = require('node:crypto');
const engine = require('./recurrence');
const purchaseHistory = require('./recurrence-history');
const error = (status, message) => Object.assign(new Error(message), { status });
function createRecurrenceService({ readSource, fingerprint, readOrders, cacheCutoff, clock = Date.now, ttl = 3600000, limit = 8 }) {
  const reports = new Map();
  const entryFor = (id, owner) => {
    const entry = reports.get(id);
    if (!entry || entry.owner !== owner) throw error(404, 'El reporte no existe para esta sesión.');
    if (entry.expires <= clock()) { reports.delete(id); throw error(410, 'El reporte venció. Pulsa Generar reportes para volver a consultarlo.'); }
    return entry;
  };
  const unchanged = (entry, purchases = false) => {
    const current = fingerprint(entry.query);
    if (current.mp !== entry.versions.mp || (purchases && current.purchases !== entry.versions.purchases)) throw error(409, 'Las fuentes cambiaron desde la generación del reporte. Pulsa Generar reportes para trabajar con una versión coherente.');
  };
  async function request(action, input = {}, owner = 'local') {
    if (action === 'generate') {
      const versions = fingerprint(input), networkVersion = fingerprint({ ...input, location: 'all' }).mp, cacheInput = { ...input };
      // The request clock does not change closed historical windows. Current periods retain their exact cutoff.
      if (cacheCutoff || !input.period || input.period === 'last-28-days' || (input.period === 'custom' && input.dateTo < (input.serverToday || new Date(clock()).toISOString().slice(0, 10)))) delete cacheInput.serverCutoff;
      const key = JSON.stringify([owner, cacheInput, versions, engine.VERSION, purchaseHistory.VERSION, networkVersion, cacheCutoff?.(input)]);
      for (const [id, entry] of reports) { if (entry.expires <= clock()) reports.delete(id); else if (entry.cacheable && entry.key === key) return { ...entry.public, returns: entry.initialReturns }; }
      const source = readSource(input), state = engine.buildReport(source, input);
      const after = fingerprint(input);
      if (after.mp !== versions.mp) throw error(409, 'Las fuentes cambiaron durante el cálculo. Vuelve a generar el reporte.');
      const id = crypto.randomUUID(), data = { ...state.report, id, dataVersion: versions.mp, sourceVersions: { ...versions, networkMp: networkVersion } };
      const entry = { owner, key, cacheable: !(source.warnings || []).length, networkVersion, query: { ...input, location: input.location || 'all' }, versions, state, public: data, sections: {}, expires: clock() + ttl };
      // MP-only sections are prepared in the same snapshot. No Toteat join on entry.
      entry.sections.return = engine.validationForCohorts(engine.buildCohorts(state.histories, source.coverage, source.locationIds, data.cohortDefaults), data.eligibilityPartial);
      entry.sections.return.selectionKey = JSON.stringify([entry.sections.return.from, entry.sections.return.to, entry.sections.return.granularity, entry.sections.return.commonBase]);
      entry.initialReturns = entry.sections.return;
      entry.preparedReturns = new Map([[entry.initialReturns.selectionKey, entry.initialReturns]]);
      entry.sourceCoverage = source.coverage;
      entry.sections.quality = { ...data.quality, scope: data.scope, period: data.period, warnings: data.warnings, fieldMapping: data.fieldMapping };
      while (reports.size >= limit) reports.delete(reports.keys().next().value);
      reports.set(id, entry);
      return { ...data, returns: entry.initialReturns };
    }
    const entry = entryFor(input.id, owner);
    if (action === 'summary') return { ...entry.public, returns: entry.initialReturns };
    if (action === 'return') {
      unchanged(entry);
      const args = { ...entry.public.cohortDefaults, ...input, D: entry.public.observationDay };
      const result = engine.validationForCohorts(engine.buildCohorts(entry.state.histories, entry.sourceCoverage, entry.public.locationIds, args), entry.public.eligibilityPartial);
      result.selectionKey = JSON.stringify([result.from, result.to, result.granularity, result.commonBase]);
      entry.preparedReturns.set(result.selectionKey, result);
      while (entry.preparedReturns.size > 24) entry.preparedReturns.delete([...entry.preparedReturns.keys()].find(key => key !== entry.initialReturns.selectionKey));
      return result;
    }
    if (action === 'monthly') {
      if (!entry.sections.monthly) { unchanged(entry); entry.sections.monthly = purchaseHistory.monthlyHistory(entry.state, entry.sourceCoverage); }
      return entry.sections.monthly;
    }
    if (action === 'network') {
      if (!entry.sections.network) {
        const query = { ...entry.query, location: 'all' };
        const verify = () => { if (fingerprint(query).mp !== entry.networkVersion) throw error(409, 'Las fuentes MP de la red cambiaron. Pulsa Generar reportes antes de preparar los cruces entre cafeterías.'); };
        unchanged(entry); verify();
        const source = readSource(query);
        const data = purchaseHistory.networkHistory(source, entry.public);
        verify(); unchanged(entry);
        entry.sections.network = { ...data, dataVersion: entry.networkVersion };
      }
      return entry.sections.network;
    }
    if (action === 'purchases' || action === 'quality') {
      if (!entry.sections.purchases) {
        unchanged(entry, true);
        const data = readOrders(entry.query, entry.public.period);
        unchanged(entry, true);
        entry.sections.purchases = engine.buildPurchases(entry.state, data.orders, entry.sourceCoverage);
        if (data.warnings?.length) entry.sections.purchases.status = 'partial';
        entry.sections.quality = { ...entry.sections.quality, purchases: entry.sections.purchases.quality,
          linkage: entry.sections.purchases.linkage, unclassified: entry.sections.purchases.reasons,
          purchaseCoverage: entry.sections.purchases.coverage, paymentCoverage: entry.sections.purchases.paymentCoverage, purchaseBasis: entry.sections.purchases.monetaryBasis,
          warnings: [...new Set([...entry.sections.quality.warnings, ...(data.warnings || [])])] };
      }
      return entry.sections[action];
    }
    if (action === 'details') {
      const kind = input.kind || 'active';
      if (!['active', 'return', 'purchases'].includes(kind)) throw error(400, 'Selecciona un detalle válido.');
      if (kind === 'purchases' && !entry.sections.purchases) await request('purchases', input, owner);
      const rows = kind === 'purchases' ? entry.sections.purchases.details : engine.paymentDetails(entry.state, kind);
      const page = Math.max(1, Math.floor(Number(input.page) || 1)), pageSize = 50;
      return { id: input.id, definitionVersion: engine.VERSION, scope: entry.public.scope, period: entry.public.period, asOf: entry.public.asOf,
        page, pageSize, total: rows.length, rows: rows.slice((page - 1) * pageSize, page * pageSize) };
    }
    if (action === 'export') {
      // Export the displayed, already-prepared cohort selection; never trigger new calculations.
      const returns = input.cohortKey ? entry.preparedReturns.get(input.cohortKey) : entry.initialReturns;
      if (!returns) throw error(409, 'La selección de Retorno ya no está preparada. Genera el retorno de nuevo antes de exportar.');
      return { summary: entry.public, returns, monthly: entry.sections.monthly || null, network: entry.sections.network || null,
        purchases: entry.sections.purchases ? { ...entry.sections.purchases, details: undefined } : null,
        quality: entry.sections.quality, paymentDetails: engine.paymentDetails(entry.state),
        purchaseDetails: entry.sections.purchases?.details || null };
    }
    throw error(400, 'Sección de recurrencia no válida.');
  }
  return { request, dispose() { reports.clear(); } };
}
function registerRecurrenceRoutes(app, service) {
  const owner = req => req.actor?.id || 'local';
  const run = action => async (req, res) => {
    try {
      const input = { ...req.query, ...req.params };
      if (input.commonBase !== undefined) input.commonBase = input.commonBase === 'true';
      res.set('Cache-Control', 'no-store');
      const result = await service.request(action || req.params.section, input, owner(req));
      return res.json(result);
    } catch (e) { return res.status(e.status || 500).json({ error: e.message || 'No se pudo preparar el reporte de recurrencia.' }); }
  };
  app.get('/api/sales/recurrence', run('generate'));
  app.get('/api/sales/recurrence/:id/:section', run(null));
}
module.exports = { createRecurrenceService, registerRecurrenceRoutes };
