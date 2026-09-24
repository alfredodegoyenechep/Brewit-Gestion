const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('Análisis de la demanda abre sus cuatro capas y conserva el detalle aun sin ventas', { skip: !fs.existsSync(CHROME_PATH) }, async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-demand-ui-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot, reportToday: '2026-09-17' }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(uploadsRoot, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('link', { name: 'Análisis de la demanda' }).click();
  assert.equal(await page.locator('#demand-location-options input').count(), 2);
  await page.waitForFunction(() => document.getElementById('demand-status')?.textContent.includes('Análisis actualizado.'));
  assert.equal(await page.locator('#demand-category option').first().innerText(), 'Sin categorías con ventas');
  assert.equal(await page.locator('#demand-product option').first().innerText(), 'Sin productos con ventas');
  assert.equal(await page.locator('#demand-summary .demand-kpi').count(), 5);
  assert.equal(await page.locator('#demand-locations-body tr').count(), 3);
  await page.locator('#demand-analysis-workspace-tab-hypotheses').click();
  assert.equal(await page.locator('#demand-hypotheses').isVisible(), true);
  await page.locator('#demand-analysis-workspace-tab-actions').click();
  assert.equal(await page.locator('#demand-actions').isVisible(), true);
  assert.equal(await page.locator('#demand-advanced .demand-insight').count(), 7);
  await page.locator('#demand-analysis-workspace-tab-advanced').click();
  await page.getByRole('button', { name: 'Abrir análisis: Estacionalidad anual' }).click();
  await page.locator('#demand-advanced-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#demand-advanced-title').innerText(), 'Estacionalidad anual');
  assert.match(await page.locator('#demand-advanced-content').innerText(), /Alcance.*Datos disponibles.*Limitaciones.*Información necesaria/s);
  await page.locator('#demand-advanced-close').click();
  await page.locator('#demand-analysis-workspace-tab-exploration').click();
  await page.getByRole('button', { name: 'Combinaciones' }).click();
  assert.match(await page.locator('#demand-exploration').innerText(), /Lift/);
  await page.getByRole('button', { name: 'Horarios y evolución' }).click();
  assert.deepEqual(await page.locator('.demand-heatmap-summary strong').allTextContents(), ['Total', '% total']);
  await page.locator('#demand-analysis-workspace-tab-overview').click();
  await page.locator('#demand-report .demand-detail').first().click();
  await page.locator('#demand-detail-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => /^\d+ pedidos/.test(document.getElementById('demand-detail-status')?.textContent || ''));
  assert.match(await page.locator('#demand-detail-status').innerText(), /0 pedidos/);
});

