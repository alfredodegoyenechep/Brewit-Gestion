const { selection, selectOrders, aggregateProductReport } = require('./product-report');
const { coverageFor } = require('./recurrence');
const VERSION = 'product-reviewed-gender-v5-relative';
const GENDERS = ['masculine', 'feminine', 'unknown'];
function normalizeDeclaredGender(value) {
  const text = String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (['m', 'male', 'masculine', 'masculino', 'hombre', 'man'].includes(text)) return 'masculine';
  if (['f', 'female', 'feminine', 'femenino', 'mujer', 'woman'].includes(text)) return 'feminine';
  return 'unknown';
}
function genderForOrder(order) {
  if (order.genderAmbiguous) return 'unknown';
  if (['explicit', 'declared', 'validated', 'manual'].includes(order.genderBasis)) return normalizeDeclaredGender(order.validatedGender);
  if (order.declaredGender != null) return normalizeDeclaredGender(order.declaredGender);
  return 'unknown';
}
function buildProductGender(context, orders, query = {}, warnings = []) {
  const filters = selection(query), { period, today, locationIds } = context;
  const asOf = period.to < today ? `${period.to}T23:59:59` : `${today}T${query.serverCutoff || context.cutoff || '23:59:59'}`;
  const selected = selectOrders(orders, locationIds, period, asOf);
  const aggregated = aggregateProductReport(selected, filters, GENDERS, genderForOrder,
    (buckets, metric, { missingSales }) => {
      const known = buckets.masculine + buckets.feminine;
      const masculinePercent = !missingSales && known > 0 ? Number((buckets.masculine / known * 100).toFixed(1)) : null;
      return { genders: Object.fromEntries(GENDERS.map(key => [key, metric(buckets[key])])), relativeGender: {
        masculinePercent, femininePercent: masculinePercent === null ? null : Number((100 - masculinePercent).toFixed(1))
      } };
    }, { includeExtras: true });
  const sales = coverageFor(context.coverage || [], locationIds, period.from, period.to, 'sales');
  const payments = coverageFor(context.coverage || [], locationIds, period.from, period.to, 'payment-details');
  const knownSales = aggregated.totals.genders.masculine.netSales + aggregated.totals.genders.feminine.netSales;
  const hasUnknown = aggregated.rows.some(row => row.genders.unknown.netSales !== 0);
  return { definitionVersion: VERSION, scope: context.scope, period, asOf, filters, ...aggregated,
    status: !aggregated.rows.length ? sales.complete ? 'no_activity' : 'no_data'
      : warnings.length || aggregated.totals.missingSales || hasUnknown || !sales.complete || !payments.complete ? 'partial' : 'complete',
    coverage: { sales, payments },
    monetaryBasis: 'Venta neta de las líneas TotEat después de descuentos, sin IVA. Incluye los extras cobrados en Extras y adicionales, con el género del pedido. Las unidades de productos y de extras se muestran separadas. Los filtros de productos o jerarquías limitan ambos importes a la selección; los extras no se atribuyen a una bebida sin un vínculo comprobado.',
    definition: 'Masculino y Femenino usan únicamente género registrado en la fuente o asignado en una revisión del pedido. Los datos ausentes, ambiguos u otras categorías se incluyen en No informado / no identificable. No se deduce género a partir del nombre ni del medio de pago.',
    denominator: 'Masculino, Femenino y No informado / no identif. dividen la venta neta del segmento por toda la venta neta de la fila. M / F muestra los porcentajes relativos sobre la suma de venta masculina y femenina, excluyendo No informado / no identif.; ambos suman 100,0 %. Sin base positiva o con importes incompletos se muestra sin dato.',
    warnings: [...new Set([...warnings,
      ...(aggregated.rows.length && knownSales === 0 ? ['Las fuentes seleccionadas no aportan género registrado o revisado identificable para esta selección; la venta se muestra en No informado / no identificable.'] : []),
      ...(hasUnknown ? ['La venta sin asignación de género o con datos contradictorios se conserva en el total y se presenta por separado.'] : []),
      ...(aggregated.totals.missingSales ? ['Hay líneas sin venta neta disponible; sus unidades se incluyen y los importes afectados se muestran sin dato.'] : [])])] };
}
module.exports = { VERSION, GENDERS, normalizeDeclaredGender, genderForOrder, buildProductGender };
