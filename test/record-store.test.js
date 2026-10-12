const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),XLSX=require('xlsx');
const store=require('../record-store');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'brewit-record-store-'));store.registerRoot(root);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('migration preserves dates, cents, formulas, identifiers, sheets and formatted headers after deleting source',t=>{
 const root=setup(t),dir=path.join(root,'transactions/store-1');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'original.xlsx');
 const book=XLSX.utils.book_new();const sheet=XLSX.utils.aoa_to_sheet([['Fecha','Código','Monto','Comentario'],[new Date('2026-10-08T00:00:00Z'),'000123',1234.567,'Ingrid servir'],[null,'0',0,'']]);sheet.C2.z='0.00';XLSX.utils.book_append_sheet(book,sheet,'Ventas');XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Padre','Hijo'],['A','A.1']]),'Jerarquías');XLSX.writeFile(book,file);
 const before=XLSX.readFile(file,{cellDates:true});const meta=store.importFile(file);assert.match(meta.sourceHash,/^[a-f0-9]{64}$/);store.removeOriginal(file);assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(store.descriptorPath(file)),true);
 const after=store.readWorkbook(file,{cellDates:true});for(const name of book.SheetNames)assert.deepEqual(XLSX.utils.sheet_to_json(after.Sheets[name],{header:1,defval:null}),XLSX.utils.sheet_to_json(before.Sheets[name],{header:1,defval:null}));
 const exported=XLSX.read(store.exportData(file).bytes,{type:'buffer',cellDates:true});assert.deepEqual(XLSX.utils.sheet_to_json(exported.Sheets.Ventas),XLSX.utils.sheet_to_json(before.Sheets.Ventas));
 assert.equal(store.fs.existsSync(file),true);assert.doesNotThrow(()=>store.importFile(file));
});
test('identical sources share one compressed blob; corruption and changed original block deletion',t=>{
 const root=setup(t);const dir=path.join(root,'transactions/store-1');fs.mkdirSync(dir,{recursive:true});const a=path.join(dir,'a.xlsx'),b=path.join(dir,'b.xlsx');const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([{id:'1',quantity:0}]),'Data');XLSX.writeFile(wb,a);fs.copyFileSync(a,b);assert.equal(store.importFile(a).blob,store.importFile(b).blob);assert.equal(fs.readdirSync(path.join(root,'.records/blobs')).length,1);
 fs.appendFileSync(a,'changed');assert.throws(()=>store.removeOriginal(a),/cambió/);assert.ok(fs.existsSync(a));
 const meta=store.descriptor(b);fs.writeFileSync(path.join(root,'.records/blobs',meta.blob+'.json.gz'),'broken');assert.throws(()=>store.removeOriginal(b));assert.ok(fs.existsSync(b));
});
test('text recipes retain tab relationships and a failed import leaves no published descriptor',t=>{
 const root=setup(t),dir=path.join(root,'masters');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'recipes.txt');const contents='\uFEFFCodigo\tIngrediente\tCantidad\r\n001\tLEC001\t0.125\r\n';fs.writeFileSync(file,contents);store.importFile(file);store.removeOriginal(file);assert.equal(store.fs.readFileSync(file,'utf8'),contents);
 const invalid=path.join(dir,'bad.xlsx');fs.writeFileSync(invalid,Buffer.from([80,75,3,4,0,0,0,0]));assert.throws(()=>store.importFile(invalid));assert.ok(fs.existsSync(invalid));assert.equal(fs.existsSync(store.descriptorPath(invalid)),false);
});
test('generated workbook and promoted upload persist records instead of source bytes',t=>{
 const root=setup(t),file=path.join(root,'transactions/store-1/generated.xlsx');fs.mkdirSync(path.dirname(file),{recursive:true});const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet([{id:'001',amount:100}]),'Data');require('../record-workbooks').writeFile(book,file);assert.equal(fs.existsSync(file),false);assert.equal(store.readWorkbook(file).SheetNames[0],'Data');
 const staged=path.join(root,'staged.xlsx');XLSX.writeFile(book,staged);const target=path.join(root,'masters/promoted.xlsx');store.fs.renameSync(staged,target);assert.equal(fs.existsSync(staged),false);assert.equal(fs.existsSync(target),false);assert.ok(store.descriptor(target));
});

test('verification failure preserves an existing publication and removes its unpublished descriptor',t=>{
 const root=setup(t),target=path.join(root,'masters/current.xlsx'),source=path.join(root,'incoming.xlsx');fs.mkdirSync(path.dirname(target),{recursive:true});
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet([{id:'old'}]),'Data');store.saveWorkbook(target,book);const previous=store.descriptor(target);
 book.Sheets.Data.A2.v='new';XLSX.writeFile(book,source);
 t.mock.method(XLSX,'write',()=>{throw Error('simulated verification failure');});
 assert.throws(()=>store.importFile(source,target),/simulated verification failure/);
 assert.deepEqual(store.descriptor(target),previous);assert.ok(fs.existsSync(source));
 assert.deepEqual(fs.readdirSync(path.dirname(target)),['current.xlsx.records.json']);
});


test('CSV date display and typed cells survive import without keeping source bytes',t=>{
 const root=setup(t),file=path.join(root,'dates.csv');fs.writeFileSync(file,'Fecha\tProducto\tCantidad\n2026-08-05\tLeche\t2');
 const before=XLSX.readFile(file,{cellDates:true});store.importFile(file);store.removeOriginal(file);const after=store.readWorkbook(file,{cellDates:true});
 assert.deepEqual(XLSX.utils.sheet_to_json(after.Sheets[after.SheetNames[0]],{header:1,raw:false}),XLSX.utils.sheet_to_json(before.Sheets[before.SheetNames[0]],{header:1,raw:false}));
});

test('garbage collection preserves shared references and active readers',t=>{
 const root=setup(t);const used=store.put(root,{kind:'text',lines:['keep']}),orphan=store.put(root,{kind:'text',lines:['discard']});
 const file=path.join(root,'masters/test.txt.records.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({format:'brewit-records-v1',blob:used}));
 const release=require('../storage-retention').readLease(root);assert.equal(store.collectGarbage(root,{minimumAgeMs:0}).length,0);release();
 assert.deepEqual(store.collectGarbage(root,{minimumAgeMs:0}).map(r=>r.blob),[orphan]);assert.ok(fs.existsSync(path.join(root,'.records/blobs',used+'.json.gz')));
});
