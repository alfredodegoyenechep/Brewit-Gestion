const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
test('normal UI exposes API sources and only supported manual uploads', { skip: !fs.existsSync(chrome) }, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-cleanup-'));
  const server=createApp({uploadsRoot:root}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.getByRole('link',{name:'Datos y sincronización',exact:true}).click();
  await page.locator('#upload-manual-actions button').first().waitFor();
  assert.deepEqual(errors,[]);
  assert.equal(await page.locator('#file-loader, #report-download-toteat-sales, #process-inventory-report, [data-toteat-inventory-pilot]').count(),0);
  const fields=await page.locator('[data-upload-field]').evaluateAll(nodes=>[...new Set(nodes.map(n=>n.dataset.uploadField))].sort());
  assert.deepEqual(fields,['employees','marketing','mercadopago']);
  for(const route of ['/api/integrations/toteat/connect','/api/integrations/toteat/master-downloads/connect','/api/integrations/toteat/transactional-downloads/connect','/api/integrations/toteat/download-sales','/api/integrations/toteat/download-payment-details','/upload/master','/api/uploads/weekly/inspect','/api/uploads/weekly/confirm',
    ...['suppliers','products','recipes','finalize','product-hierarchy','ingredient-hierarchy','extras-hierarchy'].map(part=>'/api/integrations/toteat/master-downloads/'+part),
    ...['sales','select-location','payment-details','purchases','kardex-stock','kardex-waste'].map(part=>'/api/integrations/toteat/transactional-downloads/'+part)]){
    assert.equal((await fetch(base+route,{method:'POST'})).status,404,route);
  }
  assert.equal((await fetch(base+'/api/integrations/toteat/inventory/pilot')).status,404);
  assert.equal((await fetch(base+'/api/integrations/toteat/inventory/pilot/export')).status,404);
  for(const route of ['/api/weeks/2026-09-21/store-1/sales','/api/transactions/store-1/sales','/api/masters/2026-09-21/master-catalog']) {
    assert.equal((await fetch(base+route,{method:'DELETE'})).status,404,route);
  }
  const form=new FormData();form.append('sales',new Blob(['anything']), 'sales.csv');
  assert.equal((await fetch(base+'/api/uploads/transactions/inspect?location=store-1',{method:'POST',body:form})).status,400);
});
