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
  const server = createApp({ uploadsRoot, reportToday: '2026-08-10' }).listen(0, '127.0.0.1');
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
  upload.append('sales', new Blob(['ID de orden\tFecha de creacion\tPago total\tDescuentos\tID Producto\tNombre\tCantidad\tPrecio a Pagar\tDescuento\tCosto\tCategorías de Productos/Platos\norder-1\t2026-08-09\t119\t0\tP1\tProducto Uno\t1\t119\t0\t20\tBebidas']), 'ventas-semana.csv');
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

  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: 'Resumen de ventas' }).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('link', { name: 'General', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Resumen General Ventas' }).evaluate(link => {
    if (!link.classList.contains('active')) throw new Error('Resumen General Ventas no quedó como vista inicial activa.');
  });

  await page.getByRole('link', { name: 'Cargar Archivos' }).click();
  await page.getByRole('heading', { name: 'Cargar archivos' }).waitFor({ state: 'visible' });
  await page.locator('[data-weekly-field="sales"] .file-upload-state.uploaded').waitFor();

  assert.equal(await page.locator('#file-loader').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /New Order/i }).count(), 0);
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
  await page.getByRole('button', { name: 'Cancelar' }).click();
  assert.equal(await page.locator('#date-confirmation').evaluate(dialog => dialog.open), false);
  assert.equal(await page.locator('#file-sales').evaluate(input => input.files.length), 0);

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

  await page.getByRole('link', { name: 'Ventas', exact: true }).click();
  await page.getByRole('heading', { name: 'Panel de indicadores comerciales' }).waitFor();
  await page.locator('#sales-dashboard-status').filter({ hasText: /archivo\(s\) de ventas/i }).waitFor();
  assert.equal(await page.locator('.sales-kpi-card').count(), 4);
  assert.match(await page.locator('.sales-kpi-card').nth(1).textContent(), /día anterior.*100/is);
  assert.equal(await page.locator('#sales-location-body tr').count(), 2);
  assert.equal(await page.locator('#mercadopago-period-body tr').count(), 3);
  assert.equal(await page.locator('#mercadopago-month-history tr').count(), 6);
  assert.equal(await page.locator('#mercadopago-week-history tr').count(), 8);
  await page.locator('#sales-insight-period').selectOption('month');
  assert.match(await page.locator('#sales-top-products').textContent(), /Producto Uno/);
  await page.getByRole('button', { name: 'Ver detalle de Bebidas' }).click();
  assert.equal(await page.locator('#sales-hierarchy-title').textContent(), 'Productos vendidos');
  assert.match(await page.locator('#sales-hierarchy-share').textContent(), /Producto Uno.*P1.*1 un\..*Margen 80,?\.?(0)?%.*\$100/s);
  assert.equal(await page.locator('#sales-hierarchy-share').getAttribute('class'), 'sales-share-list hierarchy-product-list');
  assert.equal(await page.locator('#sales-hierarchy-back').isVisible(), true);
  await page.locator('#sales-hierarchy-back').click();
  assert.equal(await page.locator('#sales-hierarchy-title').textContent(), 'Venta por jerarquía');
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
  const purchasesWorkbook = XLSX.readFile(await purchasesDownload.path());
  assert.deepEqual(purchasesWorkbook.SheetNames, ['Información', 'Compras']);
  assert.equal(purchasesWorkbook.Sheets.Compras.A1.v, 'Fecha');
  assert.equal(purchasesWorkbook.Sheets.Compras.J2.v, 2);
  assert.equal(await page.locator('.content-layout').isVisible(), false);

  await page.getByRole('link', { name: 'Proyección de Compras' }).click();
  await page.getByRole('heading', { name: 'Proyección de compras' }).waitFor();
  await page.locator('#projection-location-filter').selectOption('store-2');
  await page.locator('#purchase-projection-status').filter({ hasText: /Consumo considerado/i }).waitFor();
  assert.equal(await page.locator('#purchase-projection-body tr[data-key]').count(), 1);
  const projectionRow = page.locator('#purchase-projection-body tr[data-key]').first();
  assert.equal(await page.locator('.purchase-projection-table th').nth(6).textContent(), 'Consumo y TRN-OUT 30 días');
  assert.equal(await projectionRow.locator('td').nth(5).textContent(), '0,00');
  assert.equal(await projectionRow.locator('td').nth(6).textContent(), '7,00');
  assert.equal(await projectionRow.locator('td').nth(7).textContent(), '0,23');
  assert.equal(await projectionRow.locator('td').nth(8).textContent(), '0,00 días');
  assert.equal(await projectionRow.locator('td').nth(8).getAttribute('class'), 'projection-coverage-low');
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
  await page.getByRole('button', { name: 'Confirmar y guardar orden' }).click();
  await page.locator('#purchase-order-editor-status').filter({ hasText: /guardada correctamente/i }).waitFor();
  await page.getByRole('button', { name: 'Imprimir / PDF' }).click();
  assert.equal(await page.evaluate(() => window.__purchaseOrderPrintCalled), true);
  await page.getByRole('button', { name: 'Cerrar' }).click();
  await page.locator('.projection-min-input').fill('10');
  await page.locator('.projection-max-input').fill('20');
  await page.getByRole('button', { name: 'Guardar criterios' }).click();
  await page.locator('#purchase-projection-status').filter({ hasText: /Consumo considerado/i }).waitFor();
  assert.equal(await page.locator('.projection-min-input').inputValue(), '10');
  assert.equal(await page.locator('.projection-max-input').inputValue(), '20');
  assert.equal(await page.locator('.projection-managed-input').isChecked(), true);
  await page.locator('#projection-only-managed').check();
  assert.equal(await page.locator('#purchase-projection-body tr[data-key]').count(), 1);

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
  assert.equal(await page.locator('#inventory-date-from').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Ver resumen marketing' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Ver resumen colaboradores' }).count(), 1);
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
  assert.match(await page.locator('#waste-summary-table tfoot').textContent(), /TOTAL.*5.*Sin costo|TOTAL.*5.*\$0/s);
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
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Inventario Final Teórico' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Diferencia de Inventario' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Costo unitario' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Consumo Colaboradores' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Consumo Marketing' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Diferencia ajustada por consumos' }).count(), 0);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Costo Total' }).count(), 1);
  const kardexHeaders = await page.locator('#inventory-results-table th').allTextContents();
  const employeeColumn = kardexHeaders.indexOf('Consumo Colaboradores');
  const marketingColumn = kardexHeaders.indexOf('Consumo Marketing');
  const theoreticalColumn = kardexHeaders.indexOf('Inventario Final Teórico');
  const differenceColumn = kardexHeaders.indexOf('Diferencia de Inventario');
  assert.ok(employeeColumn < marketingColumn && marketingColumn < theoreticalColumn && theoreticalColumn < differenceColumn);
  const differenceCell = page.locator('#inventory-results-table tbody tr').first().locator('td').nth(differenceColumn);
  assert.match(await differenceCell.textContent(), /-1,0000/);
  assert.equal(await differenceCell.getAttribute('class'), 'difference-negative');
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
  assert.match(await page.locator('#inventory-results-table tfoot').textContent(), /TOTAL.*\$0/s);
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

  await page.getByRole('button', { name: 'Vista previa' }).click();
  await page.locator('#master-preview-dialog').waitFor({ state: 'visible' });
  await page.locator('#master-preview-title').filter({ hasText: 'catalogo.xlsx' }).waitFor();
  assert.equal(await page.locator('#master-preview-title').textContent(), 'catalogo.xlsx');
  await page.getByRole('button', { name: 'Cerrar' }).click();

  await page.getByRole('button', { name: 'Eliminar' }).click();
  await page.getByText(/¿Eliminar permanentemente/).waitFor();
  await page.locator('.delete-confirmation').getByRole('button', { name: 'Cancelar' }).click();
  assert.equal(await page.locator('.delete-confirmation').count(), 0);
  await page.getByRole('button', { name: 'Eliminar' }).click();
  await page.getByRole('button', { name: 'Sí, eliminar' }).click();
  await page.getByText('Archivo maestro eliminado.').waitFor();
  assert.equal(await page.locator('.master-record').count(), 0);
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
  await page.getByText('Nombre actualizado.').waitFor();
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
