window.initializeProductReport({
  prefix: 'product-gender', title: 'Producto-Género', endpoint: '/api/sales/product-gender', openHandler: 'openProductGender',
  showExtraUnits: true,
  loadingMessage: 'Preparando ventas por género registrado o revisado…',
  metrics: [
    { label: 'Masculino', value: row => row.genders.masculine },
    { label: 'Femenino', value: row => row.genders.feminine },
    { label: 'M / F', pair: ['Masculino relativo', 'Femenino relativo'], sortHint: 'porcentaje masculino relativo', value: row => ({ percent: row.relativeGender.masculinePercent, pair: [row.relativeGender.masculinePercent, row.relativeGender.femininePercent] }) },
    { label: 'No informado / no identif.', value: row => row.genders.unknown }
  ],
  coverageFields: [['sales', 'Ventas'], ['payments', 'Detalle de pagos']],
  notice: data => data.rows.length && data.totals.genders.masculine.netSales === 0 && data.totals.genders.feminine.netSales === 0
    ? 'Las fuentes de esta selección no contienen género registrado o revisado identificable. La venta se conserva en No informado / no identificable.' : '',
  cards: (data, { money, count, percent }) => [
    ['Venta neta', money(data.totals.netSales), 'Total de la selección'],
    ['Unidades de productos', count(data.totals.units), 'No incluye unidades de extras'],
    ['Unidades de extras', count(data.totals.extraUnits || 0), 'Extras y adicionales de la selección'],
    ['Masculino', percent(data.totals.genders.masculine.percent), money(data.totals.genders.masculine.netSales), `Relativo: ${percent(data.totals.relativeGender.masculinePercent)}`],
    ['Femenino', percent(data.totals.genders.feminine.percent), money(data.totals.genders.feminine.netSales), `Relativo: ${percent(data.totals.relativeGender.femininePercent)}`],
    ['No informado / no identif.', percent(data.totals.genders.unknown.percent), money(data.totals.genders.unknown.netSales)]
  ]
});
