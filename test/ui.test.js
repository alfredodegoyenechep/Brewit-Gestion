const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  upload.append('sales', new Blob(['ID de orden\tFecha de creacion\tPago total\tDescuentos\norder-1\t2026-08-09\t119\t0']), 'ventas-semana.csv');
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
    ['P1', 'Producto Uno', 'UN', 10, 5, 3, 12, 12, 2, 4, 10, 9, 0, 0, 9]
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

  await page.getByRole('link', { name: 'Cargar Archivos' }).click();
  await page.getByRole('heading', { name: 'Cargar archivos' }).waitFor({ state: 'visible' });
  await page.locator('[data-weekly-field="sales"] .file-upload-state.uploaded').waitFor();

  assert.equal(await page.locator('#file-loader').isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /New Order/i }).count(), 0);
  assert.equal(await page.locator('#week-select').count(), 0);
  assert.equal(await page.locator('[data-weekly-field="sales"] .file-upload-state').textContent(), 'Archivo ya subido');
  assert.match(await page.locator('[data-weekly-field="sales"] .file-upload-filename').textContent(), /ventas-semana\.csv.*1 carga/i);
  assert.match(await page.locator('#latest-sales-transaction').textContent(), /09-08-2026.*12:00:00/i);
  assert.equal(await page.locator('[data-weekly-field="kardex"] .file-upload-state').textContent(), 'Subir Archivo');
  assert.equal(await page.locator('#previous-weeks').count(), 0);
  await page.locator('#file-sales').setInputFiles({
    name: 'ventas-coincidentes.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('ID de orden\tFecha de creacion\tPago total\tDescuentos\norder-1\t2026-08-09\t119\t0')
  });
  await page.getByRole('button', { name: 'Detectar fechas y revisar' }).click();
  await page.locator('#transaction-overlap-notice').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#replace-transactions-btn').isVisible(), true);
  assert.match(await page.locator('#transaction-overlap-notice').textContent(), /2026-08-09.*2026-08-09/);
  await page.locator('#file-sales').setInputFiles([]);

  await page.getByRole('link', { name: 'Reporte Semanal' }).click();
  await page.getByRole('heading', { name: 'Resumen de ventas' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#report-location-filter').inputValue(), 'all');
  assert.equal(await page.locator('#report-location-filter option').count(), 3);
  await page.locator('#report-yesterday-value').filter({ hasText: '100' }).waitFor();
  assert.match(await page.locator('#report-general-rank').textContent(), /#1 de 1/);
  assert.match(await page.locator('#report-week-range').textContent(), /03.*ago.*2026.*09.*ago.*2026/i);
  assert.equal(await page.locator('#intraday-sales-body tr').count(), 7);
  assert.match(await page.locator('#intraday-sales-body tr').first().locator('td').first().textContent(), /07:00.*09:00/);
  assert.match(await page.locator('#intraday-sales-body tr').last().locator('td').first().textContent(), /19:00.*cierre/);
  await page.locator('#report-location-filter').selectOption('store-2');
  await page.locator('#report-scope-description').filter({ hasText: 'Tienda 2' }).waitFor();
  assert.match(await page.locator('#report-yesterday-value').textContent(), /0/);
  await page.locator('#report-location-filter').selectOption('all');
  await page.locator('#report-scope-description').filter({ hasText: 'todas las cafeterías' }).waitFor();

  await page.getByRole('link', { name: 'Compras' }).click();
  await page.getByRole('heading', { name: 'Historial de compras e insumos' }).waitFor();
  assert.equal(await page.locator('#purchases-location-filter option').count(), 3);
  assert.equal(await page.locator('.content-layout').isVisible(), false);

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
  assert.equal(await page.locator('#waste-summary-table tbody tr').count(), 1);
  assert.equal(await page.locator('#waste-summary-table th', { hasText: 'BUY - Compras' }).count(), 0);
  assert.equal(await page.locator('#waste-summary-table th', { hasText: 'MOV-IN' }).count(), 1);
  assert.equal(await page.locator('#waste-summary-table th', { hasText: 'Costo unitario' }).count(), 1);
  assert.equal(await page.locator('#waste-summary-table th', { hasText: 'Costo total' }).count(), 1);
  assert.match(await page.locator('#waste-summary-table tfoot').textContent(), /TOTAL.*5.*Sin costo|TOTAL.*5.*\$0/s);
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
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Diferencia ajustada por consumos' }).count(), 1);
  assert.equal(await page.locator('#inventory-results-table th', { hasText: 'Costo Total' }).count(), 1);
  const kardexHeaders = await page.locator('#inventory-results-table th').allTextContents();
  const adjustedColumn = kardexHeaders.indexOf('Diferencia ajustada por consumos');
  const adjustedCell = page.locator('#inventory-results-table tbody tr').first().locator('td').nth(adjustedColumn);
  assert.match(await adjustedCell.textContent(), /-1,0000/);
  assert.equal(await adjustedCell.getAttribute('class'), 'difference-negative');
  assert.match(await page.locator('#inventory-results-table tbody tr').first().textContent(), /10,0000/);
  assert.match(await page.locator('#inventory-results-table tfoot').textContent(), /TOTAL.*\$0/s);
  assert.equal(await page.locator('#inventory-waste-report').isVisible(), true);
  assert.equal(await page.locator('#inventory-waste-table tbody tr').count(), 1);
  assert.match(await page.locator('#inventory-report-period').textContent(), /Saldo inicial.*04.*ago.*2026.*movimientos.*04.*ago.*2026.*05.*ago.*2026.*saldo final.*06.*ago.*2026/i);

  await page.getByRole('link', { name: 'Cargar Archivos' }).click();

  const salesRow = page.locator('[data-weekly-field="sales"]');
  await salesRow.getByRole('button', { name: 'Previsualizar' }).click();
  await page.locator('#master-preview-title').filter({ hasText: 'ventas-semana.csv' }).waitFor();
  await page.getByRole('button', { name: 'Cerrar' }).click();
  await salesRow.getByRole('button', { name: 'Eliminar' }).click();
  await salesRow.getByText(/¿Eliminar la carga más reciente “ventas-semana.csv”/).waitFor();
  await salesRow.getByRole('button', { name: 'Cancelar' }).click();
  assert.equal(await salesRow.locator('.file-upload-state').textContent(), 'Archivo ya subido');
  await salesRow.getByRole('button', { name: 'Eliminar' }).click();
  await salesRow.getByRole('button', { name: 'Sí, eliminar' }).click();
  await page.getByText('Carga transaccional eliminada.').waitFor();
  assert.equal(await salesRow.locator('.file-upload-state').textContent(), 'Subir Archivo');

  await page.getByRole('tab', { name: 'Archivos maestros' }).click();
  assert.equal(await page.getByText('Maestro Productos / Ingredientes / Extras', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Jerarquía Productos', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Jerarquía Ingredientes', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Jerarquía Extras', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Maestro Proveedores', { exact: true }).count(), 1);

  const catalogFile = { name: 'catalogo.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('catalog') };
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
