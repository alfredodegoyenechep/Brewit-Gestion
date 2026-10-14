const test = require('node:test');
const assert = require('node:assert/strict');
const { currentWeeks, selectInventoryDates, value, fromMetric, finalizeCell,
  reportOptions, buildWeeklyResults, buildWeeklyResultsWithProgress, buildDailyResultsWithProgress } = require('../weekly-results');
const locations = [{ id: 'store-1', name: 'La Concepción' }, { id: 'store-2', name: 'Lyon' }];

test('daily detail includes seven days, skips future days and keeps inventory exclusively weekly', async () => {
  const calls = [], events = [];
  const options = { today: '2026-10-13', period: currentWeeks('2026-10-13')[0], location: locations[0] };
  const data = await buildDailyResultsWithProgress(options, (location, period) => {
    calls.push(period);
    if (period.from === '2026-10-13') throw Error('Fuente del día no disponible');
    return cell();
  }, event => events.push(event));
  assert.equal(data.days.length, 7);
  assert.deepEqual(calls.map(period => period.from), ['2026-10-12', '2026-10-13']);
  assert.ok(calls.every(period => period.through === period.from && period.valuationThrough === '2026-10-13'));
  assert.equal(data.days[0].values.netSales.percent, 100);
  assert.equal(data.days[1].values.netSales.amount, null);
  assert.match(data.days[1].warnings[0], /Fuente del día/);
  assert.equal(data.days[2].values.netSales.status, 'future');
  for (const day of data.days) for (const key of ['inventoryShortage', 'otherConsumables', 'inventoryConsumptionTotal']) {
    assert.equal(day.values[key].amount, null);
    assert.equal(day.values[key].percent, null);
    assert.equal(day.values[key].status, 'weekly-only');
  }
  assert.equal(events.at(-1).completed, 7);
  let count = 0;
  assert.equal(await buildDailyResultsWithProgress(options, () => { count++; return cell(); }, () => {}, () => count === 1), null);
  assert.equal(count, 1);
});

test('four descending Monday–Sunday weeks cross months, years and leap days with a separate cutoff', () => {
  for (const today of ['2026-10-13', '2026-10-12', '2026-10-18', '2027-01-01', '2028-03-01']) {
    const weeks = currentWeeks(today);
    assert.equal(weeks.length, 4);
    assert.equal(weeks[0].through, today);
    weeks.forEach((week, index) => {
      assert.equal(new Date(week.from).getUTCDay(), 1);
      assert.equal(new Date(week.to).getUTCDay(), 0);
      assert.equal(Date.parse(week.to) - Date.parse(week.from), 6 * 86400000);
      if (index) { assert.equal(week.through, week.to); assert.equal(Date.parse(weeks[index - 1].from) - Date.parse(week.from), 7 * 86400000); }
    });
  }
  assert.deepEqual(currentWeeks('2026-10-13').map(week => week.from), ['2026-10-12', '2026-10-05', '2026-09-28', '2026-09-21']);
});

test('inventory uses the latest physical count in the week and the immediate previous count without proration', () => {
  const period = currentWeeks('2026-10-13')[1];
  assert.deepEqual(selectInventoryDates(['2026-10-11', '2026-10-04', '2026-10-04', '2026-09-01'], period), {
    status: 'complete', initialDate: '2026-10-04', finalDate: '2026-10-11', movements: { from: '2026-10-04', to: '2026-10-10' }
  });
  assert.equal(selectInventoryDates(['2026-10-04', '2026-10-07', '2026-10-11'], period).initialDate, '2026-10-07');
  assert.equal(selectInventoryDates(['2026-09-01', '2026-10-11'], period).initialDate, '2026-09-01');
  assert.equal(selectInventoryDates(['2026-10-04'], period).status, 'no-physical-count');
  assert.equal(selectInventoryDates(['2026-10-11'], period).status, 'no-opening-inventory');
  assert.equal(selectInventoryDates(['2026-10-04', '2026-10-14'], currentWeeks('2026-10-13')[0]).status, 'no-physical-count');
});

