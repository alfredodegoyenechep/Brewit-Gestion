const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { chromium } = require('playwright-core');
const { createApp } = require('../server');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('reduced Kardex exports keep hierarchy, filtered order, numeric signs and missing data', {skip: !fs.existsSync(chrome)}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brewit-reduced-export-'));
  const server = createApp({uploadsRoot:root,enableToteatSync:false}).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const browser = await chromium.launch({executablePath:chrome,headless:true});
  t.after(async () => { await browser.close(); await new Promise(resolve=>server.close(resolve)); fs.rmSync(root,{recursive:true,force:true}); });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => Object.keys(locationRegistry).length > 0);
  await page.getByRole('link',{name:'Inventario',exact:true}).click();
  await page.waitForFunction(() => inventorySourceState !== null);
  await page.evaluate(() => {
    const base = {unit:'UN',unitCost:100,costAvailable:true,initialInventory:0,theoreticalFinal:99,adjustedTheoreticalFinal:2,movements:{}};
    const items = [
      {...base,code:'A',name:'Vaso A',hierarchyPath:['Ingredientes','Packaging'],finalInventory:1,difference:-1,totalCost:-100},
      {...base,code:'B',name:'Vaso B',hierarchyPath:['Ingredientes','Packaging'],finalInventory:5,difference:3,totalCost:300},
      {...base,code:'C',name:'Sin toma',finalInventory:null,difference:null,totalCost:null},
      {...base,code:'D',name:'Sin costo',costAvailable:false,finalInventory:0,difference:-2,totalCost:999}
    ];
    renderInventoryResults({location:{id:'main-warehouse',name:'Bodega Principal'},report:{items,itemCount:4,boundaryMode:true,movementDefinitions:[],dateFrom:'2026-09-01',dateTo:'2026-09-29',selection:{initialBasis:'physical',finalBasis:'physical',initialDate:'2026-09-01',finalDate:'2026-09-30'}}});
  });
  assert.equal(await page.locator('#inventory-results-table thead th').first().innerText(),'Jerarquía');
  assert.equal(await page.locator('#inventory-results-table tbody tr').first().locator('td').first().innerText(),'Ingredientes › Packaging');
  assert.equal(await page.locator('#inventory-results-table tbody tr').first().locator('td').nth(1).innerText(),'A');
  await page.locator('#inventory-kardex-physical-filter').selectOption('nonzero');
  const sort = page.locator('#inventory-results-table thead button[title="Diff de Inventario"]');
  await sort.click(); await sort.click();
  const expectedHeaders = ['Jerarquía','Código','Producto','Unidad','Costo Unitario','Inventario Final Teórico','Inventario Físico','Diff de inventario','Costo Total','Valor Inventario Final Teórico','Valor Inventario Final Físico'];
  async function exportRows() {
    const promise = page.waitForEvent('download');
    await page.locator('#inventory-kardex-reduced-xlsx').click();
    const download = await promise;
    assert.match(download.suggestedFilename(),/kardex-resumido.*\.xlsx$/);
    const workbook = XLSX.readFile(await download.path());
    assert.deepEqual(workbook.SheetNames,['Kardex resumido']);
    return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1,defval:''});
  }
  const rows = await exportRows();
  assert.deepEqual(rows[0],expectedHeaders);
  assert.deepEqual(rows.slice(1,3).map(row=>row[1]),['B','A']);
  assert.deepEqual(rows[2].slice(4),[100,2,1,-1,-100,200,100]);
  assert.deepEqual(rows.at(-1).slice(-3),[200,400,600]);
  await page.evaluate(() => { window.print = () => { window.printedReducedReport = document.documentElement.outerHTML; }; });
  await page.locator('#inventory-kardex-reduced-pdf').click();
  assert.equal(await page.locator('#inventory-report-results').evaluate(dialog=>dialog.open),true);
  assert.equal(await page.locator('#inventory-kardex-reduced-report').count(),0);
  const printed = await page.evaluate(()=>window.printedReducedReport);
  const pdfPage = await browser.newPage();
  await pdfPage.setContent(printed.replace('<head>', `<head><base href="http://127.0.0.1:${server.address().port}/">`));
  await pdfPage.emulateMedia({media:'print'});
  assert.deepEqual(await pdfPage.locator('#inventory-kardex-reduced-report thead th').allTextContents(),expectedHeaders);
  assert.deepEqual(await pdfPage.locator('#inventory-kardex-reduced-report tbody tr td:nth-child(2)').allTextContents(),['B','A']);
  assert.deepEqual((await pdfPage.locator('#inventory-kardex-reduced-report tfoot td').allTextContents()).slice(-3),['$200','$400','$600']);
  const pdf = await pdfPage.pdf({format:'A4',landscape:true});
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  await page.locator('#clear-inventory-kardex-filters').click();
  const allRows = await exportRows();
  assert.equal(allRows.find(row=>row[1]==='C')[6],'Sin toma física');
  assert.equal(allRows.find(row=>row[1]==='C')[8],'No comparable');
  assert.equal(allRows.find(row=>row[1]==='D')[4],'Sin costo');
  assert.deepEqual(allRows.at(-1).slice(-3),[200,600,600]);
});
