const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const REPORT_URL = 'https://www.mercadopago.cl/balance/reports/settlement_v2';
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function reportPeriod(text) {
  const dates = [...String(text).toLowerCase().matchAll(/(\d{1,2})\s*\/\s*([a-zá]+|\d{1,2})\s*\/\s*(\d{4})/g)].map(([, day, month, year]) => {
    const number = /^\d+$/.test(month) ? Number(month) : MONTHS.indexOf(month.slice(0, 3)) + 1;
    const date = `${year}-${String(number).padStart(2, '0')}-${day.padStart(2, '0')}`;
    return number && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date ? date : null;
  });
  return dates.length === 2 && dates.every(Boolean) && dates[0] <= dates[1] ? { from: dates[0], to: dates[1] } : null;
}
function webError(code, message) { return Object.assign(new Error(message), { code }); }

function createMercadoPagoBrowser(root, options = {}) {
  const browserEngine = options.chromium || chromium;
  let context, page, headless;
  async function close() {
    if (context) await context.close();
    context = page = undefined;
  }
  async function open(interactive) {
    if (context && headless && interactive) await close();
    // A premature retry must leave the user's unfinished login form intact.
    if (context && interactive && (/auth|login|identification|challenge/i.test(page.url())
      || await page.locator('input[type="password"], input[name="user_id"], input[name="email"]').count())) {
      throw webError('MP_AUTH_REQUIRED', 'Completa el inicio de sesión en la ventana de MercadoPago y pulsa «Ya inicié sesión, continuar».');
    }
    if (!context) {
      const executablePath = options.executablePath || [process.env.BREWIT_CHROME_PATH, chromium.executablePath(),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(file => fs.existsSync(file));
      if (!executablePath) throw webError('MP_BROWSER_UNAVAILABLE', 'Instala Chrome o configura BREWIT_CHROME_PATH en el servidor para descargar reportes de MercadoPago.');
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      headless = !interactive;
      try { context = await browserEngine.launchPersistentContext(root, { executablePath, headless, acceptDownloads: true }); }
      catch { throw webError('MP_BROWSER_UNAVAILABLE', 'No se pudo abrir Chrome en el servidor. Verifica que tenga una pantalla disponible para iniciar sesión en MercadoPago.'); }
      page = context.pages()[0] || await context.newPage();
      context.on('close', () => { context = page = undefined; });
    }
    await page.goto(options.reportUrl || REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const ready = page.locator('table, [role="table"], input[type="password"], input[name="user_id"], input[name="email"]');
    await ready.first().waitFor({ state: 'visible', timeout: options.readyTimeout || 20000 }).catch(() => {});
    if (/auth|login|identification|challenge/i.test(page.url()) || await page.locator('input[type="password"], input[name="user_id"], input[name="email"]').count()) {
      if (!interactive) await close();
      throw webError('MP_AUTH_REQUIRED', 'Inicia sesión en MercadoPago en la ventana del navegador del servidor y pulsa «Ya inicié sesión, continuar».');
    }
    if (!await page.locator('table, [role="table"]').count()) throw webError('MP_REPORTS_UNAVAILABLE', 'No se pudo leer la lista de reportes de MercadoPago. Revisa la ventana del navegador y vuelve a intentar.');
  }
  async function download({ from, to, directory, interactive }) {
    const reports = [];
    try {
      await open(interactive);
      const visited = new Set();
      for (let pagination = 0; pagination < 100; pagination++) {
        const table = page.locator('table, [role="table"]').first();
        const signature = await table.innerText();
        if (visited.has(signature)) throw webError('MP_PAGINATION_FAILED', 'MercadoPago no avanzó a la siguiente página de reportes. Reintenta la actualización.');
        visited.add(signature);
        const headers = await table.locator('thead th, [role="columnheader"]').allTextContents();
        const periodColumn = headers.findIndex(value => /per[ií]odo de fechas/i.test(value));
        if (periodColumn < 0) throw webError('MP_REPORT_FORMAT_CHANGED', 'No se encontró la columna Período de fechas en MercadoPago. Revisa el formato del sitio.');
        const rows = table.locator('tbody tr, [role="rowgroup"] [role="row"]');
        for (let i = 0; i < await rows.count(); i++) {
          const row = rows.nth(i), cells = row.locator('td, [role="cell"]');
          if (await cells.count() <= periodColumn) continue;
          const period = reportPeriod(await cells.nth(periodColumn).innerText());
          if (!period) throw webError('MP_INVALID_PERIOD', 'No se pudo interpretar el período de un reporte. Revisa la lista en MercadoPago.');
          if (period.to < from || period.from > to) continue;
          const link = row.getByRole('link', { name: /\.csv|descargar.*csv/i }).or(row.getByRole('button', { name: /\.csv|descargar.*csv/i })).first();
          if (!await link.count() || !await link.isEnabled()) continue;
          const pending = page.waitForEvent('download', { timeout: 60000 });
          // Install the event handler before clicking, including very fast downloads.
          const [file] = await Promise.all([pending, link.click()]);
          if (!/\.csv$/i.test(file.suggestedFilename())) throw webError('MP_INVALID_DOWNLOAD', 'MercadoPago no entregó un archivo CSV. Revisa el reporte y reintenta.');
          const filename = path.join(directory, `report-${reports.length}.csv`);
          await file.saveAs(filename);
          if (fs.statSync(filename).size > 50 * 1024 * 1024) throw webError('MP_FILE_TOO_LARGE', 'El reporte supera el límite de 50 MB. Divide el período en MercadoPago.');
          reports.push({ path: filename, period });
        }
        const next = page.getByRole('button', { name: /siguiente|pr[oó]xima|next/i }).or(page.getByRole('link', { name: /siguiente|pr[oó]xima|next/i })).first();
        if (!await next.count() || !await next.isEnabled() || await next.getAttribute('aria-disabled') === 'true') break;
        if (pagination === 99) throw webError('MP_TOO_MANY_PAGES', 'Hay demasiadas páginas de reportes. Filtra el período en MercadoPago y reintenta.');
        await next.click();
        await page.waitForFunction(previous => document.querySelector('table, [role="table"]')?.innerText !== previous, signature, { timeout: 15000 });
      }
      await close();
      return reports;
    } catch (error) {
      if (page && !page.isClosed() && (/auth|login|identification|challenge/i.test(page.url())
        || await page.locator('input[type="password"], input[name="user_id"], input[name="email"]').count().catch(() => 0))) {
        if (!interactive) await close().catch(() => {});
        throw webError('MP_AUTH_REQUIRED', 'Inicia sesión en MercadoPago en la ventana del navegador del servidor y pulsa «Ya inicié sesión, continuar».');
      }
      if (error.code !== 'MP_AUTH_REQUIRED') await close().catch(() => {});
      if (error.code?.startsWith('MP_')) throw error;
      throw webError('MP_DOWNLOAD_FAILED', 'No se pudo completar la descarga de MercadoPago. Reintenta la actualización; si la sesión venció, vuelve a iniciar sesión.');
    }
  }
  return { download, close };
}
module.exports = { REPORT_URL, reportPeriod, createMercadoPagoBrowser };