function cell(netSales = 1000) {
  return { values: { netSales: value(netSales, 'complete'), tips: value(100, 'complete'), cashCollection: value(200, 'complete'),
    grossSales: value(netSales + 200, 'complete'), discounts: value(100, 'complete'),
    mercadoPagoTips: value(80, 'complete'), cashTips: value(20, 'complete'),
    mercadoPagoFee: value(35, 'complete'),
    mercadoPagoCollection: value(900, 'complete'), inventoryShortage: value(-50, 'complete'), waste: value(-10, 'complete'),
    marketing: value(-20, 'complete'), employees: value(-30, 'complete'), otherConsumables: value(-40, 'complete') } };
}
test('percentages share the branch/week denominator and signed totals include consumables and exclude reconciliation', () => {
  const values = finalizeCell(cell()).values;
  assert.equal(values.netSales.percent, 100);
  assert.equal(values.collectionDifference.amount, -65);
  assert.equal(values.collectionDifference.percent, -6.5);
  assert.equal(values.inventoryConsumptionTotal.amount, -150);
  assert.equal(values.inventoryConsumptionTotal.percent, -15);
  assert.equal(values.otherConsumables.percent, -4);
  assert.equal(values.expenseIncome.status, 'pending');
  assert.equal(values.headOfficeSupplyIncome.percent, null);
  assert.equal(finalizeCell(cell(1100)).values.collectionDifference.amount, -165);
  assert.equal(finalizeCell(cell(900)).values.collectionDifference.amount, 35);
});
test('zero and absent net sales have no percentages, including pending rows', () => {
  for (const source of [cell(0), { ...cell(), values: { ...cell().values, netSales: value() } }]) {
    assert.ok(Object.values(finalizeCell(source).values).every(metric => metric.percent === null));
  }
});
test('missing components suppress totals, while available partial inventory contributes its known amount', () => {
  for (const status of ['no-data', 'no-physical-count', 'no-opening-inventory']) {
    const source = cell();
    source.values.inventoryShortage = value(null, status);
    const values = finalizeCell(source).values;
    assert.equal(values.inventoryConsumptionTotal.status, 'incomplete');
    assert.equal(values.inventoryConsumptionTotal.amount, null);
    assert.equal(values.inventoryConsumptionTotal.percent, null);
  }
  const known = cell(); known.values.inventoryShortage = value(-5, 'partial');
  const subtotal = finalizeCell(known).values;
  assert.equal(subtotal.inventoryConsumptionTotal.amount, -105);
  assert.equal(subtotal.inventoryConsumptionTotal.percent, -10.5);
  assert.equal(subtotal.inventoryConsumptionTotal.complete, false);
  assert.equal(subtotal.inventoryShortage.percent, -0.5);
  const source = cell(); source.values.waste = value();
  assert.equal(finalizeCell(source).values.inventoryConsumptionTotal.status, 'incomplete');
  source.values.waste = value(0, 'complete');
  assert.equal(finalizeCell(source).values.inventoryConsumptionTotal.status, 'complete');
  source.values.otherConsumables = value();
  const missingConsumables = finalizeCell(source).values.inventoryConsumptionTotal;
  assert.equal(missingConsumables.status, 'incomplete');
  assert.equal(missingConsumables.amount, null);
  assert.equal(missingConsumables.percent, null);
  source.values.otherConsumables = value(-40, 'partial');
  assert.equal(finalizeCell(source).values.inventoryConsumptionTotal.status, 'partial');
  source.values.otherConsumables = value(0, 'complete');
  assert.equal(finalizeCell(source).values.inventoryConsumptionTotal.amount, -100);
  assert.equal(finalizeCell(source).values.inventoryConsumptionTotal.status, 'complete');
});
test('raw Kardex signs survive, whereas expense metrics are displayed as negative costs', () => {
  assert.equal(fromMetric({ available: true, amount: 25 }).amount, 25);
  assert.equal(fromMetric({ available: true, amount: -25 }).amount, -25);
  assert.equal(fromMetric({ available: true, amount: 25 }, { expense: true }).amount, -25);
  assert.equal(fromMetric({ available: true, amount: 0 }).complete, true);
  assert.equal(fromMetric({ available: false, amount: 0 }).amount, null);
});
test('independent report streams the same results, isolates branch failures and cancels between calculations', async () => {
  const options = { today: '2026-10-13', locations };
  const build = (location, period) => {
    if (location.id === 'store-2') throw Error('Fuente no disponible');
    return { ...cell(), inventory: { initialDate: '2026-10-04' }, warnings: [period.from] };
  };
  const sync = buildWeeklyResults(options, build), events = [];
  assert.deepEqual(await buildWeeklyResultsWithProgress(options, build, event => events.push(event)), sync);
  assert.equal(sync.weeks[0].locations[0].values.netSales.amount, 1000);
  assert.equal(sync.weeks[0].locations[1].values.netSales.amount, null);
  assert.equal(events.at(-1).completed, 8);
  assert.equal(sync.metrics.length, 21);
  assert.equal(sync.total, undefined);
  let calls = 0;
  assert.equal(await buildWeeklyResultsWithProgress(options, () => { calls++; return cell(); }, () => {}, () => calls === 1), null);
  assert.equal(calls, 1);
});

test('control subtracts MP Teorico from received Mercado Pago, and selected rows suppress percentages', () => {
  const source = cell(); source.values.tips = value(99999, 'complete');
  const values = finalizeCell(source).values;
  assert.equal(values.collectionDifference.amount, -99964);
  for (const key of ['grossSales', 'grossSalesAfterDiscounts', 'mercadoPagoTheoretical', 'mercadoPagoCollection', 'mercadoPagoTips', 'cashTips']) {
    assert.equal(values[key].percent, null, key);
    assert.equal(values[key].showPercent, false, key);
  }
  assert.equal(values.tips.percent, 9999.9);
  assert.equal(values.mercadoPagoTips.amount + values.cashTips.amount, 100);
});