test('Resumen General ofrece gráficos trazables para indicadores, intradía e historiales', { skip: !fs.existsSync(CHROME_PATH) }, async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-report-charts-ui-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot, reportToday: '2026-09-17' }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(uploadsRoot, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: 'Resumen de ventas' }).waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('.navigation .nav-group-label').allTextContents(),
    ['Visión ejecutiva', 'Inteligencia comercial', 'Operación y costos', 'Administración']);
  assert.deepEqual(await page.locator('.navigation .nav-link').evaluateAll(links => links.map(link => link.dataset.view)), [
    'report', 'financial-results',
    'sales', 'demand-analysis', 'transaction-audit', 'sales-ingredients',
    'products', 'ingredients', 'cost-review', 'inventory', 'purchases', 'purchase-projection', 'findings',
    'uploads', 'config'
  ]);
  await page.waitForFunction(() => !document.querySelector('[data-report-chart="report-summary-day"]')?.disabled);
  assert.equal(await page.locator('#weekly-report [data-report-chart]').count(), 22);
  for (const key of ['months', 'weeks', 'days', 'equivalent-days']) {
    assert.equal(await page.locator(`#order-count-statistics-${key} tr`).count(), 14);
    assert.ok(!(await page.locator(`#order-count-statistics-${key}`).innerText()).includes('$'));
  }
  await page.locator('[data-report-chart="order-count-statistics-days"]').click();
  await page.locator('#report-chart-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#report-chart-title').innerText(), /Número de órdenes/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Ver gráfico: Venta del día' }).click();
  await page.locator('#report-chart-dialog').waitFor({ state: 'visible' });
  const chartDialogLayout = await page.locator('#report-chart-dialog').evaluate(dialog => ({
    width: dialog.getBoundingClientRect().width,
    height: dialog.getBoundingClientRect().height,
    resize: getComputedStyle(dialog).resize
  }));
  assert.ok(chartDialogLayout.width >= 1200);
  assert.ok(chartDialogLayout.height >= 680);
  assert.equal(chartDialogLayout.resize, 'both');
  assert.match(await page.locator('#report-chart-title').innerText(), /Venta de hoy/);
  assert.equal(await page.locator('#report-chart-data-head th').count(), 2);
  assert.equal(await page.locator('#report-chart-data-body tr').count(), 2);
  await page.locator('#report-chart-close').click();
  await page.getByRole('button', { name: 'Ver gráfico: Venta de los últimos 14 meses' }).click();
  await page.locator('#report-chart-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#report-chart-title').innerText(), 'Venta de los últimos 14 meses');
  assert.equal(await page.locator('#report-chart-svg').getAttribute('role'), 'img');
  const monthLabels = await page.locator('#report-chart-data-body tr td:first-child').allTextContents();
  assert.match(monthLabels[0], /2025/);
  assert.match(monthLabels.at(-1), /2026/);
  assert.equal(await page.getByRole('button', { name: 'Gráfico de líneas' }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Gráfico de barras' }).click();
  assert.equal(await page.getByRole('button', { name: 'Gráfico de barras' }).getAttribute('aria-pressed'), 'true');
  await page.locator('#report-chart-close').click();
  await page.locator('#report-view-filter').selectOption('grid');
  await page.locator('#network-sales-dashboard').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-report-chart="report-network"]')?.disabled);
  await page.getByRole('button', { name: 'Ver gráfico: Comparativo por local' }).click();
  assert.equal(await page.locator('#report-chart-title').innerText(), 'Venta neta de hoy por local');
  assert.equal(await page.getByRole('button', { name: 'Gráfico circular' }).isVisible(), true);
  await page.locator('#report-chart-close').click();

  await page.getByRole('link', { name: 'Análisis y Estadísticas' }).click();
  await page.getByRole('heading', { name: 'Panel de indicadores comerciales' }).waitFor();
  await page.waitForFunction(() => !document.getElementById('refresh-sales-dashboard')?.disabled);
  await page.locator('#sales-location-body').evaluate(body => {
    body.innerHTML = '<tr><td>Local Norte</td><td>$120.000</td><td>$100.000</td><td>$600.000</td><td>$2.400.000</td></tr>'
      + '<tr><td>Local Sur</td><td>$80.000</td><td>$90.000</td><td>$450.000</td><td>$1.900.000</td></tr>';
  });
  await page.getByRole('button', { name: 'Ver gráfico: Comparación de ventas por cafetería' }).click();
  assert.equal(await page.locator('#report-chart-metric option').count(), 4);
  assert.deepEqual(await page.evaluate(() => ({
    dialogOpen: document.getElementById('report-chart-dialog').open,
    pieHidden: document.querySelector('[data-chart-type="pie"]').hidden,
    types: activeReportChart?.allowedTypes
  })), { dialogOpen: true, pieHidden: false, types: ['bar', 'pie'] });
  await page.getByRole('button', { name: 'Gráfico circular' }).click();
  assert.ok(await page.locator('#report-chart-svg path').count() >= 2);
  await page.locator('#report-chart-close').click();
  await page.evaluate(() => {
    salesDashboardState.sales.serviceModes.periods.month = {
      period: { from: '2026-09-01', to: '2026-09-17' },
      hierarchies: [{
        name: 'Barra Cafe / Café Caliente',
        groups: { takeaway: { netSales: 125000 }, dineIn: { netSales: 250000 }, unknown: { netSales: 5000 } },
        totalNetSales: 380000
      }]
    };
    document.getElementById('sales-service-mode-period').value = 'month';
    document.getElementById('sales-service-mode-hierarchies').innerHTML = '<tr><th>Barra Cafe / Café Caliente</th><td><div><strong>$125.000</strong><small>20 pedidos</small></div></td><td>$250.000</td><td>$5.000</td><td>$380.000</td></tr>';
  });
  await page.locator('#sales-workspace-tab-service').click();
  await page.getByRole('button', { name: 'Ver gráfico: Composición de ventas por modalidad' }).click();
  assert.equal(await page.locator('#report-chart-metric option').count(), 4);
  assert.match(await page.locator('#report-chart-data-body tr').first().locator('td').nth(1).textContent(), /125\.000/);
  await page.locator('#report-chart-close').click();
  await page.evaluate(() => {
    const products = [
      { code: 'CAF1', name: 'Americano', quantity: 26, netSales: 76471, totalCost: 22000, contributionMarginPercent: 71.2, children: [], products: [] },
      { code: 'SAN1', name: 'Sándwich', quantity: 18, netSales: 74118, totalCost: 36000, contributionMarginPercent: 51.4, children: [], products: [] }
    ];
    salesDashboardState.sales.productInsights.week = {
      period: { from: '2026-09-14', to: '2026-09-17' }, topProducts: products,
      hierarchyTree: {
        name: 'Todas las jerarquías', path: [], netSales: 150589, totalCost: 58000,
        contributionMarginPercent: 61.5, products,
        children: [
          { name: 'Barra Cafe', path: ['Barra Cafe'], netSales: 76471, totalCost: 22000, contributionMarginPercent: 71.2, children: [], products: [products[0]] },
          { name: 'Bollería y Sandwich', path: ['Bollería y Sandwich'], netSales: 74118, totalCost: 36000, contributionMarginPercent: 51.4, children: [], products: [products[1]] }
        ]
      }
    };
    document.getElementById('sales-insight-period').value = 'week';
    salesHierarchyPath = [];
    renderSalesInsights();
  });
  await page.locator('#sales-workspace-tab-products').click();
  await page.getByRole('button', { name: 'Ver gráfico: Productos más vendidos' }).click();
  assert.equal(await page.locator('#report-chart-metric option').count(), 2);
  assert.equal(await page.locator('[data-chart-type="pie"]').evaluate(button => button.hidden), true);
  await page.locator('#report-chart-close').click();
  await page.getByRole('button', { name: 'Ver gráfico: Venta por jerarquía' }).click();
  assert.equal(await page.locator('#report-chart-metric option').count(), 4);
  assert.equal(await page.locator('[data-chart-type="pie"]').evaluate(button => button.hidden), false);
  await page.locator('#report-chart-close').click();

  await page.getByRole('link', { name: 'Auditoría Transacciones' }).click();
  await page.getByRole('heading', { name: 'Auditoría de transacciones' }).waitFor();
  await page.waitForFunction(() => transactionAuditState !== null);
  await page.evaluate(() => {
    transactionAuditState = {
      filters: { dateFrom: '2026-09-16', dateTo: '2026-09-17' },
      transactions: [
        { date: '2026-09-16', saleBeforeDiscount: 1000, discountAmount: 100 },
        { date: '2026-09-16', saleBeforeDiscount: 2000, discountAmount: 0 },
        { date: '2026-09-17', saleBeforeDiscount: 1000, discountAmount: 200 }
      ]
    };
  });
  await page.getByRole('button', { name: 'Ver gráfico: Análisis de descuentos' }).click();
  assert.deepEqual(await page.locator('#report-chart-metric option').allTextContents(), [
    'Descuento total / venta antes de descuentos',
    'Transacciones con descuento',
    'Transacciones con descuento / total'
  ]);
  const auditChartRows = page.locator('#report-chart-data-body tr');
  assert.match(await auditChartRows.first().locator('td').nth(1).textContent(), /3,3%/);
  await page.locator('#report-chart-metric').selectOption({ label: 'Transacciones con descuento / total' });
  assert.match(await auditChartRows.first().locator('td').nth(1).textContent(), /50%/);
});

