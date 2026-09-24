const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const XLSX = require('xlsx');
module.exports = function automationModule({ ensureDir, writeJsonAtomic, readJson, cellDate }) {
const TOTEAT_REPORT_URL = 'https://res8.toteat.com/#/reportes/cierres';
const TOTEAT_REPORT_URLS = [
  TOTEAT_REPORT_URL,
  'https://res8.toteat.com/#/reportes/cierre'
];
const TOTEAT_PAYMENT_DETAILS_REPORT_URL = 'https://res8.toteat.com/#/reportes/detallepagos';
const TOTEAT_PAYMENT_DETAILS_REPORT_URLS = [
  TOTEAT_PAYMENT_DETAILS_REPORT_URL,
  'https://res8.toteat.com/#/reportes/detalle-pagos'
];
const TOTEAT_PURCHASES_URL = 'https://res8.toteat.com/#/compras';
const TOTEAT_KARDEX_URL = 'https://res8.toteat.com/#/list-kardex';
const TOTEAT_LOGIN_URL = 'https://res8.toteat.com/#/logintoteat';
const TOTEAT_SUPPLIERS_URL = 'https://res8.toteat.com/#/proveedores-new';
const TOTEAT_PRODUCTS_URL = 'https://res8.toteat.com/#/productos';
const TOTEAT_PRODUCT_HIERARCHY_URL = 'https://res8.toteat.com/#/jerarquia';
const TOTEAT_INGREDIENT_HIERARCHY_URL = 'https://res8.toteat.com/#/jerarquiaingredientes';
const TOTEAT_EXTRAS_HIERARCHY_URL = 'https://res8.toteat.com/#/jerarquiaextras';
const TOTEAT_RECIPES_URL = 'https://res8.toteat.com/#/ingredientes';
const TOTEAT_RESTAURANTS_URL = 'https://res8.toteat.com/#/restaurant';

function chromeExecutablePath(playwrightExecutablePath = null) {
  return [
    process.env.BREWIT_CHROME_PATH,
    playwrightExecutablePath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean).find(candidate => fs.existsSync(candidate)) || null;
}

function createToteatAutomation(profilesRoot, factoryOptions = {}) {
  const contexts = new Map();
  let nativeQueue = Promise.resolve();
  const diagnosticsRoot = path.join(profilesRoot, 'diagnostics');
  const reportUrls = Array.isArray(factoryOptions.reportUrls) && factoryOptions.reportUrls.length
    ? factoryOptions.reportUrls
    : factoryOptions.reportUrl ? [factoryOptions.reportUrl] : TOTEAT_REPORT_URLS;
  const paymentDetailsReportUrls = Array.isArray(factoryOptions.paymentDetailsReportUrls) && factoryOptions.paymentDetailsReportUrls.length
    ? factoryOptions.paymentDetailsReportUrls
    : factoryOptions.paymentDetailsReportUrl
      ? [factoryOptions.paymentDetailsReportUrl]
      : TOTEAT_PAYMENT_DETAILS_REPORT_URLS;
  const purchasesUrl = factoryOptions.purchasesUrl || TOTEAT_PURCHASES_URL;
  const kardexUrl = factoryOptions.kardexUrl || TOTEAT_KARDEX_URL;
  const loginUrl = factoryOptions.loginUrl || TOTEAT_LOGIN_URL;
  const suppliersUrls = factoryOptions.suppliersUrl ? [factoryOptions.suppliersUrl] : [TOTEAT_SUPPLIERS_URL];
  const productsUrls = factoryOptions.productsUrl ? [factoryOptions.productsUrl] : [TOTEAT_PRODUCTS_URL];
  const productHierarchyUrls = factoryOptions.productHierarchyUrl
    ? [factoryOptions.productHierarchyUrl] : [TOTEAT_PRODUCT_HIERARCHY_URL];
  const ingredientHierarchyUrls = factoryOptions.ingredientHierarchyUrl
    ? [factoryOptions.ingredientHierarchyUrl] : [TOTEAT_INGREDIENT_HIERARCHY_URL];
  const extrasHierarchyUrls = factoryOptions.extrasHierarchyUrl
    ? [factoryOptions.extrasHierarchyUrl] : [TOTEAT_EXTRAS_HIERARCHY_URL];
  const recipesUrls = factoryOptions.recipesUrl ? [factoryOptions.recipesUrl] : [TOTEAT_RECIPES_URL];
  const restaurantsUrl = factoryOptions.restaurantsUrl || TOTEAT_RESTAURANTS_URL;
  const readyTimeout = Number(factoryOptions.readyTimeout) > 0 ? Number(factoryOptions.readyTimeout) : 10000;
  const transitionDelay = Number(factoryOptions.transitionDelay) >= 0 ? Number(factoryOptions.transitionDelay) : 900;
  ensureDir(profilesRoot);
  ensureDir(diagnosticsRoot);
  const automationError = (message, code, status = 500) => {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  };
  const normalizeToteatText = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const downloadLabel = /(?:Descargar|Download|Exportar|Export)\s+(?:las?\s+)?(?:Ventas(?:\s+Totales)?|Total\s+Sales|Sales)/i;
  const paymentDetailsDownloadLabel = /^(?:(?:Descargar|Download|Exportar|Export)\s+)?CSV$/i;
  const loginLabel = /^(?:Iniciar\s+sesión|Iniciar\s+sesion|Ingresar|Sign\s+in|Log\s+in)$/i;
  const logoutLabel = /^(?:Cerrar\s+sesión|Cerrar\s+sesion|Salir|Sign\s+out|Log\s+out)$/i;
  const restaurantTriggerLabel = /^(?:Seleccionar|Select|Cambiar|Change)(?:\s+(?:el|a))?\s+(?:Restaurante|Restaurant)(?:\s+Info)?$/i;
  const reportsLabel = /^(?:Reportes|Reports)$/i;
  const salesReportLabel = /^(?:Resumen(?:\s+general)?\s+de\s+ventas|Sales\s+Summary|Cierres?|Closures?|Ventas\s+consolidadas|Consolidated\s+Sales)$/i;
  const paymentDetailsReportLabel = /^(?:Detalle(?:\s+de)?\s+Pagos|Payment(?:s)?\s+Details?)$/i;
  const expiredSessionText = /(?:sesion.*(?:caducad|invalida)|session.*(?:invalid|expired|has problems)|abrir una nueva sesion|close.*(?:log on|log in).*toteat)/i;
  const reports = {
    sales: {
      key: 'sales',
      label: 'ventas',
      urls: reportUrls,
      downloadLabel,
      attributeSelector: [
        '[data-testid*="download-total-sales" i]', '[data-testid*="sales-download" i]',
        '[aria-label*="total sales" i]', '[aria-label*="ventas totales" i]',
        '[title*="total sales" i]', '[title*="ventas totales" i]'
      ].join(', '),
      directLinkSelector: 'a[href*="reportes/cierre" i], a[href*="reportes/cierres" i], a[href*="reports/closure" i], a[href*="reports/closures" i]',
      menuLabel: salesReportLabel,
      menuPath: 'sales-report-link',
      routePattern: /reportes\/cierres?\b|reports\/closures?\b/i,
      defaultFilename: () => `ventas-toteat-${businessClock().today}.xlsx`
    },
    paymentDetails: {
      key: 'payment-details',
      label: 'Detalle Pagos',
      urls: paymentDetailsReportUrls,
      downloadLabel: paymentDetailsDownloadLabel,
      attributeSelector: [
        '[data-testid*="csv" i]', '[aria-label="CSV" i]', '[title="CSV" i]', 'a[download$=".csv" i]'
      ].join(', '),
      directLinkSelector: 'a[href*="reportes/detallepagos" i], a[href*="reportes/detalle-pagos" i], a[href*="reports/payment-details" i]',
      menuLabel: paymentDetailsReportLabel,
      menuPath: 'payment-details-report-link',
      routePattern: /reportes\/detalle-?pagos\b|reports\/payment-details\b/i,
      defaultFilename: () => `detalle-pagos-toteat-${businessClock().today}.csv`
    },
    purchases: {
      key: 'purchases',
      label: 'Compras',
      urls: [purchasesUrl],
      downloadLabel: /^(?:Exportar|Export)$/i,
      attributeSelector: '[ng-click*="export" i], [data-testid*="export" i], [aria-label*="export" i], [title*="export" i]',
      directLinkSelector: 'a[href*="#/compras" i], a[href*="/compras" i]',
      menuLabel: /^(?:Compras|Purchases|Shopping)$/i,
      menuPath: 'purchases-link',
      routePattern: /\/compras\b|\/purchases\b/i,
      defaultFilename: () => `compras-toteat-${businessClock().today}.xls`
    },
    kardex: {
      key: 'kardex-summary',
      label: 'Kardex resumen diario',
      urls: [kardexUrl],
      downloadLabel: /^(?:Export|Exportar)$/i,
      defaultFilename: () => `kardex-toteat-${businessClock().today}.xlsx`
    },
    suppliers: {
      key: 'suppliers',
      label: 'Proveedores',
      urls: suppliersUrls,
      downloadLabel: /^Exportar$/i,
      attributeSelector: '[data-testid*="export" i], [aria-label="Exportar" i], [title="Exportar" i]',
      directLinkSelector: 'a[href*="proveedores-new" i]',
      menuLabel: /^Proveedores$/i,
      menuPath: 'suppliers-link',
      routePattern: /proveedores-new\b/i,
      skipRestaurantSelection: true,
      defaultFilename: () => `proveedores-toteat-${businessClock().today}.xlsx`
    },
    products: {
      key: 'products-master',
      label: 'Productos / Ingredientes / Extras',
      urls: productsUrls,
      downloadLabel: /XLS\s*Adv\.?\s*Total/i,
      attributeSelector: [
        '[data-testid*="xls-adv-total" i]', '[aria-label*="XLS Adv" i]', '[title*="XLS Adv" i]'
      ].join(', '),
      directLinkSelector: 'a[href*="#/productos" i], a[href*="/productos" i]',
      menuLabel: /^Productos$/i,
      menuPath: 'products-link',
      routePattern: /\/productos\b/i,
      skipRestaurantSelection: true,
      revealControlLabel: /^(?:Actions|Acciones)$/i,
      defaultFilename: () => `productos-ingredientes-extras-toteat-${businessClock().today}.xlsx`
    },
    productHierarchy: {
      key: 'product-hierarchy', label: 'Jerarquía de Productos', urls: productHierarchyUrls,
      downloadLabel: /^CSV\s+AB\.?$/i,
      attributeSelector: 'button[ng-click="exportaCSV()"]',
      strictAttributeSelector: true,
      directLinkSelector: 'a[href*="#/jerarquia" i], a[href*="/jerarquia" i]',
      menuLabel: /Jerarqu[ií]a/i, menuPath: 'product-hierarchy-link', routePattern: /\/jerarquia\b/i,
      skipRestaurantSelection: true,
      revealControlLabel: /^AB\.?$/i,
      defaultFilename: () => `jerarquia-productos-toteat-${businessClock().today}.csv`
    },
    ingredientHierarchy: {
      key: 'ingredient-hierarchy', label: 'Jerarquía de Ingredientes', urls: ingredientHierarchyUrls,
      downloadLabel: /^CSV\s+IC\.?$/i,
      attributeSelector: 'button[ng-click="exportaCSV()"]',
      strictAttributeSelector: true,
      directLinkSelector: 'a[href*="jerarquiaingredientes" i]',
      menuLabel: /Jerarqu[ií]a.*Ingredientes/i, menuPath: 'ingredient-hierarchy-link',
      routePattern: /\/jerarquiaingredientes\b/i, skipRestaurantSelection: true,
      revealControlLabel: /^IC\.?$/i,
      defaultFilename: () => `jerarquia-ingredientes-toteat-${businessClock().today}.csv`
    },
    extrasHierarchy: {
      key: 'extras-hierarchy', label: 'Jerarquía de Extras', urls: extrasHierarchyUrls,
      downloadLabel: /^CSV\s+BA\.?$/i,
      attributeSelector: 'button[ng-click="exportaCSV()"]',
      strictAttributeSelector: true,
      directLinkSelector: 'a[href*="jerarquiaextras" i]',
      menuLabel: /Jerarqu[ií]a.*Extras/i, menuPath: 'extras-hierarchy-link',
      routePattern: /\/jerarquiaextras\b/i, skipRestaurantSelection: true,
      revealControlLabel: /^BA\.?$/i,
      defaultFilename: () => `jerarquia-extras-toteat-${businessClock().today}.csv`
    },
    recipes: {
      key: 'recipes-master', label: 'Maestro de Recetas', urls: recipesUrls,
      expectedDownloads: 2,
      downloadLabel: /^(?:Exportar\s+Recetas|Export\s+Recipes)$/i,
      attributeSelector: 'button[ng-click="exportarRecetas()"]',
      strictAttributeSelector: true,
      directLinkSelector: 'a[href*="#/ingredientes" i], a[href*="/ingredientes" i]',
      menuLabel: /^Ingredientes$/i, menuPath: 'ingredients-link', routePattern: /\/ingredientes\b/i,
      skipRestaurantSelection: true,
      revealControlLabel: /^(?:Recetas|Recipes)$/i,
      revealControlSelector: 'a[ng-click="selectTab(2)"]',
      defaultFilename: () => 'RECETAS_SIN_NOMBRE.txt'
    }
  };
  const elementLabel = async locator => {
    const text = await locator.innerText().catch(() => '');
    const ariaLabel = await locator.getAttribute('aria-label').catch(() => '');
    const title = await locator.getAttribute('title').catch(() => '');
    return String(ariaLabel || title || text || '').replace(/\s+/g, ' ').trim();
  };
  const findVisibleControl = async (page, pattern, selector = 'button, [role="button"], a, [role="menuitem"], [role="option"]') => {
    for (const frame of page.frames()) {
      const controls = frame.locator(selector);
      const count = Math.min(await controls.count().catch(() => 0), 160);
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (!await control.isVisible().catch(() => false)) continue;
        const label = await elementLabel(control);
        if (label.length <= 120 && pattern.test(label)) return control;
      }
    }
    return null;
  };
  const findVisibleTextControl = async (page, pattern) => {
    for (const frame of page.frames()) {
      const matches = frame.getByText(pattern);
      const count = Math.min(await matches.count().catch(() => 0), 80);
      let best = null;
      let bestLength = Infinity;
      for (let index = 0; index < count; index += 1) {
        const candidate = matches.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const label = String(await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!pattern.test(label) || label.length >= bestLength) continue;
        best = candidate;
        bestLength = label.length;
      }
      if (best) return best;
    }
    return null;
  };
  const findDownloadButton = async (page, report) => {
    for (const frame of page.frames()) {
      const selects = frame.locator('select');
      const selectCount = Math.min(await selects.count().catch(() => 0), 40);
      for (let selectIndex = 0; selectIndex < selectCount; selectIndex += 1) {
        const select = selects.nth(selectIndex);
        if (!await select.isVisible().catch(() => false)) continue;
        const options = select.locator('option');
        const optionCount = Math.min(await options.count().catch(() => 0), 120);
        for (let optionIndex = 0; optionIndex < optionCount; optionIndex += 1) {
          const option = options.nth(optionIndex);
          const label = String(await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          if (!report.downloadLabel.test(label)) continue;
          const value = await option.getAttribute('value');
          return {
            click: () => value === null ? select.selectOption({ label }) : select.selectOption(value)
          };
        }
      }
    }
    if (report.attributeSelector) {
      const attributedControl = await findVisibleControl(page, report.downloadLabel, report.attributeSelector);
      if (attributedControl) return attributedControl;
      if (report.strictAttributeSelector) return null;
    }
    return await findVisibleControl(
      page,
      report.downloadLabel,
      'button, [role="button"], a, [role="menuitem"], [role="option"], li'
    ) || findVisibleTextControl(page, report.downloadLabel);
  };
  const waitForDownloadButton = async (page, report, timeout = 12000) => {
    const deadline = Date.now() + timeout;
    let revealed = false;
    do {
      const button = await findDownloadButton(page, report);
      if (button) return button;
      if (!revealed && report.revealControlLabel) {
        const trigger = report.revealControlSelector
          ? await findVisibleControl(page, report.revealControlLabel, report.revealControlSelector)
          : await findVisibleControl(page, report.revealControlLabel)
          || await findVisibleTextControl(page, report.revealControlLabel);
        if (trigger) {
          await trigger.click();
          revealed = true;
          await page.waitForTimeout(transitionDelay);
          continue;
        }
      }
      await page.waitForTimeout(500);
    } while (Date.now() < deadline);
    return null;
  };
  const expiredSessionDialog = async page => {
    for (const frame of page.frames()) {
      const dialogs = frame.locator('.ds-modal-container, [role="dialog"], .modal-dialog, .modal-content');
      const count = Math.min(await dialogs.count().catch(() => 0), 30);
      for (let index = 0; index < count; index += 1) {
        const dialog = dialogs.nth(index);
        if (!await dialog.isVisible().catch(() => false)) continue;
        const text = normalizeToteatText(await dialog.innerText().catch(() => ''));
        if (expiredSessionText.test(text)) return { dialog, text };
      }
    }
    return null;
  };
  const dismissExpiredSession = async page => {
    const expired = await expiredSessionDialog(page);
    if (!expired) return { detected: false, dismissed: false };
    const buttons = expired.dialog.locator('button, [role="button"], a');
    const count = Math.min(await buttons.count().catch(() => 0), 20);
    let confirmation = null;
    for (let index = 0; index < count; index += 1) {
      const candidate = buttons.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const label = await elementLabel(candidate);
      if (/^(?:OK|Aceptar|Continuar|Continue)$/i.test(label)) {
        confirmation = candidate;
        break;
      }
    }
    if (confirmation) {
      await confirmation.click({ timeout: 10000 });
      await page.waitForTimeout(transitionDelay);
      return { detected: true, dismissed: true };
    }
    return { detected: true, dismissed: false };
  };
  const ensureActiveSession = async (page, attempts) => {
    const expired = await dismissExpiredSession(page);
    if (!expired.detected) return;
    attempts.push({ action: 'expired-session-dialog', dismissed: expired.dismissed });
    const error = automationError(
      expired.dismissed
        ? 'La sesión de Toteat estaba vencida y fue cerrada. Inicia la nueva sesión en la ventana que se abrirá.'
        : 'La sesión de Toteat está vencida. Confirma el cierre de sesión en la ventana que se abrirá.',
      'TOTEAT_AUTH_REQUIRED', 409
    );
    error.state = 'session_expired';
    error.attempts = attempts;
    throw error;
  };
  const authenticationRequired = async page => {
    if (await expiredSessionDialog(page)) return true;
    if (/login|signin|auth/i.test(page.url())) return true;
    if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) return true;
    const logout = await findVisibleControl(page, logoutLabel);
    if (logout) return false;
    return Boolean(await findVisibleControl(page, loginLabel));
  };
  const selectRestaurant = async (page, restaurantName, attempts) => {
    const attempt = { action: 'restaurant-selection', restaurantName, required: false, selected: false };
    attempts.push(attempt);
    await ensureActiveSession(page, attempts);
    const trigger = await findVisibleControl(page, restaurantTriggerLabel);
    if (!trigger) return attempt;
    attempt.required = true;
    await trigger.click();
    await page.waitForTimeout(transitionDelay);
    await ensureActiveSession(page, attempts);
    const wanted = normalizeToteatText(restaurantName);
    for (const frame of page.frames()) {
      const options = frame.locator('[role="option"], [role="menuitem"], [role="menuitemradio"], li, button, a');
      const count = Math.min(await options.count().catch(() => 0), 200);
      for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        if (!await option.isVisible().catch(() => false)) continue;
        const label = await elementLabel(option);
        const normalizedLabel = normalizeToteatText(label);
        if (!normalizedLabel || normalizedLabel.length > wanted.length + 45) continue;
        if (normalizedLabel === wanted || normalizedLabel.includes(wanted)) {
          await option.click();
          await page.waitForTimeout(transitionDelay);
          attempt.selected = true;
          attempt.label = label;
          return attempt;
        }
      }
    }
    return attempt;
  };
  const navigateThroughMenus = async (page, attempts, report) => {
    const attempt = { action: 'menu-navigation', path: null };
    attempts.push(attempt);
    await ensureActiveSession(page, attempts);
    const reportLink = await findVisibleControl(page, /./, report.directLinkSelector);
    if (reportLink) {
      attempt.path = 'direct-link';
      await reportLink.click();
      await page.waitForTimeout(transitionDelay);
      await ensureActiveSession(page, attempts);
      return attempt.path;
    }
    const reports = await findVisibleControl(page, reportsLabel);
    if (reports) {
      attempt.path = 'reports-menu';
      await reports.click();
      await page.waitForTimeout(transitionDelay);
      await ensureActiveSession(page, attempts);
    }
    const reportControl = await findVisibleControl(page, report.menuLabel);
    if (!reportControl) return null;
    attempt.path = reports ? 'reports-menu' : report.menuPath;
    await reportControl.click();
    await page.waitForTimeout(transitionDelay);
    await ensureActiveSession(page, attempts);
    return attempt.path;
  };
  const pageState = async (page, report) => {
    if (page.isClosed()) return 'browser_closed';
    if (await expiredSessionDialog(page)) return 'session_expired';
    if (await authenticationRequired(page)) return 'authentication_required';
    if (await findDownloadButton(page, report)) return 'report_ready';
    if (await findVisibleControl(page, restaurantTriggerLabel)) return 'restaurant_required';
    if (report.routePattern.test(page.url())) return 'report_unavailable';
    return 'unexpected_view';
  };
  const captureDiagnostic = async (page, locationId, state, attempts) => {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const id = `TOTEAT-${stamp}-${String(locationId).replace(/[^a-z0-9-]/gi, '')}-${crypto.randomBytes(2).toString('hex')}`;
    const controls = [];
    for (const frame of page.frames()) {
      const candidates = frame.locator('button, [role="button"], a, [role="menuitem"], [role="option"]');
      const count = Math.min(await candidates.count().catch(() => 0), 160);
      for (let index = 0; index < count && controls.length < 24; index += 1) {
        const candidate = candidates.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        const label = await elementLabel(candidate);
        if (label && label.length <= 120 && !controls.includes(label)) controls.push(label);
      }
    }
    const diagnostic = {
      id,
      capturedAt: new Date().toISOString(),
      locationId,
      state,
      url: page.url(),
      title: await page.title().catch(() => ''),
      attempts,
      visibleControls: controls
    };
    writeJsonAtomic(path.join(diagnosticsRoot, `${id}.json`), diagnostic);
    await page.screenshot({ path: path.join(diagnosticsRoot, `${id}.png`), fullPage: false }).catch(() => {});
    return diagnostic;
  };
  const attachDiagnostic = async (error, page, locationId, attempts, report) => {
    if (error.diagnosticId) return error;
    const state = error.state || await pageState(page, report).catch(() => 'unknown');
    const diagnostic = await captureDiagnostic(page, locationId, state, attempts).catch(() => null);
    error.state = state;
    if (diagnostic) {
      error.diagnosticId = diagnostic.id;
      error.message = `${error.message} Estado: ${state}. Diagnóstico: ${diagnostic.id}.`;
    }
    return error;
  };
  const launch = async (locationId, headless) => {
    let chromium = factoryOptions.chromium;
    try { if (!chromium) ({ chromium } = require('playwright-core')); } catch {
      throw automationError('La automatización de Toteat no está instalada en este servidor.', 'TOTEAT_BROWSER_UNAVAILABLE');
    }
    let playwrightExecutablePath = null;
    try { playwrightExecutablePath = chromium.executablePath?.() || null; } catch {}
    const executablePath = factoryOptions.executablePath || chromeExecutablePath(playwrightExecutablePath);
    if (!executablePath) {
      throw automationError('No se encontró Google Chrome o Chromium para conectarse a Toteat.', 'TOTEAT_BROWSER_UNAVAILABLE');
    }
    const profileRoot = path.join(profilesRoot, locationId);
    ensureDir(profileRoot);
    return chromium.launchPersistentContext(profileRoot, {
      executablePath,
      headless,
      acceptDownloads: true,
      viewport: { width: 1440, height: 960 },
      args: ['--disable-blink-features=AutomationControlled']
    });
  };
  const reportPage = async (context, report) => {
    const pages = context.pages();
    const page = pages.find(item => item.url().includes('toteat.com')) || pages[0] || await context.newPage();
    await page.goto(report.urls[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
    return page;
  };
  const selectRestaurantRecord = async (page, restaurant) => {
    await page.goto(restaurantsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await ensureActiveSession(page, []);
    const rows = page.locator('tr[ng-click*="selecciona"]');
    const count = await rows.count();
    const expected = {
      restaurantId: String(restaurant.restaurantId || '').trim(),
      localId: String(restaurant.localId || '').trim(),
      name: normalizeToteatText(restaurant.name),
      simpleId: String(restaurant.simpleId || '').trim()
    };
    const readActiveRestaurant = () => page.evaluate(() => {
      try {
        const active = JSON.parse(localStorage.getItem('resto') || 'null');
        return active ? {
          restaurantId: String(active.ir ?? ''),
          localId: String(active.il ?? ''),
          name: String(active.nr ?? ''),
          simpleId: String(active.si ?? ''),
          createdAt: String(active.fc ?? '')
        } : null;
      } catch {
        return null;
      }
    });
    const isExpectedRestaurant = active => Boolean(active)
      && (!expected.restaurantId || active.restaurantId === expected.restaurantId)
      && (!expected.localId || active.localId === expected.localId)
      && (!expected.name || normalizeToteatText(active.name) === expected.name)
      && (!expected.simpleId || active.simpleId === expected.simpleId);
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const cells = (await row.locator('td').allTextContents()).map(value => String(value).trim());
      if (cells.length < 5) continue;
      const matches = (!expected.restaurantId || cells[0] === expected.restaurantId)
        && (!expected.localId || cells[1] === expected.localId)
        && (!expected.name || normalizeToteatText(cells[2]) === expected.name)
        && (!expected.simpleId || cells[4] === expected.simpleId);
      if (!matches) continue;
      const alreadyActive = await readActiveRestaurant();
      if (isExpectedRestaurant(alreadyActive)) {
        return { ...alreadyActive, changed: false };
      }
      await row.click();
      await page.waitForFunction(element => element.classList.contains('seleccionado'), await row.elementHandle(), { timeout: 10000 });
      const confirm = page.locator('button:visible, a:visible, [role="button"]:visible')
        .filter({ hasText: /^\s*(?:Confirm|Confirmar)\s*$/i }).last();
      if (!await confirm.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) {
        throw automationError(
          `TotEat seleccionó “${restaurant.name}”, pero no mostró el botón para confirmar el cambio de local.`,
          'TOTEAT_RESTAURANT_CONFIRMATION_REQUIRED', 502
        );
      }
      await confirm.click();
      await page.waitForFunction(target => {
        try {
          const active = JSON.parse(localStorage.getItem('resto') || 'null');
          if (!active) return false;
          return (!target.restaurantId || String(active.ir ?? '') === target.restaurantId)
            && (!target.localId || String(active.il ?? '') === target.localId)
            && (!target.simpleId || String(active.si ?? '') === target.simpleId);
        } catch {
          return false;
        }
      }, expected, { timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(transitionDelay);
      const active = await readActiveRestaurant();
      if (!isExpectedRestaurant(active)) {
        throw automationError(
          `TotEat no confirmó “${restaurant.name}” como local activo. Se canceló la descarga para evitar mezclar ventas.`,
          'TOTEAT_RESTAURANT_SWITCH_FAILED', 502
        );
      }
      return { ...active, changed: true };
    }
    throw automationError(`No se encontró el local “${restaurant.name}” en TotEat con los identificadores configurados.`, 'TOTEAT_RESTAURANT_NOT_FOUND', 422);
  };
  const assertActiveRestaurant = async (page, restaurant) => {
    const active = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('resto') || 'null'); } catch { return null; }
    });
    if (!active || String(active.ir ?? '') !== String(restaurant.restaurantId)
      || String(active.il ?? '') !== String(restaurant.localId)
      || String(active.si ?? '') !== String(restaurant.simpleId)) {
      throw automationError(`TotEat no tiene activo el local “${restaurant.name}”. Se detuvo la descarga para evitar mezclar datos.`, 'TOTEAT_RESTAURANT_SWITCH_FAILED', 422);
    }
    return active;
  };
  const setToteatDateInput = async (page, input, modelField, value) => {
    await input.fill(value);
    await input.evaluate((element, date) => {
      const angular = window.angular;
      const wrapped = angular?.element(element);
      const injector = wrapped?.injector();
      const controller = wrapped?.controller('ngModel');
      const rootScope = injector?.get('$rootScope');
      if (!rootScope?.varios || !controller) return;
      const parsed = new Date(`${date.value}T12:00:00`);
      rootScope.$apply(() => {
        rootScope.varios[date.modelField] = parsed;
        controller.$setValidity('date', true);
      });
    }, { modelField, value });
    await page.waitForFunction(element => element.value && element.getAttribute('aria-invalid') !== 'true', await input.elementHandle(), { timeout: 10000 });
  };
  const configureDatedReport = async (page, dateFrom, dateTo, options = {}) => {
    const rangeLabel = page.locator('label[for="tipoRango"]:visible').last();
    await rangeLabel.click();
    const period = page.locator('select[ng-model="varios.seleccionFechas"]:visible').last();
    await period.selectOption('custom');
    await page.waitForTimeout(transitionDelay);
    const from = page.locator('input[ng-model="varios.fechaDesde"]:visible').last();
    const to = page.locator('input[ng-model="varios.fechaHasta"]:visible').last();
    await setToteatDateInput(page, from, 'fechaDesde', dateFrom);
    await setToteatDateInput(page, to, 'fechaHasta', dateTo);
    if (options.errorFactory?.()) throw options.errorFactory();
    const refresh = page.locator('button[ng-click="generaReporte()"]:visible').last();
    await refresh.click();
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    if (options.errorFactory?.()) throw options.errorFactory();
    const downloadControl = page.locator(options.downloadSelector || 'a[ng-click="exportaTotalVentasExcel()"]:visible');
    try {
      await downloadControl.last().waitFor({ state: 'visible', timeout: 45000 });
    } catch (error) {
      if (options.errorFactory?.()) throw options.errorFactory();
      throw automationError(
        `TotEat no generó un archivo porque no encontró ${options.emptyLabel || 'registros'} para el local y período seleccionados.`,
        options.emptyCode || 'TOTEAT_NO_DATA_AVAILABLE', 422
      );
    }
    await page.waitForTimeout(transitionDelay);
  };
  const configureSalesDateRange = (page, dateFrom, dateTo, reportAccessError = () => null) => configureDatedReport(
    page, dateFrom, dateTo, {
      errorFactory: reportAccessError,
      downloadSelector: 'a[ng-click="exportaTotalVentasExcel()"]:visible',
      emptyLabel: 'ventas', emptyCode: 'TOTEAT_NO_SALES_AVAILABLE'
    }
  );
  const prepareReport = async (page, restaurantName, report) => {
    const attempts = [{ action: 'direct-url', url: page.url() }];
    const requireAuthentication = async () => {
      await ensureActiveSession(page, attempts);
      if (!await authenticationRequired(page)) return;
      const error = automationError(
        'La sesión de Toteat necesita autenticación. Inicia sesión en la ventana que se abrirá y vuelve a intentar.',
        'TOTEAT_AUTH_REQUIRED', 409
      );
      error.state = 'authentication_required';
      error.attempts = attempts;
      throw error;
    };
    const visitReportUrl = async (url, action) => {
      const attempt = { action, url };
      attempts.push(attempt);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await requireAuthentication();
      const found = await waitForDownloadButton(page, report, readyTimeout);
      await ensureActiveSession(page, attempts);
      attempt.ready = Boolean(found);
      return found;
    };
    try {
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await requireAuthentication();
      let button = await waitForDownloadButton(page, report, readyTimeout);
      await ensureActiveSession(page, attempts);
      if (button) return { button, attempts };
      const restaurant = report.skipRestaurantSelection
        ? { required: false, selected: false }
        : await selectRestaurant(page, restaurantName, attempts);
      if (restaurant.required && !restaurant.selected) {
        const error = automationError(
          `Toteat solicita seleccionar un restaurante, pero no se encontró “${restaurantName}”.`,
          'TOTEAT_RESTAURANT_NOT_FOUND', 422
        );
        error.state = 'restaurant_required';
        throw error;
      }
      const urlsToTry = restaurant.selected ? report.urls : report.urls.slice(1);
      for (const [index, url] of urlsToTry.entries()) {
        button = await visitReportUrl(url, restaurant.selected && index === 0 ? 'report-after-restaurant' : 'alternate-report-url');
        if (button) return { button, attempts };
        const routeRestaurant = report.skipRestaurantSelection
          ? { required: false, selected: false }
          : await selectRestaurant(page, restaurantName, attempts);
        if (routeRestaurant.required && !routeRestaurant.selected) {
          const error = automationError(
            `Toteat solicita seleccionar un restaurante, pero no se encontró “${restaurantName}”.`,
            'TOTEAT_RESTAURANT_NOT_FOUND', 422
          );
          error.state = 'restaurant_required';
          throw error;
        }
        if (routeRestaurant.selected) {
          button = await visitReportUrl(url, 'report-after-restaurant');
          if (button) return { button, attempts };
        }
      }
      const menuPath = await navigateThroughMenus(page, attempts, report);
      button = await waitForDownloadButton(page, report, readyTimeout);
      await ensureActiveSession(page, attempts);
      if (button) return { button, attempts };
      const reloadAttempt = { action: 'reload', url: page.url(), menuPath };
      attempts.push(reloadAttempt);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await requireAuthentication();
      button = await waitForDownloadButton(page, report, readyTimeout);
      await ensureActiveSession(page, attempts);
      reloadAttempt.ready = Boolean(button);
      if (button) return { button, attempts };
      const error = automationError(
        `Toteat está autenticado, pero no fue posible llegar al reporte de ${report.label} ni encontrar su control de descarga.`,
        'TOTEAT_REPORT_NOT_READY', 502
      );
      error.state = await pageState(page, report);
      throw error;
    } catch (error) {
      error.attempts ||= attempts;
      throw error;
    }
  };
  const downloadReport = async (locationId, options, report) => {
    let context = options.context || contexts.get(locationId);
    const reusedVisibleContext = Boolean(contexts.get(locationId));
    if (!context) context = await launch(locationId, true);
    let page = null;
    let attempts = [];
    let captureDirectory = null;
    try {
      page = options.preparedPage || await reportPage(context, report);
      const prepared = options.preparedPage
        ? { button: await waitForDownloadButton(page, report, readyTimeout), attempts: [{ action: 'prepared-report', url: page.url() }] }
        : await prepareReport(page, options.restaurantName || locationId, report);
      if (!prepared.button) throw automationError(`No se encontró la descarga de ${report.label}.`, 'TOTEAT_REPORT_NOT_READY', 502);
      attempts = prepared.attempts;
      const button = prepared.button;
      attempts.push({ action: 'download-click', report: report.key });
      await ensureActiveSession(page, attempts);
      captureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-toteat-download-'));
      const observedDownloads = [];
      const captures = [];
      const observeDownload = download => {
        const destination = path.join(captureDirectory, `${observedDownloads.length}.download`);
        observedDownloads.push(download);
        captures.push(download.saveAs(destination).then(
          () => ({ destination }),
          error => ({ error })
        ));
      };
      page.on('download', observeDownload);
      const downloadPromise = page.waitForEvent('download', { timeout: 90000 });
      try {
        await button.click();
        await downloadPromise;
        const expectedDownloads = Math.max(1, Number(report.expectedDownloads) || 1);
        const additionalDeadline = Date.now() + 30000;
        while (observedDownloads.length < expectedDownloads && Date.now() < additionalDeadline) {
          await page.waitForTimeout(250);
        }
        if (observedDownloads.length < expectedDownloads) {
          throw automationError(
            `Toteat generó ${observedDownloads.length} de ${expectedDownloads} archivos para ${report.label}.`,
            'TOTEAT_INCOMPLETE_DOWNLOAD', 502
          );
        }
      } finally {
        page.off('download', observeDownload);
      }
      const files = [];
      const captured = await Promise.all(captures.slice(0, report.expectedDownloads || 1));
      const captureError = captured.find(item => item.error)?.error;
      if (captureError) throw captureError;
      for (const [index, download] of observedDownloads.slice(0, report.expectedDownloads || 1).entries()) {
        const suggestedFilename = download.suggestedFilename() || report.defaultFilename();
        const filename = suggestedFilename.replace(/\.csv\.txt$/i, '.csv');
        const extension = path.extname(filename).toLowerCase();
        files.push({
          filename,
          contentType: extension === '.csv'
            ? 'text/csv; charset=utf-8'
            : extension === '.txt' || extension === '.tsv'
              ? 'text/plain; charset=utf-8'
              : extension === '.xls'
                ? 'application/vnd.ms-excel'
                : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: fs.readFileSync(captured[index].destination)
        });
      }
      return files.length === 1 ? files[0] : { files };
    } catch (caught) {
      const browserClosed = /Target page, context or browser has been closed|Target closed/i.test(caught?.message || '');
      const error = caught?.code ? caught : browserClosed
        ? automationError(
          'El navegador usado para descargar desde Toteat se cerró inesperadamente.',
          'TOTEAT_BROWSER_CLOSED', 502
        )
        : automationError(
          caught?.message || 'La automatización de Toteat falló inesperadamente.', 'TOTEAT_AUTOMATION_FAILED', 502
        );
      if (browserClosed) error.state = 'browser_closed';
      if (page) throw await attachDiagnostic(error, page, locationId, error.attempts || attempts, report);
      throw error;
    } finally {
      if (captureDirectory) fs.rmSync(captureDirectory, { recursive: true, force: true });
      if (!reusedVisibleContext) await context.close().catch(() => {});
    }
  };
  return {
    readNativeSources(restaurant, options = {}) {
      const task = nativeQueue.then(async () => {
        let browser, context, page, ownsPage = false;
        const connection = readJson(path.join(profilesRoot, 'browser-connection.json'), {});
        const endpoint = factoryOptions.cdpEndpoint || process.env.TOTEAT_CDP_ENDPOINT || connection.cdpEndpoint;
        try {
          if (endpoint) {
            if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) throw new Error('El navegador de Toteat debe estar en este equipo.');
            try { browser = await require('playwright-core').chromium.connectOverCDP(endpoint); }
            catch { throw automationError('El navegador conectado de Toteat no está disponible.', 'TOTEAT_BROWSER_UNAVAILABLE', 503); }
            context = browser.contexts()[0];
          } else context = contexts.get('master-downloads') || await launch('master-downloads', true);
          // Reuse the authenticated SPA: a new tab can lose Toteat's in-memory session.
          page = context.pages().filter(p => /^https:\/\/res\d*\.toteat\.com\//.test(p.url())).at(-1);
          if (!page) { page = await context.newPage(); ownsPage = true; }
          await selectRestaurantRecord(page, restaurant);
          return await readNative(page, restaurant, options);
        } finally {
          if (ownsPage) await page?.close().catch(() => {});
          if (browser) await browser.close().catch(() => {});
          else if (context && !contexts.has('master-downloads')) await context.close().catch(() => {});
        }
      });
      nativeQueue = task.catch(() => {});
      return task;
    },
    async connect(locationId) {
      const current = contexts.get(locationId);
      if (current) {
        const page = await reportPage(current, reports.sales);
        await page.bringToFront();
        return { opened: true };
      }
      const context = await launch(locationId, false);
      contexts.set(locationId, context);
      context.on('close', () => contexts.delete(locationId));
      await reportPage(context, reports.sales);
      return { opened: true };
    },
    async downloadSales(locationId, options = {}) {
      return downloadReport(locationId, options, reports.sales);
    },
    async connectTransactionalDownloads() {
      const locationId = 'master-downloads';
      const current = contexts.get(locationId);
      const context = current || await launch(locationId, false);
      if (!current) {
        contexts.set(locationId, context);
        context.on('close', () => contexts.delete(locationId));
      }
      const page = context.pages()[0] || await context.newPage();
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      let requiresAuthentication = await authenticationRequired(page);
      let refreshed = false;
      if (!requiresAuthentication) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        refreshed = true;
        requiresAuthentication = await authenticationRequired(page);
      }
      await page.bringToFront();
      return { opened: true, requiresAuthentication, refreshed };
    },
    async downloadTransactionalSales(options = {}) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      let reportUnavailable = false;
      const observeConsole = message => {
        if (message.type() === 'error' && /permission_denied at \/R\/PROD-/i.test(message.text())) reportUnavailable = true;
      };
      const reportAccessError = () => reportUnavailable ? automationError(
        `TotEat no generó un archivo porque “${options.restaurant?.name || 'el local'}” todavía no tiene ventas disponibles para el período seleccionado.`,
        'TOTEAT_NO_SALES_AVAILABLE', 422
      ) : null;
      page.on('console', observeConsole);
      try {
        const selectedRestaurant = await selectRestaurantRecord(page, options.restaurant || {});
        const restaurantCreatedAt = /^\d{4}-\d{2}-\d{2}/.test(selectedRestaurant.createdAt)
          ? selectedRestaurant.createdAt.slice(0, 10) : null;
        const effectiveDateFrom = restaurantCreatedAt && restaurantCreatedAt > options.dateFrom
          ? restaurantCreatedAt : options.dateFrom;
        await page.goto(reports.sales.urls[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        if (reportAccessError()) throw reportAccessError();
        await configureSalesDateRange(page, effectiveDateFrom, options.dateTo, reportAccessError);
        const download = await downloadReport(locationId, { context, preparedPage: page }, reports.sales);
        download.dateFrom = effectiveDateFrom;
        return download;
      } finally {
        page.off('console', observeConsole);
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async selectTransactionalRestaurant(restaurant) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      try {
        return await selectRestaurantRecord(page, restaurant);
      } finally {
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async downloadTransactionalPaymentDetails(options = {}) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      try {
        const active = await assertActiveRestaurant(page, options.restaurant);
        const dateFrom = /^\d{4}-\d{2}-\d{2}/.test(active.fc) && active.fc.slice(0, 10) > options.dateFrom
          ? active.fc.slice(0, 10) : options.dateFrom;
        await page.goto(reports.paymentDetails.urls[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await configureDatedReport(page, dateFrom, options.dateTo, {
          downloadSelector: 'a[ng-click*="exportaCSVnew"][download$=".csv"]:visible, a:visible[download$=".csv"]',
          emptyLabel: 'pagos', emptyCode: 'TOTEAT_NO_PAYMENT_DETAILS_AVAILABLE'
        });
        const download = await downloadReport(locationId, { context, preparedPage: page }, reports.paymentDetails);
        download.dateFrom = dateFrom;
        return download;
      } finally {
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async downloadTransactionalPurchases(options = {}) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      try {
        const active = await assertActiveRestaurant(page, options.restaurant);
        const dateFrom = /^\d{4}-\d{2}-\d{2}/.test(active.fc) && active.fc.slice(0, 10) > options.dateFrom
          ? active.fc.slice(0, 10) : options.dateFrom;
        await page.goto(purchasesUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        let purchaseFrame = null;
        const deadline = Date.now() + 60000;
        while (!purchaseFrame && Date.now() < deadline) {
          for (const frame of page.frames()) {
            if (!/\/purchases\b/i.test(frame.url())) continue;
            if (await frame.locator('button:visible').filter({ hasText: /^\s*(?:Export|Exportar)\s*$/i }).first().isVisible().catch(() => false)) {
              purchaseFrame = frame;
              break;
            }
          }
          if (!purchaseFrame) await page.waitForTimeout(500);
        }
        if (!purchaseFrame) throw automationError('No se cargó la vista de Compras en TotEat.', 'TOTEAT_PURCHASE_REPORT_NOT_READY', 502);
        const exportButton = purchaseFrame.locator('button:visible').filter({ hasText: /^\s*(?:Export|Exportar)\s*$/i }).last();
        await exportButton.waitFor({ state: 'visible', timeout: 60000 });
        const moreFilters = purchaseFrame.locator('input[type="checkbox"]:visible').first();
        await moreFilters.check();
        await page.waitForTimeout(transitionDelay);
        const selects = purchaseFrame.locator('select:visible');
        const selectMatching = async expression => {
          const count = await selects.count();
          for (let index = 0; index < count; index += 1) {
            const select = selects.nth(index);
            const optionsList = await select.locator('option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent.trim() })));
            const match = optionsList.find(item => expression.test(item.text));
            if (match) { await select.selectOption(match.value); return select; }
          }
          return null;
        };
        const dateRange = await selectMatching(/^(?:Personalizado|Custom)$/i);
        if (!dateRange) throw automationError('No se encontró el filtro de fechas personalizado en Compras.', 'TOTEAT_PURCHASE_FILTER_NOT_FOUND', 502);
        await page.waitForTimeout(transitionDelay);
        const dates = purchaseFrame.locator('input[type="date"]:visible');
        if (await dates.count() < 2) throw automationError('No se encontraron las fechas de inicio y fin en Compras.', 'TOTEAT_PURCHASE_DATES_NOT_FOUND', 502);
        await dates.first().fill(dateFrom);
        await dates.last().fill(options.dateTo);
        const visualization = await selectMatching(/^(?:Campos Adicionales|Additional Fields)$/i);
        if (!visualization) throw automationError('No se encontró “Campos Adicionales” en la visualización de Compras.', 'TOTEAT_PURCHASE_VIEW_NOT_FOUND', 502);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(transitionDelay);
        const download = await downloadReport(locationId, { context, preparedPage: page }, reports.purchases);
        const workbook = XLSX.read(download.buffer, { type: 'buffer' });
        const hasRecords = workbook.SheetNames.some(name => XLSX.utils.sheet_to_json(workbook.Sheets[name], {
          header: 1, blankrows: false
        }).slice(1).some(row => row.some(value => String(value ?? '').trim())));
        if (!hasRecords) {
          throw automationError('TotEat no entregó registros de Compras para el local y período seleccionados.', 'TOTEAT_NO_PURCHASES_AVAILABLE', 422);
        }
        download.dateFrom = dateFrom;
        return download;
      } finally {
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async downloadTransactionalKardex(options = {}) {
      const locationId = 'master-downloads';
      let context = contexts.get(locationId);
      if (!context) context = await launch(locationId, true);
      const page = context.pages()[0] || await context.newPage();
      try {
        if (!page.url().includes('toteat.com')) {
          await page.goto(restaurantsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        const active = await assertActiveRestaurant(page, options.restaurant);
        const dateFrom = /^\d{4}-\d{2}-\d{2}/.test(active.fc) && active.fc.slice(0, 10) > options.dateFrom
          ? active.fc.slice(0, 10) : options.dateFrom;
        await page.goto(kardexUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        let frame = null;
        const deadline = Date.now() + 60000;
        while (!frame && Date.now() < deadline) {
          for (const candidate of page.frames()) {
            if (!/\/list-kardex\b/i.test(candidate.url()) || candidate === page.mainFrame()) continue;
            if (await candidate.getByText('Kardex resumen diario', { exact: true }).first().isVisible().catch(() => false)) {
              frame = candidate;
              break;
            }
          }
          if (!frame) await page.waitForTimeout(500);
        }
        if (!frame) throw automationError('No se cargó Kardex resumen diario en TotEat.', 'TOTEAT_KARDEX_REPORT_NOT_READY', 502);
        await frame.getByText('Kardex resumen diario', { exact: true }).first().click();
        await frame.locator('.multiselect').first().click();
        const localNumber = Number(options.restaurant.localId);
        if (!Number.isInteger(localNumber) || localNumber <= 0) {
          throw automationError('El ID Local de TotEat no es válido para seleccionar la bodega.', 'TOTEAT_KARDEX_LOCAL_ID_INVALID', 422);
        }
        const prefix = {
          local: 'bodega local',
          waste: 'bodega merma local',
          central: 'bodega central local',
          'central-waste': 'bodega central merma local'
        }[options.kind];
        if (!prefix) throw automationError('Tipo de Kardex no reconocido.', 'TOTEAT_KARDEX_KIND_INVALID', 400);
        const warehousePrefix = `${prefix} ${String(localNumber).padStart(3, '0')} `;
        const available = await frame.locator('.multiselect [role="option"]:visible').allTextContents();
        const matches = available.map(value => value.trim()).filter(value => normalizeToteatText(value).startsWith(warehousePrefix));
        if (matches.length !== 1) {
          throw automationError(
            `Se esperó una bodega “${warehousePrefix.trim()}” en TotEat, pero se encontraron ${matches.length}. Opciones: ${available.map(value => value.trim()).join(', ')}. Se canceló para evitar mezclar inventarios.`,
            'TOTEAT_KARDEX_WAREHOUSE_NOT_FOUND', 422
          );
        }
        const warehouseName = matches[0];
        await frame.getByRole('option', { name: warehouseName, exact: true }).click();
        if (!normalizeToteatText(await frame.locator('.multiselect').first().innerText()).includes(normalizeToteatText(warehouseName))) {
          throw automationError(`TotEat no confirmó la bodega “${warehouseName}”.`, 'TOTEAT_KARDEX_WAREHOUSE_NOT_SELECTED', 502);
        }
        const costSelect = frame.locator('#cost');
        await costSelect.selectOption('cost_last_inbound');
        if (await costSelect.inputValue() !== 'cost_last_inbound') {
          throw automationError('No se pudo seleccionar “Costo Última Compra” en TotEat. Se canceló el Kardex para evitar usar otro costo.', 'TOTEAT_KARDEX_COST_NOT_SELECTED', 502);
        }
        await frame.locator('#filter').selectOption('custom');
        await frame.locator('#date_init').fill(dateFrom);
        await frame.locator('#date_end').fill(options.dateTo);
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(transitionDelay);
        const download = await downloadReport(locationId, { context, preparedPage: page }, reports.kardex);
        const workbook = XLSX.read(download.buffer, { type: 'buffer' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = firstSheet ? XLSX.utils.sheet_to_json(firstSheet, { header: 1, range: 0, defval: null, blankrows: false }) : [];
        if (!rowContainsAll(rows[0] || [], ['Código', 'Nombre', 'Unidad'])
          || !(rows[0] || []).some(value => cellDate(value))) {
          throw automationError('TotEat descargó un archivo que no coincide con Kardex resumen diario.', 'TOTEAT_KARDEX_INVALID_FILE', 502);
        }
        if (!rows.slice(2).some(row => String(row[0] ?? '').trim() || String(row[1] ?? '').trim())) {
          throw automationError(`TotEat no entregó registros de Kardex para “${warehouseName}” en el período seleccionado.`, 'TOTEAT_NO_KARDEX_AVAILABLE', 422);
        }
        download.dateFrom = dateFrom;
        download.warehouseName = warehouseName;
        return download;
      } finally {
        if (!contexts.has(locationId)) await context.close().catch(() => {});
      }
    },
    async downloadPaymentDetails(locationId, options = {}) {
      return downloadReport(locationId, options, reports.paymentDetails);
    },
    async connectMasterDownloads() {
      const locationId = 'master-downloads';
      const current = contexts.get(locationId);
      if (current) {
        const pages = current.pages();
        const page = pages.find(item => item.url().includes('toteat.com')) || pages[0] || await current.newPage();
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        let requiresAuthentication = await authenticationRequired(page);
        let refreshed = false;
        if (!requiresAuthentication) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          refreshed = true;
          requiresAuthentication = await authenticationRequired(page);
        }
        await page.bringToFront();
        return { opened: true, requiresAuthentication, refreshed };
      }
      const context = await launch(locationId, false);
      contexts.set(locationId, context);
      context.on('close', () => contexts.delete(locationId));
      const page = context.pages()[0] || await context.newPage();
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      let requiresAuthentication = await authenticationRequired(page);
      let refreshed = false;
      if (!requiresAuthentication) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        refreshed = true;
        requiresAuthentication = await authenticationRequired(page);
      }
      return { opened: true, requiresAuthentication, refreshed };
    },
    async downloadSuppliers() {
      return downloadReport('master-downloads', {}, reports.suppliers);
    },
    async downloadProductsMaster() {
      return downloadReport('master-downloads', {}, reports.products);
    },
    async downloadProductHierarchy() {
      return downloadReport('master-downloads', {}, reports.productHierarchy);
    },
    async downloadIngredientHierarchy() {
      return downloadReport('master-downloads', {}, reports.ingredientHierarchy);
    },
    async downloadExtrasHierarchy() {
      return downloadReport('master-downloads', {}, reports.extrasHierarchy);
    },
    async downloadRecipes() {
      return downloadReport('master-downloads', {}, reports.recipes);
    }
  };
}

return { createToteatAutomation, TOTEAT_REPORT_URL, TOTEAT_LOGIN_URL };
};
