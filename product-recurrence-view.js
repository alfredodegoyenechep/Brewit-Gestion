window.initializeProductReport({
  prefix: 'product-recurrence', title: 'Producto-Recurrencia', endpoint: '/api/sales/product-recurrence', openHandler: 'openProductRecurrence',
  loadingMessage: 'Preparando ventas y antecedentes de compra…',
  metrics: [
    ...[15, 30, 60, 90].map((days, index) => ({ label: ['1–15 días', '16–30 días', '31–60 días', '61–90 días'][index], value: row => row.windows[days] })),
    { label: 'Sin antecedente ≤90 d', value: row => row.withoutRecent },
    { label: 'Sin vínculo identificable', value: row => row.unclassified }
  ],
  coverageFields: [['sales', 'Ventas'], ['history', 'Historial MP de 90 días'], ['payments', 'Detalle de pagos']],
  cards: (data, { money, count, percent }) => [
    ['Venta neta', money(data.totals.netSales), 'Total de la selección'],
    ['Unidades vendidas', count(data.totals.units), 'Total de la selección'],
    ['Venta recurrente ≤90 días', percent(data.totals.recurring.percent), money(data.totals.recurring.netSales)],
    ['Sin vínculo identificable', percent(data.totals.unclassified.percent), money(data.totals.unclassified.netSales)]
  ]
});