test('Análisis de la demanda muestra un error visible si el servidor aún no sirve su módulo', { skip: !fs.existsSync(CHROME_PATH) }, async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-demand-module-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(uploadsRoot, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.route('**/demand-view.js', route => route.fulfill({ status: 404, body: 'Not Found' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('link', { name: 'Análisis de la demanda' }).click();
  assert.match(await page.locator('#demand-status').innerText(), /Reinicia el servidor de Brewit/);
});

test('Configuración agrupa lunes a viernes y muestra completos los campos horarios', { skip: !fs.existsSync(CHROME_PATH) }, async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-location-hours-ui-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(uploadsRoot, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('link', { name: 'Configuracion' }).click();
  await page.locator('#active-locations-list .location-row').first().waitFor();
  const store = page.locator('#active-locations-list .location-row').first();
  assert.equal(await store.locator('.location-hours-row').count(), 3);
  assert.match(await store.locator('.location-weekly-hours').innerText(), /Lunes a viernes.*Sábado.*Domingo/s);
  assert.ok(await store.getByLabel(/Apertura Lun–Vie/).evaluate(element => element.getBoundingClientRect().width) >= 118);
  const hourRows = await store.locator('.location-hours-row').evaluateAll(rows => rows.map(row => {
    const box = row.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
  }));
  assert.ok(hourRows.every((row, index) => index === 0 || row.top >= hourRows[index - 1].bottom));
  const actionPositions = await store.locator('.location-row-actions button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
  assert.ok(actionPositions[1] > actionPositions[0]);
  await store.getByLabel(/Apertura Lun–Vie/).fill('08:00');
  await store.getByLabel(/Cierre Lun–Vie/).fill('20:00');
  await store.getByRole('button', { name: /Guardar cambios/ }).click();
  await page.waitForFunction(() => document.getElementById('location-status')?.classList.contains('success'));
  const locations = await page.evaluate(() => fetch('/api/config/locations').then(response => response.json()));
  const savedStore = locations.active.find(location => location.type === 'store');
  assert.deepEqual([1, 2, 3, 4, 5].map(day => savedStore.operatingHours[String(day)]),
    Array.from({ length: 5 }, () => ({ open: '08:00', close: '20:00' })));
});



test('Nueva carga permite archivos manuales por local y guarda las frecuencias nativas', { skip: !fs.existsSync(CHROME_PATH) }, async t => {
  const uploadsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-upload-native-ui-'));
  const server=createApp({ uploadsRoot,enableToteatSync:false}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const browser=await chromium.launch({executablePath:CHROME_PATH,headless:true});t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));fs.rmSync(uploadsRoot,{recursive:true,force:true});});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('link',{name:'Datos y sincronización',exact:true}).click();
  await page.locator('[data-upload-location="store-1"][data-upload-field="marketing"]').waitFor();
  assert.equal(await page.locator('[data-upload-field]').count(),6);
  assert.equal(await page.locator('[data-upload-location="main-warehouse"]').count(),0);
  for(const field of ['marketing','employees','mercadopago']) {
    const chooser=page.waitForEvent('filechooser');await page.locator(`[data-upload-location="store-1"][data-upload-field="${field}"]`).click();
    await (await chooser).setFiles({name:field+'.csv',mimeType:'text/csv',buffer:Buffer.from(field==='mercadopago'?'TRANSACTION_DATE\tSOURCE_ID\tTRANSACTION_TYPE\tTRANSACTION_AMOUNT\tFEE_AMOUNT\n2026-08-05T10:00:00.000-04:00\tmp-ui-1\tSETTLEMENT\t1190\t-20':'ID Producto **\tNombre Producto *\t2026-08-05\nP1\tProducto Uno\t1')});
    await page.locator('#date-confirmation').waitFor({state:'visible',timeout:5000}).catch(async error=>{throw Error(await page.locator('#upload-manual-status').innerText()+' | '+error.message);});
    assert.equal(await page.locator('#file-loader').isVisible(),false);
    await page.locator('#dates-confirmed').check();await page.locator('#keep-transactions-btn').click();
    await page.locator('#date-confirmation').waitFor({state:'hidden'});
    await page.locator('#upload-manual-status').filter({hasText:/agregaron|MercadoPago nueva/}).waitFor();
    const data=await page.request.get(`http://127.0.0.1:${server.address().port}/api/transactions?location=store-1`).then(r=>r.json());assert.equal(data.files[field].fileCount,1);
  }
  await page.locator('#upload-masters-frequency').selectOption('60');await page.locator('#upload-inventory-frequency').selectOption('15');await page.getByRole('button',{name:'Guardar frecuencias'}).click();
  await page.locator('#upload-schedule-status').filter({hasText:'Frecuencias guardadas'}).waitFor();
  await page.reload();await page.getByRole('link',{name:'Datos y sincronización',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('upload-masters-frequency').value==='60');
  assert.equal(await page.locator('#upload-inventory-frequency').inputValue(),'15');
});
