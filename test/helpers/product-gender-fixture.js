const genderOrders = [
  { orderKey: 'male', locationId: 'store-1', date: '2026-10-03', dateTime: '2026-10-03T10:00:00', declaredGender: 'masculino',
    lines: [{ code: 'C0', name: 'Cappuccino (CL)', quantity: 1, productNetSales: 1000, categoryPath: ['Barra Cafe', 'Café Caliente'] },
      { code: 'C1', name: 'Cappuccino (GR)', quantity: 2, productNetSales: 2000, categoryPath: ['Barra Cafe', 'Café Caliente'] }] },
  { orderKey: 'female', locationId: 'store-1', date: '2026-10-04', dateTime: '2026-10-04T11:00:00', validatedGender: 'female', genderBasis: 'explicit',
    lines: [{ code: 'C1', name: 'Cappuccino (GR)', quantity: 1, productNetSales: 1000, categoryPath: ['Barra Cafe', 'Café Caliente'] }] },
  { orderKey: 'unknown', locationId: 'store-1', date: '2026-10-03', dateTime: '2026-10-03T13:00:00', paymentComment: 'María', nameGenderSegment: 'feminine-associated',
    lines: [{ code: 'P2', name: 'Sandwich', quantity: 1, productNetSales: 2000, categoryPath: ['Retail', 'Sandwiches'] }] }
];
module.exports = { genderOrders };
