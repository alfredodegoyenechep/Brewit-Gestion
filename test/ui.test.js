const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('Cargar Archivos opens the upload workspace', { skip: !fs.existsSync(CHROME_PATH) }, async t => {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-ui-test-'));
  const server = createApp({
    uploadsRoot,
    reportToday: '2026-08-10',
    toteatAutomation: {
      async connect() { return { opened: true }; },
      async downloadSales() {
        return {
          filename: 'ventas-totales.csv',
          contentType: 'text/csv; charset=utf-8',
          buffer: Buffer.from('ID de orden\tFecha de creacion\tPago total\tDescuentos\norder-1\t2026-08-09\t119\t0')
        };
      },
      async downloadPaymentDetails() {
        return {
          filename: 'detalle-pagos.csv',
          contentType: 'text/csv; charset=utf-8',
          buffer: Buffer.from('FechaCierre\tComanda\tComentario General\tA Pagar\n09-08-26 08:30 a. m.\torder-1\tServir en el local\t0.119')
        };
      }
    }
  }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(uploadsRoot, { recursive: true, force: true });
  });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const upload = new FormData();
  upload.append('sales', new Blob(['ID de orden\tFecha de creacion\tHora de creacion\tPago total\tDescuentos\tID Producto\tNombre\tCantidad\tPrecio a Pagar\tDescuento\tCosto\tCategorías de Productos/Platos\norder-1\t2026-08-09\t08:30:00\t119\t0\tP1\tProducto Uno\t1\t119\t0\t20\tBebidas']), 'ventas-semana.csv');
  const inspection = await fetch(`http://127.0.0.1:${server.address().port}/api/uploads/weekly/inspect?location=store-1&week=2026-08-03`, {
    method: 'POST',
    body: upload
  }).then(response => response.json());
  await fetch(`http://127.0.0.1:${server.address().port}/api/uploads/weekly/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: inspection.token,
      dateFrom: '2026-08-09',
      dateTo: '2026-08-09',
      confirmed: true
    })
  });
  const recipeMaster = new FormData();
  recipeMaster.append('master-recipes', new Blob([
    'Id Producto\tNombre Producto\tId Ingrediente\tNombre Ingrediente\tCantidad Ingrediente\tUnidad Medida\tTasa Rendimiento\n' +
    'P1\tProducto Uno\tPAC003\tVaso Caliente 12 oz\t1\tUN\t97\n' +
    'P1\tProducto Uno\tPAC008\tTapa Vaso Caliente\t1\tUN\t97'
  ]), 'recetas-ui.txt');
  recipeMaster.append('master-recipes-from', '2026-08-01');
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/upload/master`, {
    method: 'POST', body: recipeMaster
  })).status, 200);

  const kardex = [
    ['Código', 'Nombre', 'Unidad', '2026-08-04', '', '', '', '2026-08-05', '', '', '', '2026-08-06', '', '', ''],
    ['', '', '', 'II - Inventario Inicial', 'BUY - Compras', 'USO - Consumo por Ventas', 'IF - Inventario Final', 'II - Inventario Inicial', 'BUY - Compras', 'USO - Consumo por Ventas', 'IF - Inventario Final', 'II - Inventario Inicial', 'BUY - Compras', 'USO - Consumo por Ventas', 'IF - Inventario Final'],
    ['P1', 'Producto Uno', 'UN', 10, 5, 3, 12, 12, 2, 4, 10, 9, 0, 0, 0]
  ].map(row => row.join('\t')).join('\n');
  const inventoryUpload = new FormData();
  inventoryUpload.append('kardex', new Blob([kardex]), 'kardex.csv');
  const waste = [
    ['Código', 'Nombre', 'Unidad', '2026-08-04', '', '', '', '2026-08-05', '', '', ''],
    ['', '', '', 'II - Inventario Inicial', 'BUY - Compras', 'MOV-IN - Transferencias entre Bodegas Entrantes', 'IF - Inventario Final', 'II - Inventario Inicial', 'BUY - Compras', 'MOV-IN - Transferencias entre Bodegas Entrantes', 'IF - Inventario Final'],
    ['P1', 'Producto Uno', 'UN', 0, 0, 2, 2, 2, 0, 3, 5]
  ].map(row => row.join('\t')).join('\n');
  inventoryUpload.append('waste', new Blob([waste]), 'merma.csv');
  inventoryUpload.append('marketing', new Blob(['Fecha\n2026-08-05']), 'marketing.csv');
  inventoryUpload.append('employees', new Blob(['Fecha\n2026-08-05']), 'employees.csv');
  inventoryUpload.append('purchases', new Blob([
    'Fecha emisión\tTipo Documento\tDocumento\tProveedor/Para\tNúmero identificador fiscal\tLin\tCod\tPRODUCTO\tQ.Rec\tUm.Rec\tCosto\tMonto neto\tDescuento\tMonto total\n' +
    '2026-08-05\tFactura\t100\tProveedor Prueba\t111\t1\tP1\tProducto Uno\t2\tUN\t500\t1000\t0\t1000'
  ]), 'compras.csv');
  const inventoryInspection = await fetch(`http://127.0.0.1:${server.address().port}/api/uploads/weekly/inspect?location=store-2&week=2026-08-03`, {
    method: 'POST', body: inventoryUpload
  }).then(response => response.json());
  await fetch(`http://127.0.0.1:${server.address().port}/api/uploads/weekly/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: inventoryInspection.token,
      dateFrom: '2026-08-04',
      dateTo: '2026-08-06',
      confirmed: true
    })
  });

  const warehouseKardex = [
    ['Código', 'Nombre', 'Unidad', '2026-08-05', '', '', '', '2026-08-06', '', '', ''],
    ['', '', '', 'II - Inventario Inicial', 'BUY - Compras', 'Costo', 'IF - Inventario Final', 'II - Inventario Inicial', 'TRN-OUT - Transformaciones Salientes', 'Costo', 'IF - Inventario Final'],
    ['P1', 'Producto Uno', 'UN', 10, 0, 0, 10, 10, 0, 0, 10]
  ].map(row => row.join('\t')).join('\n');
  const warehouseUpload = new FormData();
  warehouseUpload.append('kardex', new Blob([warehouseKardex]), 'bodega-kardex.csv');
  const warehouseInspection = await fetch(`http://127.0.0.1:${server.address().port}/api/uploads/weekly/inspect?location=main-warehouse&week=2026-08-03`, {
    method: 'POST', body: warehouseUpload
  }).then(response => response.json());
  await fetch(`http://127.0.0.1:${server.address().port}/api/uploads/weekly/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: warehouseInspection.token,
      dateFrom: '2026-08-05',
      dateTo: '2026-08-06',
      confirmed: true
    })
  });
  const branchOrder = {
    id: 'OC-20260809-120000-aaaaaaaa', sequence: 1, orderNumber: 'OC-000001', status: 'confirmed',
    createdAt: '2026-08-09T12:00:00.000Z', updatedAt: '2026-08-09T12:00:00.000Z', confirmedAt: '2026-08-09T12:00:00.000Z',
    location: { id: 'store-1', name: 'Tienda 1', type: 'store' },
    supplier: { key: 'code-spa', name: 'CODE SPA', taxId: '' },
    items: [{
      key: 'P1', code: 'P1', name: 'Producto Uno', internalUnit: 'UN', purchaseUnit: 'UN',
      unitsPerPurchaseUnit: 1, quantity: 5, internalQuantity: 5, unitCost: 0, total: 0
    }],
    total: 0
  };
  fs.writeFileSync(path.join(uploadsRoot, 'reports', 'purchase-orders', `${branchOrder.id}.json`), JSON.stringify(branchOrder));
  fs.writeFileSync(path.join(uploadsRoot, 'config', 'purchase-order-counter.json'), JSON.stringify({ last: 1 }));

  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: 'Resumen de ventas' }).waitFor({ state: 'visible' });
  const expandedLayout = await page.evaluate(() => ({
    sidebarWidth: document.querySelector('.sidebar').getBoundingClientRect().width,
    mainWidth: document.querySelector('.main-content').getBoundingClientRect().width,
    sidebarPosition: getComputedStyle(document.querySelector('.sidebar')).position
  }));
  assert.equal(expandedLayout.sidebarWidth, 280);
  assert.equal(expandedLayout.sidebarPosition, 'fixed');
  await page.getByRole('button', { name: 'Contraer menú lateral' }).click();
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width === 76);
  const collapsedLayout = await page.evaluate(() => ({
    mainWidth: document.querySelector('.main-content').getBoundingClientRect().width,
    navTextDisplay: getComputedStyle(document.querySelector('.nav-text')).display,
    saved: localStorage.getItem('brewit.sidebarCollapsed')
  }));
  assert.ok(collapsedLayout.mainWidth > expandedLayout.mainWidth + 190);
  assert.equal(collapsedLayout.navTextDisplay, 'none');
  assert.equal(collapsedLayout.saved, 'true');
  await page.reload();
  await page.getByRole('heading', { name: 'Resumen de ventas' }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width === 76);
  assert.equal(await page.getByRole('button', { name: 'Expandir menú lateral' }).getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: 'Expandir menú lateral' }).click();
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().width === 280);
  assert.equal(await page.evaluate(() => localStorage.getItem('brewit.sidebarCollapsed')), 'false');
  assert.equal(await page.getByRole('link', { name: 'General', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Resumen General Ventas' }).evaluate(link => {
    if (!link.classList.contains('active')) throw new Error('Resumen General Ventas no quedó como vista inicial activa.');
  });
  await page.evaluate(() => {
    productAnalysisOptions = { availablePeriod: { from: '2026-05-18', to: '2026-08-10' } };
  });
  for (const period of ['current-week', 'previous-week', 'current-month', 'previous-month', 'last-30-days', 'last-60-days', 'last-90-days', 'last-180-days', 'last-360-days']) {
    await page.evaluate(selectedPeriod => {
      document.getElementById('product-analysis-period').value = selectedPeriod;
      syncProductAnalysisPeriod();
    }, period);
    assert.equal(await page.locator('#product-analysis-date-from-field').getAttribute('hidden'), '');
    assert.equal(await page.locator('#product-analysis-date-to-field').getAttribute('hidden'), '');
    assert.match(await page.locator('#product-analysis-date-from').inputValue(), /^202[56]-\d{2}-\d{2}$/);
    assert.match(await page.locator('#product-analysis-date-to').inputValue(), /^202[56]-\d{2}-\d{2}$/);
  }
  await page.evaluate(() => {
    document.getElementById('product-analysis-period').value = 'custom';
    syncProductAnalysisPeriod();
  });
  assert.equal(await page.locator('#product-analysis-date-from-field').getAttribute('hidden'), null);
  assert.equal(await page.locator('#product-analysis-date-to-field').getAttribute('hidden'), null);
  assert.equal(await page.locator('#product-analysis-date-from').isEnabled(), true);
  assert.equal(await page.locator('#product-analysis-date-to').isEnabled(), true);
  await page.evaluate(() => {
    document.getElementById('product-analysis-period').value = 'last-30-days';
    syncProductAnalysisPeriod();
  });
  await page.getByRole('link', { name: 'Auditoría Transacciones' }).click();
  await page.getByRole('heading', { name: 'Auditoría de transacciones' }).waitFor();
  await page.locator('#transaction-audit-body .transaction-audit-row').first().waitFor();
  assert.equal(await page.locator('#transaction-audit-body .transaction-audit-row').count(), 1);
  await page.getByRole('button', { name: 'Venta antes de descuentos' }).click();
  assert.equal(await page.getByRole('button', { name: 'Venta antes de descuentos' }).locator('..').getAttribute('aria-sort'), 'descending');
  await page.locator('#transaction-audit-body .transaction-audit-row').first().click();
  await page.getByRole('heading', { name: /Detalle completo del pedido order-1/ }).waitFor();
  assert.equal(await page.locator('.transaction-audit-lines tbody tr').count(), 1);
  await page.getByRole('link', { name: 'Configuracion' }).click();
  await page.getByRole('heading', { name: 'Ubicaciones', exact: true }).waitFor();
  assert.equal(await page.locator('#company-export-decimal-system').inputValue(), 'comma');
  await page.locator('#company-export-decimal-system').selectOption('dot');
  await page.locator('#company-profile-form').getByRole('button', { name: 'Guardar datos de Brewit' }).click();
  await page.locator('#location-status').filter({ hasText: /formato de exportación actualizados/i }).waitFor();
  await page.getByRole('link', { name: 'Resumen General Ventas' }).click();
  await page.getByRole('heading', { name: 'Resumen de ventas' }).waitFor();

  const rankingItems = Array.from({ length: 55 }, (_, index) => ({
    code: `I${String(index + 1).padStart(3, '0')}`,
    name: `Ingrediente ${index + 1}`,
    supplierKey: 'unassigned',
    supplier: 'Proveedor no identificado',
    unit: 'UN',
    unitCost: 1,
    latestPurchaseCost: null,
    costChangePercent: null,
    usageQuantity: 55 - index,
    usageUnit: 'UN',
    usageCost: 55 - index,
    products: []
  }));
  const ingredientRankingRoute = route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      date: '2026-08-10',
      period: { from: '2026-07-12', to: '2026-08-10' },
      scope: { location: 'all', label: 'Todas las cafeterías', type: 'stores' },
      locations: [],
      suppliers: [],
      items: rankingItems,
      summary: { ingredientCount: 55, usedIngredientCount: 55, totalUsageCost: 1540, changedCostCount: 0 }
    })
  });
  await page.route('**/api/ingredients?**', ingredientRankingRoute);
  await page.getByRole('link', { name: 'Ingredientes', exact: true }).click();
  await page.locator('#ingredients-cost-ranking .ingredient-ranking-row').first().waitFor();
  assert.deepEqual(await page.locator('#ingredients-ranking-limit option').allTextContents(), ['Top 10', 'Top 20', 'Top 50']);
  assert.equal(await page.locator('#ingredients-cost-ranking .ingredient-ranking-row').count(), 10);
  await page.locator('#ingredients-ranking-limit').selectOption('20');
  assert.equal(await page.locator('#ingredients-cost-ranking .ingredient-ranking-row').count(), 20);
  await page.locator('#ingredients-ranking-limit').selectOption('50');
  assert.equal(await page.locator('#ingredients-cost-ranking .ingredient-ranking-row').count(), 50);
  await page.unroute('**/api/ingredients?**', ingredientRankingRoute);

  const findingSections = [
    ['products', 'Productos'], ['recipes', 'Recetas'], ['costs', 'Costos'], ['inventory', 'Inventarios'],
    ['purchase-orders', 'Órdenes de compra'], ['purchases', 'Compras'], ['sales', 'Ventas']
  ].map(([key, label]) => ({
    key,
    label,
    description: `Revisión de ${label}`,
    findings: key === 'sales' ? [{
      id: 'H-000001', number: 1, severity: 'high', title: 'Código vendido fuera del catálogo: X1',
      detail: 'Una venta requiere confirmación.', action: 'Revisar el código en Toteat.',
      code: 'X1', location: 'Tienda 1', date: '2026-08-09', observed: '1 fila',
      observations: '', closed: false, closedAt: null
    }] : []
  }));
  const findingsRoute = route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      generatedAt: '2026-08-10T12:00:00.000Z',
      period: { from: '2026-07-12', to: '2026-08-10' },
      scope: { location: 'all', label: 'Todas las ubicaciones', type: 'all' },
      locations: [],
      summary: { total: 1, open: 1, closed: 0, high: 1, medium: 0, low: 0, sectionsWithFindings: 1, salesRowsRead: 1, purchaseRowsRead: 0, ordersRead: 0, added: 1, reused: 0 },
      sections: findingSections,
      sources: [{ type: 'Catálogo', name: 'catalogo.xlsx', validFrom: '2026-08-01' }],
      warnings: []
    })
  });
  await page.route('**/api/findings?**', findingsRoute);
  const persistedUiFinding = findingSections.find(section => section.key === 'sales').findings[0];
  await page.route('**/api/findings/H-000001', async route => {
    const changes = route.request().postDataJSON();
    Object.assign(persistedUiFinding, changes, {
      closedAt: changes.closed ? '2026-08-10T12:05:00.000Z' : null,
      updatedAt: '2026-08-10T12:05:00.000Z'
    });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ finding: persistedUiFinding })
    });
  });
  await page.getByRole('link', { name: 'Hallazgos', exact: true }).click();
  await page.getByRole('heading', { name: 'Hallazgos que requieren revisión' }).waitFor();
  await page.locator('#findings-status').filter({ hasText: /1 hallazgo.*1 de prioridad alta/i }).waitFor();
  assert.equal(await page.locator('.findings-section').count(), 7);
  assert.equal(await page.locator('#findings-status-filter').inputValue(), 'open');
  assert.match(await page.locator('[data-section="sales"]').textContent(), /Hallazgo N.º 1.*Código vendido fuera del catálogo.*Revisión sugerida/s);
  await page.getByLabel('Observaciones del Hallazgo N.º 1').fill('Código revisado en Toteat.');
  await page.getByRole('button', { name: 'Guardar observaciones' }).click();
  await page.locator('.finding-save-status').filter({ hasText: 'Observaciones guardadas.' }).waitFor();
  assert.equal(persistedUiFinding.observations, 'Código revisado en Toteat.');
  await page.locator('#findings-status-filter').selectOption('all');
  await page.getByLabel('Marcar Hallazgo N.º 1 como cerrado').check();
  await page.locator('.finding-item.closed').waitFor();
  assert.equal(persistedUiFinding.closed, true);
  await page.locator('#findings-status-filter').selectOption('open');
  assert.equal(await page.locator('[data-section="sales"] .finding-item').count(), 0);
  assert.match(await page.locator('[data-section="sales"]').textContent(), /Sin hallazgos abiertos/);
  await page.locator('#findings-status-filter').selectOption('all');
  assert.equal(await page.locator('[data-section="sales"] .finding-item.closed').count(), 1);
  assert.equal(await page.locator('#findings-date-from').inputValue(), '2026-07-12');
  await page.unroute('**/api/findings?**', findingsRoute);
  await page.unroute('**/api/findings/H-000001');

  await page.getByRole('link', { name: 'Cargar Archivos' }).click();
  await page.getByRole('heading', { name: 'Cargar archivos' }).waitFor({ state: 'visible' });
  await page.locator('[data-weekly-field="sales"] .file-upload-state.uploaded').waitFor();

  assert.equal(await page.locator('#file-loader').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /New Order/i }).count(), 0);
  assert.deepEqual(await page.locator('#products-grouping option').allTextContents(), ['Por jerarquía', 'Todos juntos']);
  assert.equal(await page.locator('#week-select').count(), 0);
  assert.match(await page.locator('[data-weekly-field="sales"] .file-upload-state').textContent(), /Último archivo subido/);
  assert.match(await page.locator('[data-weekly-field="sales"] .file-upload-filename').textContent(), /ventas-semana\.csv.*1 carga/i);
  assert.equal(await page.locator('#latest-sales-transaction').count(), 0);
  await page.locator('[data-weekly-field="sales"] .file-upload-state').click();
  await page.locator('[data-weekly-field="sales"] .transaction-upload-history').waitFor();
  assert.match(await page.locator('[data-weekly-field="sales"] .transaction-upload-history').textContent(), /ventas-semana\.csv.*2026-08-09.*2026-08-09/s);
  await page.locator('[data-weekly-field="sales"] .file-upload-state').click();
  assert.equal(await page.locator('[data-weekly-field="kardex"] .file-upload-state').textContent(), 'Sin archivos subidos');
  assert.equal(await page.locator('[data-weekly-field="sales"]').getByRole('button', { name: 'Cargar nuevo archivo' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Detectar fechas y revisar' }).count(), 0);
  assert.equal(await page.locator('#previous-weeks').count(), 0);
  await page.locator('#file-sales').setInputFiles({
    name: 'ventas-coincidentes.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('ID de orden\tFecha de creacion\tPago total\tDescuentos\norder-1\t2026-08-09\t119\t0')
  });
  await page.locator('#transaction-overlap-notice').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#date-confirmation').evaluate(dialog => dialog.open), true);
  assert.match(await page.locator('.structure-validation-ok').textContent(), /Estructura verificada/);
  assert.equal(await page.locator('#replace-transactions-btn').isVisible(), true);
  assert.match(await page.locator('#transaction-overlap-notice').textContent(), /2026-08-09.*2026-08-09/);
  assert.equal(await page.locator('#date-confirmation-row').isVisible(), false);
  await page.getByRole('button', { name: 'Mantener existentes y agregar nuevos' }).click();
  await page.locator('#date-confirmation').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#file-sales').evaluate(input => input.files.length), 0);

  const paymentDetailsRow = page.locator('[data-weekly-field="payment-details"]');
  assert.equal(await paymentDetailsRow.getByText('Detalle Pagos', { exact: true }).count(), 1);
  assert.equal(await paymentDetailsRow.locator('.file-upload-state').textContent(), 'Sin archivos subidos');
  await page.locator('#file-payment-details').setInputFiles({
    name: 'detalle-pagos.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('FechaCierre\tComanda\tComentario General\tA Pagar\n09-08-26 10:00 a. m.\torder-1\tservir en el local\t0.119')
  });
  await page.locator('#date-confirmation').waitFor({ state: 'visible' });
  assert.match(await page.locator('#detected-files-list').textContent(), /Detalle Pagos.*detalle-pagos\.csv.*Estructura verificada/is);
  assert.equal(await page.locator('#date-confirmation-row').isVisible(), true);
  await page.locator('#dates-confirmed').check();
  await page.getByRole('button', { name: 'Confirmar y guardar registros' }).click();
  await page.locator('#date-confirmation').waitFor({ state: 'hidden' });
  await paymentDetailsRow.locator('.file-upload-state.uploaded').waitFor();
  assert.match(await paymentDetailsRow.locator('.file-upload-filename').textContent(), /detalle-pagos\.csv.*1 carga/i);

  await page.getByRole('link', { name: 'Resumen General Ventas' }).click();
  await page.getByRole('heading', { name: 'Resumen de ventas' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#report-location-filter').inputValue(), 'all');
  assert.equal(await page.locator('#report-location-filter option').count(), 3);
  assert.equal(await page.locator('#report-include-today').isChecked(), true);
  assert.equal(await page.locator('#report-cutoff-label').textContent(), 'Venta hoy');
  await page.locator('.report-cutoff-toggle').click();
  await page.locator('#report-reference-label').filter({ hasText: 'Venta del día anterior' }).waitFor();
  await page.locator('#report-yesterday-value').filter({ hasText: '100' }).waitFor();
  assert.match(await page.locator('#report-general-rank').textContent(), /#1 de 1/);
  assert.match(await page.locator('#report-week-range').textContent(), /03.*ago.*2026.*09.*ago.*2026/i);
  assert.equal(await page.locator('#intraday-title').textContent(), 'Venta acumulada del día anterior');
  assert.equal(await page.locator('#intraday-reference-title').textContent(), 'Día anterior');
  assert.match(await page.locator('#intraday-today-date').textContent(), /09.*ago.*2026/i);
  assert.match(await page.locator('#intraday-indicators').getAttribute('aria-label'), /día anterior/i);
  assert.equal(await page.locator('#intraday-sales-body tr').count(), 7);
  assert.match(await page.locator('#intraday-sales-body tr').first().locator('td').first().textContent(), /07:00.*09:00/);
  assert.match(await page.locator('#intraday-sales-body tr').last().locator('td').first().textContent(), /19:00.*cierre/);
  assert.equal(await page.locator('.sales-statistics-card').count(), 4);
  assert.equal(await page.locator('#sales-statistics-months tr').count(), 14);
  assert.equal(await page.locator('#sales-statistics-weeks tr').count(), 14);
  assert.equal(await page.locator('#sales-statistics-days tr').count(), 14);
  assert.equal(await page.locator('#sales-statistics-equivalent-days tr').count(), 14);
  assert.equal(await page.locator('.sales-statistics-variation').count(), 52);
  assert.match(await page.locator('#sales-statistics-days tr').first().textContent(), /09.*ago.*2026.*\+100\.0%.*\$100/i);
  assert.equal(await page.locator('#sales-statistics-days tr').last().locator('.sales-statistics-variation').count(), 0);
  assert.equal(await page.locator('#report-include-today').isChecked(), false);
  assert.equal(await page.locator('.summary-card.highlight .report-cutoff-toggle').count(), 1);
  assert.equal(await page.locator('#report-cutoff-label').textContent(), 'Venta día anterior');
  await page.locator('.report-cutoff-toggle').click();
  await page.locator('#report-reference-label').filter({ hasText: 'Venta de hoy' }).waitFor();
  assert.equal(await page.locator('#report-include-today').isChecked(), true);
  assert.equal(await page.locator('#intraday-title').textContent(), 'Venta acumulada de hoy');
  assert.equal(await page.locator('#intraday-reference-title').textContent(), 'Hoy');
  assert.match(await page.locator('#intraday-today-date').textContent(), /10.*ago.*2026/i);
  assert.equal(await page.locator('#report-cutoff-label').textContent(), 'Venta hoy');
  assert.equal(await page.locator('#report-week-chip').textContent(), 'Lun–hoy');
  assert.equal(await page.locator('#report-month-chip').textContent(), 'Mes–hoy');
  await page.locator('#report-upload-sales').click();
  await page.locator('#report-sales-location-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#report-sales-upload-location option').count(), 2);
  await page.locator('#cancel-report-sales-location').click();
  await page.locator('#report-location-filter').selectOption('store-2');
  await page.locator('#report-scope-description').filter({ hasText: 'Tienda 2' }).waitFor();
  assert.match(await page.locator('#report-yesterday-value').textContent(), /0/);
  await page.locator('#report-location-filter').selectOption('all');
  await page.locator('#report-scope-description').filter({ hasText: 'todas las cafeterías' }).waitFor();
  await page.locator('#report-location-filter').selectOption('store-1');
  await page.locator('#report-scope-description').filter({ hasText: 'Tienda 1' }).waitFor();
  const toteatDownloads = [];
  page.on('download', download => toteatDownloads.push(download.suggestedFilename()));
  await page.locator('#report-download-toteat-sales').click();
  await page.locator('#report-status').filter({
    hasText: 'Ventas y Detalle Pagos fueron descargados, validados y actualizados correctamente.'
  }).waitFor();
  assert.deepEqual(toteatDownloads, ['ventas-totales.csv', 'detalle-pagos.csv']);
  const downloadedTransactions = await fetch(`http://127.0.0.1:${server.address().port}/api/transactions?location=store-1`)
    .then(response => response.json());
  assert.equal(downloadedTransactions.files['payment-details'].fileCount, 2);
  assert.equal(downloadedTransactions.files['payment-details'].latest.originalName, 'detalle-pagos.csv');
  assert.equal(await page.locator('#date-confirmation').evaluate(dialog => dialog.open), false);
  const reportSalesChooserPromise = page.waitForEvent('filechooser');
  await page.locator('#report-upload-sales').click();
  const reportSalesChooser = await reportSalesChooserPromise;
  await reportSalesChooser.setFiles({
    name: 'ventas-desde-resumen.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('ID de orden\tFecha de creacion\tPago total\tDescuentos\nreport-upload-test\t2026-08-09\t119\t0')
  });
  await page.locator('#date-confirmation').waitFor({ state: 'visible' });
  assert.match(await page.locator('#detected-files-list').textContent(), /ventas-desde-resumen\.csv.*2026-08-09/s);
  await page.locator('#cancel-transaction-confirmation').click();
  await page.locator('#report-status').filter({ hasText: 'Carga cancelada' }).waitFor();
  await page.locator('#report-location-filter').selectOption('all');
  await page.locator('#report-scope-description').filter({ hasText: 'todas las cafeterías' }).waitFor();

  await page.getByRole('link', { name: 'Análisis y Estadísticas', exact: true }).click();
  await page.getByRole('heading', { name: 'Panel de indicadores comerciales' }).waitFor();
  await page.locator('#sales-dashboard-status').filter({ hasText: /archivo\(s\) de ventas/i }).waitFor();
  assert.equal(await page.locator('.sales-kpi-card').count(), 4);
  assert.match(await page.locator('.sales-kpi-card').nth(1).textContent(), /día anterior.*100/is);
  assert.equal(await page.locator('#sales-location-body tr').count(), 2);
  assert.equal(await page.locator('#mercadopago-period-body tr').count(), 3);
  assert.equal(await page.locator('#mercadopago-month-history tr').count(), 6);
  assert.equal(await page.locator('#mercadopago-week-history tr').count(), 8);
  assert.deepEqual(await page.locator('#sales-service-mode-period option').allTextContents(), [
    'Mes actual', 'Semana actual', 'Semana anterior', 'Últimos 30 días', 'Definir rango de fechas'
  ]);
  await page.locator('#sales-service-mode-period').selectOption('month');
  assert.match(await page.locator('.sales-service-mode-card.dineIn').textContent(), /Servir en el local.*1 pedido.*\$100/is);
  assert.match(await page.locator('.sales-service-mode-card.dineIn').textContent(), /Ticket promedio.*\$100/is);
  assert.match(await page.locator('#sales-service-mode-status').textContent(), /1 de 1 pedidos.*100,0%/i);
  assert.match(await page.locator('#sales-service-mode-hierarchies').textContent(), /Bebidas.*\$100.*1 pedido/is);
  assert.match(await page.locator('#sales-service-mode-hierarchy-totals').textContent(), /Total jerarquías.*\$0.*\$100.*\$0.*\$100/is);
  assert.match(await page.locator('#sales-avoided-cups').textContent(), /Vaso.*Vaso Caliente 12 oz.*PAC003.*1 UN.*Costo de compra o maestro no disponible/is);
  assert.match(await page.locator('#sales-avoided-cups').textContent(), /Tapa.*Tapa Vaso Caliente.*PAC008.*1 UN.*Costo de compra o maestro no disponible/is);
  assert.match(await page.locator('#sales-avoided-cups').textContent(), /Ahorro total valorizado.*\$0.*2 tipo\(s\) sin costo de compra o maestro/is);
  await page.locator('#sales-service-mode-period').selectOption('custom');
  assert.equal(await page.locator('#sales-service-mode-custom-range').isVisible(), true);
  await page.locator('#sales-service-mode-from').fill('2026-08-09');
  await page.locator('#sales-service-mode-to').fill('2026-08-09');
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/sales/dashboard?')
      && response.url().includes('serviceDateFrom=2026-08-09') && response.status() === 200),
    page.locator('#apply-sales-service-mode-range').click()
  ]);
  await page.locator('#sales-service-mode-status').filter({ hasText: /09.*ago.*2026.*1 de 1 pedidos/is }).waitFor();
  assert.match(await page.locator('.sales-service-mode-card.dineIn').textContent(), /1 pedido.*\$100/is);
  await page.locator('#sales-insight-period').selectOption('month');
  assert.match(await page.locator('#sales-top-products').textContent(), /Producto Uno/);
  await page.getByRole('button', { name: 'Ver detalle de Bebidas' }).click();
  assert.equal(await page.locator('#sales-hierarchy-title').textContent(), 'Productos vendidos');
  assert.match(await page.locator('#sales-hierarchy-share').textContent(), /Producto Uno.*P1.*1 un\..*Margen -400,?\.?(0)?%.*\$100/s);
  assert.equal(await page.locator('#sales-hierarchy-share').getAttribute('class'), 'sales-share-list hierarchy-product-list');
  assert.equal(await page.locator('#sales-hierarchy-back').isVisible(), true);
  await page.locator('#sales-hierarchy-back').click();
  assert.equal(await page.locator('#sales-hierarchy-title').textContent(), 'Venta por jerarquía');
  await page.locator('#hourly-demand-status').filter({ hasText: /promedio calculado/i }).waitFor();
  assert.equal(await page.locator('#hourly-demand-body tr').count(), 7);
  assert.match(await page.locator('#hourly-demand-body tr').first().textContent(), /07:00–09:00.*1.*\$100/s);
  assert.equal(await page.locator('#hourly-demand-body tr').first().locator('td').first().textContent(), '1,0');
  assert.equal(await page.locator('#hourly-demand-body tr').first().locator('td').nth(1).textContent(), '1,0 – 1,0');
  assert.equal(await page.locator('#hourly-demand-body tr').first().locator('td').nth(3).textContent(), '$100 – $100');
  assert.equal(await page.locator('#hourly-demand-foot td').first().textContent(), '1,0');
  assert.match(await page.locator('#hourly-demand-foot td').nth(1).textContent(), /1,0 – 1,0/);
  assert.match(await page.locator('#hourly-demand-foot td').nth(3).textContent(), /\$100 – \$100/);
  const hourlyTotalAlignments = await page.locator('#hourly-demand-foot .hourly-total-min-max').evaluateAll(elements => elements.map(element => {
    const button = element.querySelector('.hourly-demand-chart-button');
    const wrapperBounds = element.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    return {
      textAlign: getComputedStyle(element).textAlign,
      position: getComputedStyle(element).position,
      buttonPosition: getComputedStyle(button).position,
      buttonIsOnRight: buttonBounds.left > wrapperBounds.right
    };
  }));
  assert.deepEqual(hourlyTotalAlignments, [
    { textAlign: 'right', position: 'relative', buttonPosition: 'absolute', buttonIsOnRight: true },
    { textAlign: 'right', position: 'relative', buttonPosition: 'absolute', buttonIsOnRight: true }
  ]);
  await page.locator('#hourly-demand-foot .hourly-demand-chart-button[data-metric="units"]').click();
  assert.equal(await page.locator('#hourly-demand-chart-dialog').evaluate(dialog => dialog.open), true);
  assert.equal(await page.locator('#hourly-demand-chart-dialog').evaluate(dialog => getComputedStyle(dialog).resize), 'both');
  assert.match(await page.locator('#hourly-demand-chart-context').textContent(), /Todas las jerarquías.*09.*ago.*2026/i);
  assert.match(await page.locator('#hourly-demand-chart-legend').textContent(), /07:00–09:00/);
  assert.equal(await page.locator('#hourly-demand-chart .hourly-chart-segment').count(), 1);
  assert.equal(await page.locator('#hourly-demand-chart .hourly-chart-weekday-label').textContent(), 'D');
  assert.deepEqual(await page.locator('#hourly-demand-chart-order option').allTextContents(), [
    'Secuencia cronológica', 'Agrupar por día de semana'
  ]);
  await page.locator('#hourly-demand-chart-order').selectOption('weekday');
  assert.equal(await page.locator('#hourly-demand-chart .hourly-chart-segment').count(), 1);
  assert.equal(await page.locator('#hourly-demand-chart .hourly-chart-weekday-label').textContent(), 'D');
  await page.locator('#close-hourly-demand-chart').click();
  await page.locator('#hourly-demand-foot .hourly-demand-chart-button[data-metric="sales"]').click();
  assert.equal(await page.locator('#hourly-demand-chart-eyebrow').textContent(), 'Facturación por día');
  assert.equal(await page.locator('#hourly-demand-chart-heading').textContent(), 'Facturación diaria por franja horaria');
  assert.equal(await page.locator('#hourly-demand-chart .hourly-chart-segment').count(), 1);
  assert.equal(await page.locator('#hourly-demand-chart .hourly-chart-total-label').textContent(), '$100');
  assert.match(await page.locator('#hourly-demand-chart .hourly-chart-segment title').textContent(), /\$100 facturación neta/);
  await page.locator('#close-hourly-demand-chart').click();
  assert.deepEqual(await page.locator('#hourly-demand-mode option').allTextContents(), [
    'Día específico', 'Promedio últimos días abiertos', 'Promedio mismos días', 'Promedio días hábiles',
    'Semana actual', 'Semana anterior', 'Mes actual', 'Mes anterior',
    'Últimos 30 días', 'Últimos 60 días', 'Últimos 90 días', 'Últimos 180 días', 'Últimos 360 días'
  ]);
  assert.deepEqual(await page.locator('.hourly-demand-action-stack button').evaluateAll(buttons => buttons.map(button => button.id)), [
    'generate-hourly-analysis', 'refresh-hourly-demand'
  ]);
  await page.locator('#hourly-demand-mode').selectOption('current-week');
  assert.equal(await page.locator('#hourly-demand-date').isDisabled(), true);
  assert.equal(await page.locator('#hourly-demand-days').isDisabled(), true);
  await page.locator('#hourly-demand-mode').selectOption('last-360-days');
  assert.equal(await page.locator('#hourly-demand-date').isDisabled(), true);
  assert.equal(await page.locator('#hourly-demand-days').isDisabled(), true);
  await page.locator('#hourly-demand-mode').selectOption('recent');
  assert.equal(await page.locator('#hourly-demand-date').isEnabled(), true);
  assert.equal(await page.locator('#hourly-demand-days').isEnabled(), true);
  await page.locator('#hourly-demand-hierarchies .hourly-hierarchy-button').filter({ hasText: 'Bebidas' }).click();
  assert.match(await page.locator('#hourly-demand-context').textContent(), /Todas las jerarquías.*Bebidas/);
  assert.match(await page.locator('#hourly-demand-hierarchies').textContent(), /Producto Uno.*P1/);
  await page.locator('#generate-hourly-analysis').click();
  assert.equal(await page.locator('#hourly-analysis-options-dialog').evaluate(dialog => dialog.open), true);
  assert.deepEqual(await page.locator('[data-hourly-analysis-level]').evaluateAll(buttons => buttons.map(button => button.innerText.replace(/\s+/g, ' ').trim())), [
    'Nivel general Resumen ejecutivo, hallazgos y anexo estadístico general.',
    'General + jerarquías de producto Agrega comparaciones, tendencias, participación y anomalías por jerarquía.',
    'General + jerarquías + productos Incorpora además el comportamiento individual de cada producto.'
  ]);
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/sales/hourly-analysis?')
      && response.url().includes('analysisLevel=general') && response.status() === 200),
    page.locator('[data-hourly-analysis-level="general"]').click()
  ]);
  await page.locator('#hourly-analysis-status').filter({ hasText: /análisis completo/i }).waitFor();
  assert.equal(await page.locator('#hourly-analysis-dialog').evaluate(dialog => dialog.open), true);
  assert.match(await page.locator('#hourly-analysis-context').textContent(), /Todas las cafeterías.*Bebidas.*Nivel general.*09.*ago.*2026.*1 día/i);
  assert.equal(await page.locator('#hourly-analysis-breakdowns .hourly-analysis-breakdown').count(), 0);
  assert.match(await page.locator('#hourly-analysis-metrics').textContent(), /Promedio diario.*1,0 unidades.*Facturación promedio.*\$100/is);
  assert.match(await page.locator('#hourly-analysis-executive').textContent(), /Se analizaron 1 día.*promedio diario.*1,0 unidades.*\$100/is);
  assert.match(await page.locator('#hourly-analysis-findings').textContent(), /Calidad de la muestra.*Concentración horaria/is);
  assert.equal(await page.locator('#hourly-analysis-daily-body tr').count(), 1);
  assert.equal(await page.locator('#hourly-analysis-bucket-body tr').count(), 7);
  assert.equal(await page.locator('#hourly-analysis-weekday-body tr').count(), 1);
  assert.equal(await page.locator('#hourly-analysis-methodology li').count(), 5);
  assert.equal(await page.locator('#print-hourly-analysis').isVisible(), true);
  await page.locator('#close-hourly-analysis').click();
  await page.locator('#generate-hourly-analysis').click();
  await Promise.all([
    page.waitForResponse(response => response.url().includes('analysisLevel=hierarchy') && response.status() === 200),
    page.locator('[data-hourly-analysis-level="hierarchy"]').click()
  ]);
  assert.equal(await page.locator('#hourly-analysis-breakdowns .hourly-analysis-breakdown').count(), 1);
  assert.match(await page.locator('[data-analysis-level="hierarchy"]').textContent(), /Comparación entre jerarquías.*Bebidas.*100,0%/is);
  assert.equal(await page.locator('[data-analysis-level="product"]').count(), 0);
  await page.locator('#close-hourly-analysis').click();
  await page.locator('#generate-hourly-analysis').click();
  await Promise.all([
    page.waitForResponse(response => response.url().includes('analysisLevel=product') && response.status() === 200),
    page.locator('[data-hourly-analysis-level="product"]').click()
  ]);
  assert.equal(await page.locator('#hourly-analysis-breakdowns .hourly-analysis-breakdown').count(), 2);
  assert.equal(await page.locator('[data-breakdown-level="hierarchy"] tbody tr').count(), 1);
  assert.equal(await page.locator('[data-breakdown-level="product"] tbody tr').count(), 1);
  assert.match(await page.locator('[data-breakdown-level="product"] tbody').textContent(), /P1.*Producto Uno.*Bebidas/is);
  await page.locator('#close-hourly-analysis').click();
  assert.equal(await page.locator('.content-layout').isVisible(), false);

  await page.getByRole('link', { name: 'Ventas por Ingredientes' }).click();
  await page.getByRole('heading', { name: 'Ventas por ingredientes' }).waitFor();
  assert.equal(await page.locator('#sales-ingredients-location option').count(), 3);
  assert.equal(await page.getByRole('button', { name: 'Generar reporte' }).isDisabled(), true);
  await page.locator('#sales-ingredients-status').filter({ hasText: /maestro de productos e ingredientes/i }).waitFor();

  await page.getByRole('link', { name: 'Compras', exact: true }).click();
  await page.getByRole('heading', { name: 'Historial de compras e insumos' }).waitFor();
  assert.equal(await page.locator('#purchases-location-filter option').count(), 4);
  assert.match(await page.locator('#purchases-location-filter option').last().textContent(), /Bodega principal/i);
  assert.equal(await page.locator('#purchases-product-filter').getAttribute('placeholder'), 'Código o nombre');
  await page.locator('.purchases-table tbody tr').waitFor();
  const purchaseHeaders = page.locator('.purchases-table').first().locator('th');
  assert.equal(await purchaseHeaders.nth(7).innerText(), 'Unidades x\nUDC');
  assert.equal(await purchaseHeaders.nth(8).innerText(), 'Unidad\nMedida');
  assert.equal(await purchaseHeaders.nth(9).innerText(), 'Costo UDC\nregistrado');
  assert.equal(await purchaseHeaders.nth(12).innerText(), 'Precio Unit.\nefectivo');
  assert.equal(await page.getByRole('button', { name: 'Imprimir / PDF' }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Exportar Excel' }).isEnabled(), true);
  await page.evaluate(() => {
    window.__purchasesPrintCalled = false;
    window.print = () => { window.__purchasesPrintCalled = true; };
  });
  await page.getByRole('button', { name: 'Imprimir / PDF' }).click();
  assert.equal(await page.evaluate(() => window.__purchasesPrintCalled), true);
  const purchasesDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar Excel' }).click();
  const purchasesDownload = await purchasesDownloadPromise;
  assert.match(purchasesDownload.suggestedFilename(), /^historial-compras-2026-08-05-2026-08-05\.xlsx$/);
  const purchasesWorkbook = XLSX.readFile(await purchasesDownload.path(), { cellStyles: true });
  assert.deepEqual(purchasesWorkbook.SheetNames, ['Información', 'Compras']);
  assert.equal(purchasesWorkbook.Sheets.Compras.A1.v, 'Fecha');
  assert.equal(purchasesWorkbook.Sheets.Compras.J2.v, 2);
  assert.equal(purchasesWorkbook.Sheets.Compras.J2.z, '#,##0');
  assert.match(purchasesWorkbook.Props.Comments, /1,234\.56/);
  assert.equal(await page.locator('.content-layout').isVisible(), false);

  await page.getByRole('link', { name: 'Configuracion' }).click();
  await page.locator('#company-export-decimal-system').selectOption('comma');
  await page.locator('#company-profile-form').getByRole('button', { name: 'Guardar datos de Brewit' }).click();
  await page.locator('#location-status').filter({ hasText: /formato de exportación actualizados/i }).waitFor();

  await page.getByRole('link', { name: 'Proyección de Compras' }).click();
  await page.getByRole('heading', { name: 'Proyección de compras' }).waitFor();
  await page.locator('#projection-location-filter').selectOption('store-2');
  await page.locator('#purchase-projection-status').filter({ hasText: /Consumo considerado/i }).waitFor();
  assert.equal(await page.locator('#purchase-projection-body tr[data-key]').count(), 1);
  const projectionRow = page.locator('#purchase-projection-body tr[data-key]').first();
  assert.equal(await page.locator('.purchase-projection-table th').nth(4).innerText(), 'Unidad\ninterna');
  assert.equal(await page.locator('.purchase-projection-table th').nth(7).innerText(), 'Consumo y TRN-OUT\n30 días');
  assert.equal(await page.locator('.purchase-projection-table th').nth(9).innerText(), 'Cobertura\nactual');
  assert.equal(await page.locator('.purchase-projection-table th').nth(13).innerText(), 'Sugerencia\ninterna');
  assert.equal(await page.locator('.purchase-projection-table th').nth(19).innerText(), 'Costo UDC\nestimado');
  assert.match(await page.locator('.purchase-projection-table thead th').nth(5).textContent(), /Unidades x\s*empaque/);
  assert.equal(await page.locator('.projection-package-input').inputValue(), '1');
  assert.equal(await projectionRow.locator('td').nth(6).textContent(), '0,00');
  assert.equal(await projectionRow.locator('td').nth(7).textContent(), '7,00');
  assert.equal(await projectionRow.locator('td').nth(8).textContent(), '0,23');
  assert.equal(await projectionRow.locator('td').nth(9).textContent(), '0,0 días');
  assert.equal(await projectionRow.locator('td').nth(9).getAttribute('class'), 'projection-coverage-low');
  assert.equal(await projectionRow.locator('td').nth(12).textContent(), '4,0 UN');
  assert.equal(await page.locator('.projection-managed-input').isChecked(), false);
  assert.equal(await page.locator('.projection-min-input').inputValue(), '7');
  assert.equal(await page.locator('.projection-max-input').inputValue(), '14');
  assert.match(await page.locator('#purchase-projection-body').textContent(), /Producto Uno.*Proveedor Prueba.*UN/s);
  await page.locator('.projection-managed-input').check();
  assert.match(await page.locator('#purchase-projection-summary').textContent(), /1 ítem\(s\) administrados/);
  await page.locator('#projection-supplier-filter').selectOption('111');
  assert.equal(await page.getByRole('button', { name: 'Generar Orden de Compra PDF' }).isEnabled(), true);
  await page.evaluate(() => {
    window.__purchaseOrderPrintCalled = false;
    window.print = () => { window.__purchaseOrderPrintCalled = true; };
  });
  await page.getByRole('button', { name: 'Generar Orden de Compra PDF' }).click();
  await page.getByRole('dialog', { name: 'Nueva orden de compra' }).waitFor();
  assert.equal(await page.locator('#purchase-order-editor-body tr[data-key]').count(), 1);
  assert.equal(await page.locator('.purchase-order-cost').inputValue(), '500');
  assert.equal(await page.locator('.purchase-order-cost').getAttribute('inputmode'), 'numeric');
  assert.equal(await page.locator('.purchase-order-quantity').getAttribute('step'), '1');
  await page.locator('.purchase-order-quantity').fill('4');
  await page.locator('.purchase-order-quantity').press('ArrowUp');
  assert.equal(await page.locator('.purchase-order-quantity').inputValue(), '5');
  await page.locator('.purchase-order-quantity').press('ArrowDown');
  assert.equal(await page.locator('.purchase-order-quantity').inputValue(), '4');
  await page.locator('.purchase-order-quantity').fill('4.5');
  assert.match(await page.locator('.purchase-order-row-warning').textContent(), /no múltiplo del empaque.*1 UN/i);
  await page.locator('.purchase-order-quantity').fill('4');
  assert.doesNotMatch(await page.locator('.purchase-order-row-warning').textContent(), /no múltiplo del empaque/i);
  await page.getByRole('button', { name: 'Confirmar y guardar orden' }).click();
  await page.locator('#purchase-order-editor-status').filter({ hasText: /guardada correctamente/i }).waitFor();
  await page.getByRole('button', { name: 'Imprimir / PDF' }).click();
  assert.equal(await page.evaluate(() => window.__purchaseOrderPrintCalled), true);
  await page.getByRole('button', { name: 'Cerrar' }).click();
  await page.getByRole('button', { name: 'Órdenes de Compra Pasadas' }).click();
  const pastOrdersDialog = page.getByRole('dialog', { name: 'Órdenes de Compra Pasadas' });
  await pastOrdersDialog.waitFor();
  await page.locator('.past-purchase-order-card').waitFor();
  assert.equal(await page.locator('.past-purchase-order-card').count(), 1);
  await pastOrdersDialog.getByRole('button', { name: 'Ocultar' }).click();
  await page.locator('#past-purchase-orders-status').filter({ hasText: /ocultada correctamente/i }).waitFor();
  assert.equal(await page.locator('.past-purchase-order-card').count(), 0);
  await page.locator('#show-hidden-purchase-orders').check();
  await page.locator('.past-purchase-order-card.is-hidden').waitFor();
  assert.equal(await page.locator('.past-purchase-order-card.is-hidden').count(), 1);
  await pastOrdersDialog.getByRole('button', { name: 'Mostrar' }).click();
  await page.locator('#past-purchase-orders-status').filter({ hasText: /mostrada correctamente/i }).waitFor();
  assert.equal(await page.locator('.past-purchase-order-card.is-hidden').count(), 0);
  await pastOrdersDialog.getByRole('button', { name: 'Cerrar' }).click();
  await page.getByRole('button', { name: 'OC', exact: true }).click();
  const selectedOrdersDialog = page.getByRole('dialog', { name: 'Órdenes consideradas en la proyección' });
  await selectedOrdersDialog.waitFor();
  assert.equal(await page.locator('#projection-purchase-orders-body tr').count(), 1);
  assert.match(await page.locator('#projection-purchase-orders-body tr').first().textContent(), /OC-000002.*Proveedor Prueba/s);
  await page.locator('.projection-purchase-order-input').check();
  await selectedOrdersDialog.getByRole('button', { name: 'Aplicar y actualizar cálculo' }).click();
  await projectionRow.locator('td').nth(14).filter({ hasText: '4,0 UN' }).waitFor();
  assert.equal(await projectionRow.locator('td').nth(14).getAttribute('class'),
    'projection-purchase-order-quantity projection-purchase-order-sufficient');
  await page.locator('.projection-min-input').fill('0');
  assert.equal(await projectionRow.locator('td').nth(9).getAttribute('class'), null);
  await page.locator('.projection-min-input').fill('10');
  await page.locator('.projection-max-input').fill('20');
  await page.locator('.projection-package-input').fill('6');
  await projectionRow.locator('td').nth(12).filter({ hasText: '6,0 UN' }).waitFor();
  assert.equal(await projectionRow.locator('td').nth(9).getAttribute('class'), 'projection-coverage-low');
  assert.equal(await projectionRow.locator('td').nth(14).getAttribute('class'),
    'projection-purchase-order-quantity projection-purchase-order-short');
  await page.getByRole('button', { name: 'Guardar criterios' }).click();
  await page.locator('#purchase-projection-status').filter({ hasText: /Consumo considerado/i }).waitFor();
  assert.equal(await page.locator('.projection-min-input').inputValue(), '10');
  assert.equal(await page.locator('.projection-max-input').inputValue(), '20');
  assert.equal(await page.locator('.projection-package-input').inputValue(), '6');
  assert.equal(await page.locator('.projection-managed-input').isChecked(), true);
  await projectionRow.locator('td').nth(12).filter({ hasText: '6,0 UN' }).waitFor();
  assert.equal(await projectionRow.locator('td').nth(14).textContent(), '4,0 UN');
  assert.equal(await projectionRow.locator('td').nth(14).getAttribute('class'),
    'projection-purchase-order-quantity projection-purchase-order-short');
  await page.locator('#projection-only-managed').check();
  assert.equal(await page.locator('#purchase-projection-body tr[data-key]').count(), 1);

  await page.locator('#projection-only-managed').uncheck();
  await page.locator('#projection-only-required').uncheck();
  await page.locator('#projection-location-filter').selectOption('main-warehouse');
  await page.locator('#purchase-projection-status').filter({ hasText: /Consumo considerado/i }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'OC Suc' }).isVisible(), true);
  assert.equal(await page.locator('#projection-new-coverage-header').isVisible(), true);
  const warehouseProjectionRow = page.locator('#purchase-projection-body tr[data-key]').first();
  assert.equal(await warehouseProjectionRow.locator('td').nth(12).textContent(), '5 UN');
  assert.equal(await warehouseProjectionRow.locator('td').nth(16).textContent(), '—');
  await page.getByRole('button', { name: 'OC Suc' }).click();
  await page.getByRole('dialog', { name: 'Órdenes de compra de sucursales' }).waitFor();
  assert.equal(await page.locator('#projection-branch-orders-body tr').count(), 2);
  const storeOneBranchRow = page.locator('#projection-branch-orders-body tr[data-location-id="store-1"]');
  assert.match(await storeOneBranchRow.textContent(), /Tienda 1.*OC-000001/s);
  assert.equal(await storeOneBranchRow.locator('.projection-branch-order-date').getAttribute('class'), 'projection-branch-order-date recent');
  await storeOneBranchRow.locator('.projection-branch-location-input').uncheck();
  await page.getByRole('button', { name: 'Aplicar y actualizar cálculo' }).click();
  await warehouseProjectionRow.locator('td').nth(12).filter({ hasText: '0 UN' }).waitFor();

  await page.getByRole('button', { name: 'Órdenes tentativas' }).click();
  const tentativeOrdersDialog = page.getByRole('dialog', { name: 'Órdenes de compra tentativas' });
  await tentativeOrdersDialog.waitFor();
  assert.equal(await page.locator('#tentative-orders-scope option').count(), 4);
  await page.locator('#tentative-orders-scope').selectOption('all');
  await tentativeOrdersDialog.getByRole('button', { name: 'Generar tentativas' }).click();
  await page.locator('#tentative-purchase-orders-status').filter({ hasText: /Nada se ha guardado todavía/i }).waitFor();
  const locationsFromAllScope = await page.evaluate(() => tentativePurchaseOrdersState.locations.map(location => location.id));
  assert.equal(locationsFromAllScope.includes('store-2'), true);
  assert.equal(locationsFromAllScope.includes('main-warehouse'), true);
  await page.locator('#tentative-orders-scope').selectOption('store-2');
  await tentativeOrdersDialog.getByRole('button', { name: 'Generar tentativas' }).click();
  await page.locator('#tentative-purchase-orders-status').filter({ hasText: /Se reemplazaron 1 tentativa.*ubicaciones seleccionadas/i }).waitFor();
  const regeneratedTentativeState = await page.evaluate(() => ({
    locationIds: tentativePurchaseOrdersState.locations.map(location => location.id),
    storeTwoSuppliers: tentativePurchaseOrdersState.locations.find(location => location.id === 'store-2').groups.map(group => group.supplier.key)
  }));
  assert.equal(regeneratedTentativeState.locationIds.includes('main-warehouse'), true);
  assert.equal(new Set(regeneratedTentativeState.storeTwoSuppliers).size, regeneratedTentativeState.storeTwoSuppliers.length);
  assert.equal(await page.locator('#tentative-orders-location').inputValue(), 'store-2');
  assert.equal(await page.locator('#tentative-orders-supplier').inputValue(), '111');
  await page.locator('#tentative-orders-buying-body tr[data-key]').waitFor();
  assert.equal(await page.locator('#tentative-orders-buying-body tr[data-key]').count(), 1);
  assert.equal(await page.locator('.tentative-order-quantity').getAttribute('step'), '1');
  assert.match(await page.locator('#tentative-orders-other-body').textContent(), /Todos los productos administrados/i);
  const ordersBeforeTentativeConfirmation = await page.evaluate(() =>
    fetch('/api/purchase-orders?location=store-2').then(response => response.json()));
  assert.equal(ordersBeforeTentativeConfirmation.orders.length, 1);
  await page.locator('.tentative-order-quantity').fill('5');
  assert.match(await page.locator('.tentative-order-row-warning').textContent(), /no múltiplo del empaque.*6 UN/i);
  await page.locator('.tentative-order-quantity').fill('6');
  assert.doesNotMatch(await page.locator('.tentative-order-row-warning').textContent(), /no múltiplo del empaque/i);
  assert.equal(await page.locator('#tentative-order-total').textContent(), '$3.000');
  await page.getByRole('button', { name: 'Confirmar orden definitiva' }).click();
  await page.locator('#tentative-purchase-orders-status').filter({ hasText: /guardada como OC-000003/i }).waitFor();
  assert.equal(await page.locator('#print-confirmed-tentative-order').isVisible(), true);
  const ordersAfterTentativeConfirmation = await page.evaluate(() =>
    fetch('/api/purchase-orders?location=store-2').then(response => response.json()));
  assert.equal(ordersAfterTentativeConfirmation.orders.length, 2);
  await tentativeOrdersDialog.getByRole('button', { name: 'Generar tentativas' }).click();
  await page.locator('#tentative-purchase-orders-status').filter({ hasText: /1 orden.*tentativa.*generada/i }).waitFor();
  assert.equal(await page.evaluate(() => {
    const location = tentativePurchaseOrdersState.locations.find(item => item.id === 'store-2');
    return location.groups.length === 1 && location.groups[0].confirmedOrder === null;
  }), true);
  const definitiveOrdersAfterRegeneration = await page.evaluate(() =>
    fetch('/api/purchase-orders?location=store-2').then(response => response.json()));
  assert.equal(definitiveOrdersAfterRegeneration.orders.length, 2);
  await tentativeOrdersDialog.getByRole('button', { name: 'Cerrar' }).click();

  await page.getByRole('link', { name: 'Inventario' }).click();
  await page.getByRole('heading', { name: 'Fuentes para el informe de inventario' }).waitFor();
  assert.equal(await page.locator('#inventory-location-select option').count(), 3);
  await page.locator('#inventory-source-status').filter({ hasText: /todavía no tiene todas/i }).waitFor();
  assert.equal(await page.locator('#inventory-source-list .inventory-source-card').count(), 4);
  assert.equal(await page.locator('.content-layout').isVisible(), false);
  assert.match(await page.locator('#inventory-source-status').textContent(), /todavía no tiene todas/i);
  await page.locator('#inventory-location-select').selectOption('store-2');
  await page.locator('#inventory-source-status').filter({ hasText: /todas las fuentes requeridas/i }).waitFor();
  assert.equal(await page.locator('#process-inventory-report').isEnabled(), true);
  assert.equal(await page.locator('#current-inventory-report').isEnabled(), true);
  assert.equal(await page.locator('#inventory-date-from').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Ver resumen marketing' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Ver resumen colaboradores' }).count(), 1);
  await page.locator('#current-inventory-report').click();
  await page.locator('#current-inventory-date-dialog').waitFor({ state: 'visible' });
  const browserToday = await page.evaluate(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  });
  assert.equal(await page.locator('#current-inventory-date').inputValue(), browserToday);
  assert.equal(await page.locator('#current-inventory-date').getAttribute('max'), browserToday);
  await page.locator('#current-inventory-date').fill('2026-08-05');
  await page.locator('#confirm-current-inventory-report').click();
  await page.locator('#current-inventory-results').waitFor({ state: 'visible' });
  assert.match(await page.locator('#current-inventory-period').textContent(), /Inventario Final.*Fecha solicitada.*05.*ago.*2026.*Fecha del inventario utilizada.*05.*ago.*2026/i);
  assert.deepEqual(await page.locator('#current-inventory-table .inventory-sort-button').evaluateAll(buttons =>
    buttons.map(button => button.title.replace('Ordenar por ', ''))), [
    'Jerarquía', 'Código', 'Producto', 'Unidad', 'Inventario teórico', 'Costo unitario', 'Origen costo', 'Valorización'
  ]);
  assert.match(await page.locator('#current-inventory-table tbody').textContent(), /Sin jerarquía.*P1.*Producto Uno.*UN.*10,00.*\$500.*Compra 05 ago 2026.*\$5\.000/s);
  assert.equal(await page.locator('#current-inventory-missing-cost').isHidden(), true);
  await page.evaluate(() => {
    const data = currentInventoryTableState.data;
    data.report.items.push(
      { code: 'P2', name: 'Producto Beta', unit: 'UN', hierarchyPath: ['Productos', 'Bebidas'], quantity: 2.5, unitCost: 100, costAvailable: true, valuation: 250 },
      { code: 'P3', name: 'Producto Alfa', unit: 'UN', hierarchyPath: ['Productos', 'Bebidas'], quantity: 3, unitCost: 100, costAvailable: true, valuation: 300 },
      { code: 'P4', name: 'Producto Sin Costo', unit: 'UN', hierarchyPath: ['Productos', 'Bebidas'], quantity: 4, unitCost: 0, costSource: 'missing', costAvailable: false, valuation: 0 }
    );
    data.report.itemCount = 4;
    data.report.hierarchyCount = 2;
    data.report.totalValue = 5550;
    data.report.itemsWithoutCost = ['P4'];
    renderCurrentInventoryReport(data);
  });
  assert.equal(await page.locator('#current-inventory-table tbody tr').count(), 3);
  assert.match(await page.locator('#current-inventory-table tbody').textContent(), /Producto Alfa.*3,00.*\$100.*\$300.*Producto Beta.*2,50.*\$100.*\$250/s);
  assert.match(await page.locator('#current-inventory-table tfoot').textContent(), /TOTAL VALORIZADO.*\$5\.550/s);
  assert.equal(await page.locator('#current-inventory-missing-cost-table tbody tr').count(), 1);
  assert.match(await page.locator('#current-inventory-missing-cost-table tbody').textContent(), /P4.*Producto Sin Costo.*Sin costo/s);
  await page.locator('#current-inventory-search').fill('P4');
  assert.match(await page.locator('#current-inventory-table tbody').textContent(), /No hay productos/);
  assert.equal(await page.locator('#current-inventory-missing-cost-table tbody tr').count(), 1);
  assert.equal(await page.locator('#current-inventory-visible-count').textContent(), '0 valorizado(s) · 1 sin costo');
  await page.locator('#clear-current-inventory-search').click();
  const currentProductHeader = page.locator('#current-inventory-table th').nth(2);
  await currentProductHeader.locator('button').click();
  assert.equal(await currentProductHeader.getAttribute('aria-sort'), 'ascending');
  assert.match(await page.locator('#current-inventory-table tbody tr').first().textContent(), /Producto Alfa/);
  await currentProductHeader.locator('button').click();
  assert.equal(await currentProductHeader.getAttribute('aria-sort'), 'descending');
  assert.match(await page.locator('#current-inventory-table tbody tr').first().textContent(), /Producto Uno/);
  assert.equal(await page.locator('#current-inventory-results').getByRole('button', { name: 'Imprimir / PDF' }).count(), 1);
  const currentInventoryDownloadPromise = page.waitForEvent('download');
  await page.locator('#current-inventory-results').getByRole('button', { name: 'Exportar Excel' }).click();
  const currentInventoryDownload = await currentInventoryDownloadPromise;
  const currentInventoryWorkbook = XLSX.readFile(await currentInventoryDownload.path(), { cellStyles: true });
  assert.equal(currentInventoryWorkbook.SheetNames.includes('Inventario valorizado'), true);
  assert.equal(currentInventoryWorkbook.SheetNames.includes('Productos sin costo'), true);
  assert.match(currentInventoryWorkbook.Sheets['Inventario valorizado'].A1.v, /Jerarquía/);
  assert.match(currentInventoryWorkbook.Sheets['Productos sin costo'].A1.v, /Jerarquía/);
  assert.equal(currentInventoryWorkbook.Sheets['Inventario valorizado'].E2.t, 'n');
  assert.equal(currentInventoryWorkbook.Sheets['Inventario valorizado'].E2.z, '#.##0,00');
  assert.match(currentInventoryWorkbook.Props.Comments, /1\.234,56/);
  await page.locator('#close-current-inventory-report').click();
  assert.equal(await page.locator('#current-inventory-results').evaluate(dialog => dialog.open), false);
  await page.locator('#inventory-source-list .inventory-source-card').first().getByRole('button', { name: 'Previsualizar' }).click();
  await page.locator('#inventory-preview-range-dialog').waitFor({ state: 'visible' });
  const previewDefaults = await page.evaluate(() => {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const previousMonday = new Date(monday);
    previousMonday.setDate(previousMonday.getDate() - 7);
    const previousSunday = new Date(monday);
    previousSunday.setDate(previousSunday.getDate() - 1);
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { from: iso(previousMonday), to: iso(previousSunday) };
  });
  assert.equal(await page.locator('#inventory-preview-date-from').inputValue(), previewDefaults.from);
  assert.equal(await page.locator('#inventory-preview-date-to').inputValue(), previewDefaults.to);
  await page.locator('#inventory-preview-date-from').fill('2026-08-04');
  await page.locator('#inventory-preview-date-to').fill('2026-08-04');
  await page.locator('#confirm-inventory-preview').click();
  await page.locator('#inventory-preview-dialog').waitFor({ state: 'visible' });
  await page.locator('#inventory-preview-content').getByText(/Período mostrado.*04.*ago.*2026/i).waitFor();
  assert.equal((await page.locator('#inventory-preview-content').textContent()).includes('2026-08-06'), false);
  const frozenPreviewLayout = await page.locator('#inventory-preview-content .preview-table').evaluate(table => {
    const rows = [...table.rows];
    const firstHeader = rows[0].cells[0];
    const secondHeader = rows[1].cells[0];
    const dataCells = [...rows[2].cells];
    return {
      headerTags: [firstHeader.tagName, secondHeader.tagName],
      firstHeader: { position: getComputedStyle(firstHeader).position, top: getComputedStyle(firstHeader).top },
      secondHeader: { position: getComputedStyle(secondHeader).position, top: getComputedStyle(secondHeader).top },
      firstColumns: dataCells.slice(0, 3).map(cell => ({
        position: getComputedStyle(cell).position,
        left: getComputedStyle(cell).left
      })),
      fourthPosition: getComputedStyle(dataCells[3]).position
    };
  });
  assert.deepEqual(frozenPreviewLayout.headerTags, ['TH', 'TH']);
  assert.deepEqual(frozenPreviewLayout.firstHeader, { position: 'sticky', top: '0px' });
  assert.deepEqual(frozenPreviewLayout.secondHeader, { position: 'sticky', top: '34px' });
  assert.deepEqual(frozenPreviewLayout.firstColumns, [
    { position: 'sticky', left: '0px' },
    { position: 'sticky', left: '120px' },
    { position: 'sticky', left: '400px' }
  ]);
  assert.equal(frozenPreviewLayout.fourthPosition, 'static');
  await page.locator('#close-inventory-preview').click();
  await page.getByRole('button', { name: 'Ver resumen merma' }).click();
  await page.locator('#source-summary-dialog').waitFor({ state: 'visible' });
  await page.locator('#source-summary-date-from').fill('2026-08-04');
  await page.locator('#source-summary-date-to').fill('2026-08-05');
  await page.locator('#confirm-source-summary').click();
  await page.locator('#waste-summary-results').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#waste-summary-results').evaluate(dialog => dialog.tagName === 'DIALOG' && dialog.open), true);
  assert.equal(await page.locator('#consumption-summary-results').evaluate(dialog => dialog.tagName), 'DIALOG');
  assert.equal(await page.locator('#inventory-report-results').evaluate(dialog => dialog.tagName), 'DIALOG');
  assert.equal(await page.locator('#waste-summary-table tbody tr').count(), 1);
  assert.equal(await page.locator('#waste-summary-table th', { hasText: 'BUY - Compras' }).count(), 0);
  assert.equal(await page.locator('#waste-summary-table th', { hasText: 'MOV-IN' }).count(), 1);
  assert.equal(await page.locator('#waste-summary-table th', { hasText: 'Costo unitario' }).count(), 1);
  assert.equal(await page.locator('#waste-summary-table th', { hasText: 'Costo total' }).count(), 1);
  assert.match(await page.locator('#waste-summary-table tfoot').textContent(), /TOTAL.*5.*\$2\.500/s);
  assert.equal(await page.locator('#waste-summary-results').getByRole('button', { name: 'Imprimir / PDF' }).count(), 1);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#waste-summary-results').getByRole('button', { name: 'Exportar Excel' }).click();
  const excelDownload = await downloadPromise;
  assert.match(excelDownload.suggestedFilename(), /^adiciones-por-item-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const exportedWorkbook = XLSX.readFile(await excelDownload.path());
  assert.deepEqual(exportedWorkbook.SheetNames, ['Información', 'Merma']);
  assert.equal(exportedWorkbook.Sheets.Merma.A1.v, 'Código');
  await page.locator('#close-waste-summary').click();
  assert.equal(await page.locator('#waste-summary-results').evaluate(dialog => dialog.open), false);
  await page.locator('#process-inventory-report').click();
  await page.locator('#inventory-process-dialog').waitFor({ state: 'visible' });
  const defaults = await page.evaluate(() => {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const previousMonday = new Date(monday);
    previousMonday.setDate(previousMonday.getDate() - 7);
    const previousSunday = new Date(monday);
    previousSunday.setDate(previousSunday.getDate() - 1);
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { previousMonday: iso(previousMonday), previousSunday: iso(previousSunday), currentMonday: iso(monday) };
  });
  assert.equal(await page.locator('#inventory-initial-date').inputValue(), defaults.previousMonday);
  assert.equal(await page.locator('#inventory-final-date').inputValue(), defaults.currentMonday);
  assert.equal(await page.locator('#inventory-movement-from').inputValue(), defaults.previousMonday);
  assert.equal(await page.locator('#inventory-movement-to').inputValue(), defaults.previousSunday);
  assert.equal(await page.locator('#inventory-initial-basis').inputValue(), 'initial');
  assert.equal(await page.locator('#inventory-final-basis').inputValue(), 'initial');
  await page.locator('#inventory-initial-date').fill('2026-08-04');
  await page.locator('#inventory-final-date').fill('2026-08-06');
  await page.locator('#inventory-movement-from').fill('2026-08-04');
  await page.locator('#inventory-movement-to').fill('2026-08-05');
  await page.locator('#confirm-inventory-process').click();
  await page.locator('#inventory-source-status').filter({ hasText: /procesado correctamente/i }).waitFor();
  assert.equal(await page.locator('#inventory-results-table tbody tr').count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: /^Inventario Final Teórico$/ }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Diferencia de Inventario' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Costo unitario' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Consumo Colaboradores' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Consumo Marketing' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Diferencia ajustada por consumos' }).count(), 0);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Costo Total' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Valor Inventario Final Teórico' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Valor Inventario Físico' }).count(), 1);
  const kardexHeaders = await page.locator('#inventory-results-table th').allTextContents();
  const employeeColumn = kardexHeaders.indexOf('Consumo Colaboradores');
  const marketingColumn = kardexHeaders.indexOf('Consumo Marketing');
  const theoreticalColumn = kardexHeaders.indexOf('Inventario Final Teórico');
  const differenceColumn = kardexHeaders.indexOf('Diferencia de Inventario');
  const totalCostColumn = kardexHeaders.indexOf('Costo Total');
  const theoreticalValueColumn = kardexHeaders.indexOf('Valor Inventario Final Teórico');
  const physicalValueColumn = kardexHeaders.indexOf('Valor Inventario Físico');
  assert.ok(employeeColumn < marketingColumn && marketingColumn < theoreticalColumn && theoreticalColumn < differenceColumn);
  assert.deepEqual(
    [totalCostColumn, theoreticalValueColumn, physicalValueColumn],
    [kardexHeaders.length - 3, kardexHeaders.length - 2, kardexHeaders.length - 1]
  );
  assert.match(await page.locator('#inventory-results-table th').nth(employeeColumn).innerText(), /Consumo\s*\n\s*Colaboradores/);
  assert.equal(await page.locator('#inventory-kardex-decimals option').count(), 4);
  assert.equal(await page.locator('#inventory-kardex-decimals').inputValue(), '2');
  const differenceCell = page.locator('#inventory-results-table tbody tr').first().locator('td').nth(differenceColumn);
  assert.match(await differenceCell.textContent(), /-1,00/);
  assert.equal(await differenceCell.getAttribute('class'), 'difference-negative');
  await page.locator('#inventory-kardex-decimals').selectOption('1');
  assert.match(await differenceCell.textContent(), /-1,0/);
  await page.locator('#inventory-kardex-decimals').selectOption('3');
  assert.match(await differenceCell.textContent(), /-1,000/);
  assert.doesNotMatch(await page.locator('#inventory-results-table tbody tr').first().locator('td').nth(3).textContent(), /,/);
  await page.locator('#inventory-kardex-decimals').selectOption('4');
  const horizontalScroll = await page.locator('#inventory-results-table').evaluate(table => {
    const wrap = table.parentElement;
    const cells = [...table.querySelectorAll('tbody tr:first-child td')];
    const before = cells.slice(0, 5).map(cell => cell.getBoundingClientRect().left);
    wrap.scrollLeft = 600;
    const after = cells.slice(0, 5).map(cell => cell.getBoundingClientRect().left);
    return { before, after, scrollLeft: wrap.scrollLeft };
  });
  assert.ok(horizontalScroll.scrollLeft > 0);
  horizontalScroll.before.slice(0, 4).forEach((left, index) => {
    assert.ok(Math.abs(left - horizontalScroll.after[index]) < 2);
  });
  assert.ok(horizontalScroll.after[4] < horizontalScroll.before[4] - 100);
  assert.equal(
    await page.locator('#inventory-results-table .inventory-sort-button').count(),
    await page.locator('#inventory-results-table th').count()
  );
  const totalCostHeader = page.locator('#inventory-results-table th', { hasText: 'Costo Total' });
  await totalCostHeader.locator('button').click();
  assert.equal(await totalCostHeader.getAttribute('aria-sort'), 'ascending');
  await totalCostHeader.locator('button').click();
  assert.equal(await totalCostHeader.getAttribute('aria-sort'), 'descending');
  await page.locator('#inventory-kardex-search').fill('producto uno');
  assert.equal(await page.locator('#inventory-results-table tbody tr').count(), 1);
  assert.equal(await page.locator('#inventory-kardex-visible-count').textContent(), '1 de 1 filas');
  await page.locator('#inventory-kardex-cost-filter').selectOption('positive');
  assert.match(await page.locator('#inventory-results-table tbody').textContent(), /No hay filas/);
  assert.equal(await page.locator('#inventory-kardex-visible-count').textContent(), '0 de 1 filas');
  await page.locator('#clear-inventory-kardex-filters').click();
  assert.equal(await page.locator('#inventory-results-table tbody tr').count(), 1);
  assert.match(await page.locator('#inventory-results-table tbody tr').first().textContent(), /10,0000/);
  await page.evaluate(() => {
    const item = inventoryKardexTableState.report.items[0];
    item.costAvailable = true;
    item.unitCost = 500;
    renderInventoryKardexTable();
  });
  const inventoryResultCells = page.locator('#inventory-results-table tbody tr').first().locator('td');
  assert.match(await inventoryResultCells.nth(theoreticalValueColumn).textContent(), /\$5\.000/);
  assert.match(await inventoryResultCells.nth(physicalValueColumn).textContent(), /\$4\.500/);
  assert.match(await page.locator('#inventory-results-table tfoot').textContent(), /TOTAL.*\$-500.*\$5\.000.*\$4\.500/s);
  assert.equal(await page.locator('#inventory-report-results').getByRole('button', { name: 'Imprimir / PDF' }).count(), 1);
  assert.equal(await page.locator('#inventory-report-results').getByRole('button', { name: 'Exportar Excel' }).count(), 1);
  await page.emulateMedia({ media: 'print' });
  const printLayout = await page.locator('#inventory-report-results').evaluate(section => {
    section.close();
    document.body.classList.add('printing-inventory-report');
    section.classList.add('inventory-print-target');
    const card = section.querySelector('.consumption-report-card');
    const wrap = section.querySelector('.consumption-table-wrap, .inventory-results-table-wrap');
    const styles = getComputedStyle(section);
    return {
      position: styles.position,
      maxHeight: styles.maxHeight,
      overflow: styles.overflow,
      cardBreakInside: getComputedStyle(card || section).breakInside,
      tableWrapMaxHeight: getComputedStyle(wrap).maxHeight
    };
  });
  assert.equal(printLayout.position, 'static');
  assert.equal(printLayout.maxHeight, 'none');
  assert.equal(printLayout.overflow, 'visible');
  assert.equal(printLayout.cardBreakInside, 'auto');
  assert.equal(printLayout.tableWrapMaxHeight, 'none');
  await page.locator('#inventory-report-results').evaluate(section => {
    section.classList.remove('inventory-print-target');
    document.body.classList.remove('printing-inventory-report');
    section.showModal();
  });
  await page.emulateMedia({ media: 'screen' });
  const consolidatedDownloadPromise = page.waitForEvent('download');
  await page.locator('#inventory-report-results').getByRole('button', { name: 'Exportar Excel' }).click();
  const consolidatedDownload = await consolidatedDownloadPromise;
  const consolidatedWorkbook = XLSX.readFile(await consolidatedDownload.path());
  assert.equal(consolidatedWorkbook.SheetNames[0], 'Información');
  assert.equal(consolidatedWorkbook.SheetNames.includes('Merma'), true);
  assert.equal(consolidatedWorkbook.SheetNames.includes('Kardex consolidado'), true);
  assert.equal(await page.locator('#inventory-waste-report').isVisible(), true);
  assert.equal(await page.locator('#inventory-waste-table tbody tr').count(), 1);
  assert.match(await page.locator('#inventory-report-period').textContent(), /Saldo inicial.*04.*ago.*2026.*movimientos.*04.*ago.*2026.*05.*ago.*2026.*saldo final.*06.*ago.*2026/i);
  assert.equal(await page.locator('#inventory-report-results').evaluate(dialog => dialog.open), true);
  await page.locator('#close-inventory-report').click();
  assert.equal(await page.locator('#inventory-report-results').evaluate(dialog => dialog.open), false);

  await page.getByRole('link', { name: 'Cargar Archivos' }).click();

  const salesRow = page.locator('[data-weekly-field="sales"]');
  await salesRow.getByRole('button', { name: 'Previsualizar' }).click();
  await page.locator('#master-preview-title').filter({ hasText: 'ventas-semana.csv' }).waitFor();
  await page.getByRole('button', { name: 'Cerrar' }).click();
  await salesRow.getByRole('button', { name: 'Eliminar' }).click();
  await page.getByRole('heading', { name: 'Eliminar Ventas' }).waitFor();
  await page.getByRole('button', { name: 'Cancelar' }).click();
  assert.match(await salesRow.locator('.file-upload-state').textContent(), /Último archivo subido/);
  await salesRow.getByRole('button', { name: 'Eliminar' }).click();
  await page.locator('#transaction-delete-confirmation').fill('ELIMINAR');
  await page.getByRole('button', { name: 'Confirmar eliminación' }).click();
  await page.getByText(/Se revirtió la última carga de Ventas/).waitFor();
  assert.equal(await salesRow.locator('.file-upload-state').textContent(), 'Sin archivos subidos');
  await page.locator('#file-sales').setInputFiles({
    name: 'compras-en-ventas.xls',
    mimeType: 'application/vnd.ms-excel',
    buffer: Buffer.from('Fecha emisión\tDocumento\tProveedor/Para\tPRODUCTO\tCod\tQ.Rec\tUm.Rec\tCosto\n2026-08-04\t100\tProveedor\tInsumo\tI1\t1\tUN\t100')
  });
  await page.locator('#week-status').filter({ hasText: /seleccionado como Transacciones de venta.*parece corresponder a Compras/i }).waitFor();
  await page.locator('#file-sales').setInputFiles([]);

  await page.locator('#file-waste').setInputFiles({
    name: 'kardex_report MER.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(waste)
  });
  await page.locator('#date-confirmation').waitFor({ state: 'visible' });
  assert.match(await page.locator('#week-status').textContent(), /Kardex y Merma comparten la misma estructura.*archivo correcto.*Merma/i);
  assert.equal(await page.locator('#date-confirmation-row').isVisible(), true);
  assert.equal(await page.locator('#inventory-file-confirmation-row').isVisible(), true);
  assert.match(await page.locator('#inventory-file-confirmation-copy').textContent(), /kardex_report MER\.xlsx.*archivo correcto.*Merma/i);
  await page.getByRole('button', { name: 'Cancelar' }).click();

  await page.getByRole('tab', { name: 'Archivos maestros' }).click();
  assert.equal(await page.getByText('Maestro Productos / Ingredientes / Extras', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Jerarquía Productos', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Jerarquía Ingredientes', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Jerarquía Extras', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Maestro Proveedores', { exact: true }).count(), 1);

  await page.locator('#master-suppliers').setInputFiles({
    name: 'recetas-en-proveedores.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Id Producto\tId Ingrediente\tCantidad Ingrediente\tUnidad Medida\nP1\tI1\t1\tUN')
  });
  await page.locator('#master-suppliers-from').fill('2026-08-09');
  await page.getByRole('button', { name: 'Guardar archivos maestros' }).click();
  await page.locator('#master-status').filter({ hasText: /seleccionado como Maestro Proveedores.*parece corresponder a Maestro de recetas/i }).waitFor();
  await page.locator('#master-suppliers').setInputFiles([]);
  await page.locator('#master-suppliers-from').fill('');

  const uiCatalogWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(uiCatalogWorkbook, XLSX.utils.aoa_to_sheet([
    ['pl', 'np', 'ce'],
    ['ID Producto **', 'Nombre Producto *', 'Costo'],
    ['P1', 'Producto prueba', 100]
  ]), 'Prod');
  const catalogFile = {
    name: 'catalogo.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(uiCatalogWorkbook, { type: 'buffer', bookType: 'xlsx' })
  };
  await page.locator('#master-catalog').setInputFiles(catalogFile);
  await page.locator('#master-catalog-from').fill('2026-08-09');
  await page.getByRole('button', { name: 'Guardar archivos maestros' }).click();
  await page.getByText('Archivos maestros guardados correctamente.').waitFor();
  assert.equal(await page.locator('[data-master-field="master-catalog"]').textContent(), 'Última vigencia: 2026-08-09');

  await page.locator('#master-catalog').setInputFiles({ ...catalogFile, name: 'catalogo-nuevo.xlsx' });
  await page.locator('#master-catalog-from').fill('2026-08-09');
  await page.getByRole('button', { name: 'Guardar archivos maestros' }).click();
  await page.locator('#master-conflict').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: 'Reemplazar' }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Cancelar' }).isVisible(), true);
  await page.getByRole('button', { name: 'Cancelar' }).click();
  assert.equal(await page.locator('#master-conflict').isHidden(), true);

  const catalogMasterRecord = page.locator('.master-record', { hasText: 'catalogo.xlsx' });
  await catalogMasterRecord.getByRole('button', { name: 'Vista previa' }).click();
  await page.locator('#master-preview-dialog').waitFor({ state: 'visible' });
  await page.locator('#master-preview-title').filter({ hasText: 'catalogo.xlsx' }).waitFor();
  assert.equal(await page.locator('#master-preview-title').textContent(), 'catalogo.xlsx');
  await page.getByRole('button', { name: 'Cerrar' }).click();

  await catalogMasterRecord.getByRole('button', { name: 'Eliminar' }).click();
  await page.getByText(/¿Eliminar permanentemente/).waitFor();
  await page.locator('.delete-confirmation').getByRole('button', { name: 'Cancelar' }).click();
  assert.equal(await page.locator('.delete-confirmation').count(), 0);
  await catalogMasterRecord.getByRole('button', { name: 'Eliminar' }).click();
  await page.getByRole('button', { name: 'Sí, eliminar' }).click();
  await page.getByText('Archivo maestro eliminado.').waitFor();
  assert.equal(await page.locator('.master-record', { hasText: 'catalogo.xlsx' }).count(), 0);
  assert.equal(await page.locator('[data-master-field="master-catalog"]').textContent(), 'Última vigencia: —');

  await page.getByRole('link', { name: 'Configuracion' }).click();
  await page.getByRole('heading', { name: 'Ubicaciones', exact: true }).waitFor({ state: 'visible' });
  await page.getByLabel('Nombre de la ubicación').fill('Brewit Test');
  await page.getByRole('button', { name: 'Crear ubicación' }).click();
  await page.getByText('Ubicación creada.').waitFor();
  assert.equal(await page.locator('#location-select option', { hasText: 'Brewit Test' }).count(), 1);

  const nameInput = page.getByRole('textbox', { name: 'Nombre de Brewit Test' });
  await nameInput.fill('Brewit Renombrado');
  await nameInput.locator('xpath=..').getByRole('button', { name: 'Guardar nombre' }).click();
  await page.getByText('Nombre y dirección actualizados.').waitFor();
  const renamedInput = page.getByRole('textbox', { name: 'Nombre de Brewit Renombrado' });
  await renamedInput.locator('xpath=..').getByRole('button', { name: 'Enviar a papelera' }).click();

  await page.getByText('Advertencia 1 de 2').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#location-trash-step-two').isHidden(), true);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByText('Advertencia 2 de 2').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: 'Enviar a la papelera' }).isDisabled(), true);
  await page.getByLabel('Nombre exacto de la ubicación').fill('Brewit Renombrado');
  await page.getByRole('button', { name: 'Enviar a la papelera' }).click();
  await page.getByText('Brewit Renombrado fue enviada a la papelera.').waitFor();
  assert.equal(await page.locator('#location-select option', { hasText: 'Brewit Renombrado' }).count(), 0);

  const trashRow = page.locator('#trashed-locations-list .location-row', { hasText: 'Brewit Renombrado' });
  await trashRow.getByRole('button', { name: 'Restaurar' }).click();
  await page.getByText('Brewit Renombrado fue restaurada.').waitFor();
  assert.equal(await page.locator('#location-select option', { hasText: 'Brewit Renombrado' }).count(), 1);
  assert.deepEqual(pageErrors, []);
});
