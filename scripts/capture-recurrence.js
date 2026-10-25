const path = require('node:path'), fs = require('node:fs');
const { chromium } = require('playwright-core');
(async () => {
  const directory = path.resolve(process.argv[2] || '/private/tmp/brewit-recurrence-captures'); fs.mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.BREWIT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }), errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/sales/recurrence')) calls.push(new URL(req.url()).pathname); });
    await page.goto(process.env.BREWIT_LOCAL_URL || 'http://127.0.0.1:3000');
    await page.waitForFunction(() => document.getElementById('financial-general-expenses-grid').childElementCount > 0);
    await page.getByRole('link', { name: 'Estadísticas por producto y horario', exact: true }).click();
    await page.getByRole('tab', { name: 'Clientes recurrentes', exact: true }).click();
    for (const tab of ['Retorno', 'Compras', 'Calidad de datos', 'Resumen']) await page.getByRole('tab', { name: tab, exact: true }).click();
    const initialQueries = calls.length;
    await page.locator('#sales-customers-location').selectOption('store-2'); await page.locator('#sales-customers-period').selectOption('custom');
    await page.locator('#sales-customers-from').fill('2026-10-01'); await page.locator('#sales-customers-to').fill('2026-10-25');
    await page.locator('#sales-customers-filters [type=submit]').click(); await page.locator('#sales-customers-status').filter({ hasText: 'Reporte generado.' }).waitFor();
    for (const [name, slug, prepare] of [['Resumen', 'resumen'], ['Retorno', 'retorno'], ['Compras', 'compras', 'recurrence-purchases'], ['Calidad de datos', 'calidad', 'recurrence-quality']]) {
      await page.getByRole('tab', { name, exact: true }).click();
      if (prepare) { await page.locator(`#${prepare}-run`).click(); await page.locator(`#${prepare}-status`).filter({ hasText: 'Sección preparada' }).waitFor({ timeout: 120000 }); }
      await page.screenshot({ path: path.join(directory, `recurrencia-${slug}-escritorio.png`), fullPage: true });
    }
    const preparedQueries = calls.length;
    await page.setViewportSize({ width: 390, height: 1000 });
    for (const [name, slug] of [['Resumen', 'resumen'], ['Retorno', 'retorno']]) { await page.getByRole('tab', { name, exact: true }).click(); await page.screenshot({ path: path.join(directory, `recurrencia-${slug}-movil.png`), fullPage: true }); }
    const evidence = { initialQueries, preparedQueries, queriesAfterNavigation: calls.length, pageErrors: errors, horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), captures: fs.readdirSync(directory).filter(n => n.endsWith('.png')) };
    fs.writeFileSync(path.join(directory, 'verificacion-interfaz.json'), JSON.stringify(evidence, null, 2)+'\n'); console.log(JSON.stringify(evidence));
    if (errors.length || initialQueries || evidence.horizontalOverflow) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
