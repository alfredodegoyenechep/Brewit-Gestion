const engine = require('./sales-clusters');
const VERSION = 'xray-automatic-clusters-v1';
function analyze(report, orders, progress = () => {}) {
  const dimensions = Object.fromEntries(Object.entries(engine.DEFAULT_DIMENSIONS).map(([key, value]) => [key, { ...value, ...(key === 'gender' ? { enabled: true } : {}) }]));
  const filters = { locations: report.scope.location, mode: 'custom', dateFrom: report.period.from, dateTo: report.period.to,
    productCodes: report.family.codes, xraySourceVersion: report.sourceVersion };
  const input = { period: report.period, sourceFingerprint: report.sourceVersion, seed: `${report.sourceVersion}:${report.family.id}`,
    recurrenceResolved: true, config: { filters, dimensions }, orders: orders.filter(o => !o.dateTime || o.dateTime <= (report.asOf || `${report.period.to}T23:59:59`)).map(o => ({ ...o,
      time: o.timeKnown === false ? '' : o.time, orderDiscount: o.orderDiscountKnown === false ? null : o.orderDiscount })) };
  const { result } = engine.runAnalysis(input, event => progress(event.message));
  // The product report carries aggregate profiles, never membership or customer examples.
  const clusters = result.clusters.map(({ representative, examples, ...cluster }) => cluster);
  const solid = clusters.filter(c => c.status === 'solid');
  return { ...result, clusters, automatic: true, sourceVersion: report.sourceVersion, policyVersion: VERSION,
    conclusion: solid.length ? `${solid.length} cluster(s) con validación sólida: ${solid.map(c => c.name).join('; ')}.`
      : clusters.length ? 'Se identificaron grupos exploratorios; ninguno cumple todos los criterios para considerarse un cluster sólido.'
        : 'No se identifican clusters sustentados con el volumen y la información disponibles.' };
}
module.exports = { VERSION, analyze };
