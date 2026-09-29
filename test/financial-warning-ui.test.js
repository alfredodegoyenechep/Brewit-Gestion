const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('every warning opens an accessible evidence dialog and restores focus on Escape', { skip: !fs.existsSync(chrome) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-warning-ui-'));
  const server = createApp({ enableLegacyTools: true, uploadsRoot: root }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-view="financial-results"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#financial-warnings-list button').length > 0);
  const buttons = page.locator('#financial-warnings-list button');
  const count = await buttons.count();
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index);
    const text = await button.innerText();
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Datos que requieren revisión', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.locator('.financial-warning-message').innerText(), text);
    assert.match(await dialog.innerText(), /Qué revisar y corregir/);
    assert.ok(await dialog.locator('tbody tr').count() > 0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.financial-warning-dialog'));
    assert.equal(await page.locator('.financial-warning-dialog').count(), 0);
    assert.equal(await button.evaluate(element => element === document.activeElement), true);
  }
});