test('gross sales after discounts uses VAT-inclusive amounts and preserves coverage and computed zero', () => {
  const source = cell();
  assert.equal(finalizeCell(source).values.grossSalesAfterDiscounts.amount, 1100);
  source.values.discounts = value(1200, 'complete');
  assert.equal(finalizeCell(source).values.grossSalesAfterDiscounts.amount, 0);
  source.values.discounts = value(100.25, 'partial');
  const subtotal = finalizeCell(source).values.grossSalesAfterDiscounts;
  assert.equal(subtotal.amount, 1099.75);
  assert.equal(subtotal.status, 'partial');
  for (const key of ['grossSales', 'discounts']) {
    const missing = cell(); missing.values[key] = value();
    const result = finalizeCell(missing).values.grossSalesAfterDiscounts;
    assert.equal(result.amount, null);
    assert.equal(result.status, 'incomplete');
  }
});

test('control preserves positive, negative and balanced differences and propagates missing or partial sources', () => {
  for (const difference of [-100, 0, 100]) {
    const source = cell();
    source.values.mercadoPagoCollection = value(965 + difference, 'complete');
    const result = finalizeCell(source).values.collectionDifference;
    assert.equal(result.amount, difference);
    assert.equal(result.percent, difference / 10);
    assert.equal(result.complete, true);
  }
  for (const key of ['mercadoPagoCollection', 'grossSales', 'discounts', 'tips', 'mercadoPagoFee', 'cashCollection']) {
    const missing = cell(); missing.values[key] = value();
    const result = finalizeCell(missing).values.collectionDifference;
    assert.equal(result.status, 'incomplete', key);
    assert.equal(result.amount, null, key);
    assert.equal(result.percent, null, key);
    const partial = cell(); partial.values[key].status = 'partial'; partial.values[key].complete = false;
    const subtotal = finalizeCell(partial).values.collectionDifference;
    assert.equal(subtotal.amount, -65, key);
    assert.equal(subtotal.status, 'partial', key);
    assert.equal(subtotal.percentPartial, true, key);
  }
});

test('MP Teorico adds all tips, subtracts charged commission and cash, and requires all five inputs', () => {
  const source = cell();
  assert.equal(finalizeCell(source).values.mercadoPagoTheoretical.amount, 965);
  source.values.cashTips = value(0, 'complete');
  assert.equal(finalizeCell(source).values.mercadoPagoTheoretical.amount, 965);
  source.values.cashCollection = value(2000, 'complete');
  assert.equal(finalizeCell(source).values.mercadoPagoTheoretical.amount, -835);
  source.values.cashCollection = value(1165, 'complete');
  assert.equal(finalizeCell(source).values.mercadoPagoTheoretical.amount, 0);
  source.values.cashCollection = value(200, 'partial');
  assert.equal(finalizeCell(source).values.mercadoPagoTheoretical.status, 'partial');
  source.values.mercadoPagoFee = value(0, 'complete');
  assert.equal(finalizeCell(source).values.mercadoPagoTheoretical.amount, 1000);
  for (const key of ['grossSales', 'discounts', 'tips', 'mercadoPagoFee', 'cashCollection']) {
    const missing = { ...cell(), values: { ...cell().values, [key]: value() } };
    assert.equal(finalizeCell(missing).values.mercadoPagoTheoretical.amount, null, key);
    assert.equal(finalizeCell(missing).values.mercadoPagoTheoretical.status, 'incomplete', key);
  }
});

test('report options default to four weeks with inventory and reject unsupported selections', async () => {
  assert.deepEqual(reportOptions(), { weeks: 4, includeInventory: true });
  assert.deepEqual(reportOptions({ weeks: '2', includeInventory: 'false' }), { weeks: 2, includeInventory: false });
  for (const weeks of [2, 3, 4]) {
    const options = { today: '2026-10-13', locations, weeks, includeInventory: false };
    const result = buildWeeklyResults(options, () => cell()), events = [];
    assert.equal(result.weeks.length, weeks);
    assert.equal(result.weeks[0].period.through, options.today);
    assert.equal(result.weeks[0].locations[0].values.inventoryShortage.status, 'not-included');
    assert.equal(result.weeks[0].locations[0].values.inventoryConsumptionTotal.amount, null);
    assert.deepEqual(await buildWeeklyResultsWithProgress(options, () => cell(), event => events.push(event)), result);
    assert.equal(events.at(-1).completed, weeks * locations.length);
    assert.equal(events.at(-1).total, weeks * locations.length);
  }
  for (const weeks of [1, 5, 2.5, 'x', [], null]) assert.throws(() => reportOptions({ weeks }), { status: 400 });
  assert.throws(() => reportOptions({ includeInventory: 'yes' }), { status: 400 });
  const excluded = cell(); excluded.values.inventoryShortage = value(null, 'not-included');
  assert.equal(finalizeCell(excluded).values.inventoryConsumptionTotal.status, 'not-included');
});
