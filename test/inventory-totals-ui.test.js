const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('Kardex keeps numeric totals with missing data and executive labels wrap inside their cells', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-totals-ui-'));
  const server = createApp({ uploadsRoot: root, enableToteatSync: false }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  await page.route('**/api/inventory/item-detail?**', route => route.fulfill({json:{
    code:'A',name:'Negativo',unit:'UN',warehouse:'Cafetería',documentsAvailable:true,daily:[],issues:[],
    movements:[{id:'tr1',date:'2026-09-01',type:'Transferencia entre bodegas · salida',document:'TR-1',quantity:3,unit:'UN',effect:-3,active:true,status:'APPROVED',origin:'Cafetería',destination:'Principal',originalQuantity:3,originalUnit:'UN',exactQuantity:3,createdAt:'2026-09-01T12:00:00Z',approvedAt:'2026-09-01T13:00:00Z',observation:'<img src=x onerror=alert(1)>',transfer:true}]
  }}));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('link', { name: 'Inventario', exact: true }).click();
  await page.evaluate(() => {
    const base = { unit: 'UN', unitCost: 100, costAvailable: true, initialInventory: 2, theoreticalFinal: 2, movements: {} };
    const items = [
      { ...base, code: 'A', name: 'Negativo', finalInventory: 1, difference: -1, totalCost: -100 },
      { ...base, code: 'B', name: 'Positivo', finalInventory: 5, difference: 3, totalCost: 300 },
      { ...base, code: 'M', name: 'Sin toma', theoreticalFinal: 7, finalInventory: null, difference: null, totalCost: null },
      { ...base, code: 'N', name: 'Sin costo', costAvailable: false, finalInventory: 4, difference: 2, totalCost: 999 }
    ];
    const metric = { available: true, partial: true, amount: 200, quantity: 2, itemCount: 4 };
    window.executiveFixture = { netSales: 1000, period: { dateFrom: '2026-08-30', dateTo: '2026-09-26', locations: [{ name: 'La Concepción' }] }, metrics: {
      marketingConsumption: metric, employeeConsumption: metric, calibrationConsumption: metric, waste: metric,
      adjustedKardexTotalCost: { ...metric, kardexTotalCost: 200, totalAdjustmentCost: 0 }, theoreticalFinalInventoryValue: metric, physicalInventoryValue: { available: false }, otherConsumables: metric
    } };
    renderInventoryResults({
      itemDetailReportId: 'snapshot', location: {name:'La Concepción'},
      report: { items, itemCount: 4, movementDefinitions: [], dateFrom: '2026-08-30', dateTo: '2026-09-26', selection: { initialBasis: 'physical', finalBasis: 'physical', initialDate: '2026-08-30', finalDate: '2026-09-27' } },
      otherConsumables: { items, itemCount: 4 },
      executiveSummary: window.executiveFixture
    });
  });
  const totals = table => page.locator(`${table} tfoot td`).allTextContents().then(cells => cells.slice(-3));
  assert.deepEqual(await totals('#inventory-results-table'), ['$200', '$1.100', '$600']);
  assert.deepEqual(await totals('#inventory-other-consumables-table'), ['$200', '$1.100', '$600']);
  await page.locator('#inventory-results-table tbody tr').filter({has:page.getByRole('button',{name:'Ver movimientos de A: Negativo',exact:true})}).locator('td').nth(1).click();
  const dialog=page.getByRole('dialog',{name:'Detalle de A: Negativo',exact:true});
  await dialog.getByRole('heading',{name:'Transferencias entre bodegas y locales'}).waitFor();
  assert.match(await dialog.innerText(),/TR-1/);assert.match(await dialog.innerText(),/Principal/);assert.match(await dialog.innerText(),/3,0000 UN/);
  assert.equal(await dialog.locator('img').count(),0);
  await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);
  assert.equal(await page.getByRole('dialog',{name:'Consolidado de inventario',exact:true}).isVisible(),true);
  assert.equal(await page.locator('#inventory-results-table tbody button').first().evaluate(button=>button===document.activeElement),true);
  const itemTrigger=page.locator('#inventory-results-table tbody button').first();
  await itemTrigger.focus();await page.keyboard.press('Enter');await dialog.waitFor();
  await dialog.getByRole('button',{name:'Cerrar',exact:true}).click();assert.equal(await dialog.count(),0);
  const note = page.locator('#inventory-kardex-totals-note');
  assert.match(await note.innerText(), /1 registro\(s\) sin costo; 1 registro\(s\) no comparables; 1 registro\(s\) sin toma física/);
  const appearance = await note.evaluate(element => ({ color: getComputedStyle(element).color, small: parseFloat(getComputedStyle(element).fontSize) < parseFloat(getComputedStyle(document.querySelector('#inventory-results-table')).fontSize) }));
  assert.equal(appearance.color, 'rgb(228, 87, 61)'); assert.equal(appearance.small, true);
  for (const width of [1180, 720, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const fits = await page.locator('#inventory-executive-summary-table tbody td:first-child').evaluateAll(cells => cells.every(cell => {
      const range = document.createRange(); range.selectNodeContents(cell);
      const bounds = cell.getBoundingClientRect();
      return bounds.width > 0 && [...range.getClientRects()].every(line => line.right <= bounds.right && line.left >= bounds.left);
    }));
    assert.equal(fits, true, `Indicators overflow at width ${width}`);
  }
  await page.locator('#inventory-kardex-search').fill('Negativo');
  assert.deepEqual(await totals('#inventory-results-table'), ['$-100', '$200', '$100']);
  assert.equal(await note.isVisible(), false);
  await page.locator('#inventory-kardex-search').fill('Sin costo');
  assert.deepEqual(await totals('#inventory-results-table'), ['$0', '$0', '$0']);
  assert.equal(await note.isVisible(), true);
  for (const example of [
    {amount:33556,total:'$32.556',value:'$33.556',percent:'3.355,6%',color:'rgb(40, 105, 168)'},
    {amount:-33556,total:'$-34.556',value:'$-33.556',percent:'-3.355,6%',color:'rgb(192, 57, 43)'},
    {amount:0,total:'$-1.000',value:'$0',percent:'0,0%',color:'rgb(192, 57, 43)'}
  ]) {
    await page.evaluate(amount=>{
      const summary=structuredClone(window.executiveFixture);
      summary.metrics.adjustedKardexTotalCost.amount=amount;
      renderInventoryExecutiveSummary(summary);
    },example.amount);
    const row=page.locator('#inventory-executive-summary-table tbody tr').filter({hasText:'Costo Total Kardex ajustado'});
    assert.match(await row.locator('td').first().innerText(),/parcial/);
    assert.equal(await row.locator('td').nth(1).innerText(),example.value);
    assert.equal(await row.locator('td').nth(2).innerText(),example.percent);
    assert.equal(await row.locator('td').nth(1).evaluate(cell=>getComputedStyle(cell).color),example.color);
    assert.equal(await page.locator('#inventory-executive-summary-table tfoot td').nth(1).innerText(),example.total);
    assert.equal(await page.locator('#inventory-executive-summary-table tbody tr').first().locator('td').nth(1).innerText(),'$-200');
  }
});
