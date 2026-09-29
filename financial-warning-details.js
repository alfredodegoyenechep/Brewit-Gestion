// Keep evidence tied to the actual warning and source; unavailable values stay null.
function warningDetails(message, payload) {
  const matches = (payload.inventoryByLocation || []).flatMap(location =>
    (location.reviewDetails || []).filter(detail => detail.message === message));
  if (matches.length) return { message, explanation: 'El subtotal solo incluye los costos que se pudieron valorizar. Un costo pendiente no representa un costo cero.',
    action: 'Revisa estos códigos en Compras: fecha, importe neto, cantidad recibida y unidad. Si es un producto preparado, revisa también su receta y el costo de cada ingrediente. Después vuelve a procesar el reporte.',
    rows: matches.flatMap(detail => detail.rows) };
  if (message.includes('sin cotejo con «Monto neto»')) return { message,
    explanation: 'Estos costos están disponibles, pero su base neta no está cotejada con el importe neto de Compras. Los márgenes asociados son estimados.',
    action: 'En Historial de compras e insumos, busca cada código y verifica la última compra aplicable: importe neto, cantidad y unidad. Revisa el maestro o la receta cuando sean la fuente indicada. No conviertas el IVA automáticamente sin verificar el documento.',
    rows: payload.revenue?.unverifiedCostProducts || [] };
  if (message.includes('producto(s) vendido(s) no tienen costo')) return { message,
    explanation: 'No se pudo determinar el costo de estos productos vendidos.',
    action: 'Revisa Compras, el maestro de ingredientes y las recetas para los códigos indicados; completa los costos o conversiones pendientes y vuelve a procesar.',
    rows: (payload.revenue?.missingCostProducts || []).map(item => ({ Código: item.code, Producto: item.name, Líneas: item.lines, 'Venta neta afectada': item.netSales, Desde: item.firstDate, Hasta: item.lastDate, Motivo: item.reason, 'Componente pendiente': item.missingComponent })) };
  const inventory = (payload.inventoryByLocation || []).filter(item => item.warnings?.includes(message));
  const coverage = message.match(/^(Ventas|Compras) \((.+)\):/);
  const action = coverage
    ? `En Actualización de fuentes, revisa la sincronización de ${coverage[1]} para ${coverage[2]}. Amplía la cobertura al inicio del período solicitado o selecciona un período cubierto y vuelve a procesar.`
    : /Consumo de/i.test(message)
      ? 'En Carga de archivos, revisa el archivo de consumo indicado para esta cafetería y el período solicitado. Carga o corrige el archivo y comprueba sus fechas, códigos y cantidades antes de volver a procesar.'
      : /inventario|Kardex|Merma/i.test(message)
        ? 'En Inventario, revisa la cobertura de las fuentes, las tomas físicas de apertura y cierre y los movimientos de merma. Actualiza las fuentes y procesa Kardex Propio para este período; revisa los productos excluidos y sus costos. No reemplaces una toma física faltante por un saldo teórico.'
        : /MercadoPago/i.test(message)
          ? 'Revisa los archivos de MercadoPago del período, sus fechas y columnas de comisión. Corrige o vuelve a cargar la fuente y procesa de nuevo.'
          : 'Revisa la fuente indicada en la advertencia, su vigencia, códigos y columnas requeridas. Corrige o actualiza la fuente y vuelve a procesar el reporte.';
  return { message, explanation: 'La fuente no permite completar o verificar esta parte del cálculo. La ausencia de datos no demuestra que el importe sea cero.', action,
    rows: [{ Ubicación: coverage?.[2] || inventory.map(item => item.location.name).join(', ') || payload.scope?.label,
      Desde: payload.period?.from, Hasta: payload.period?.to,
      'Inicio de cobertura': message.match(/cobertura comienza el (\d{4}-\d{2}-\d{2})/)?.[1] || null,
      'Detalle de la fuente': message }],
    note: 'Esta advertencia no identifica importes ni ítems individuales verificables. Revisa primero la fuente o cobertura indicada.' };
}
function unverifiedProducts(facts) {
  const groups = new Map();
  for (const fact of facts.filter(item => item.costAvailable && item.costBasisEvidence !== 'net-field-consistent')) {
    const key = JSON.stringify([fact.locationId, fact.code, fact.costSource, fact.costSourceDate]);
    if (!groups.has(key)) groups.set(key, { Ubicación: fact.locationName, Código: fact.code, Producto: fact.name,
      Fuente: fact.costSource, 'Fecha del costo': fact.costSourceDate, Líneas: 0, Cantidad: 0, 'Venta neta afectada': 0, 'Costo usado (estimado)': 0 });
    const row = groups.get(key); row.Líneas++; row.Cantidad += fact.quantity;
    row['Venta neta afectada'] += fact.netSales; row['Costo usado (estimado)'] += fact.totalCost;
  }
  return [...groups.values()];
}
module.exports = { warningDetails, unverifiedProducts };
