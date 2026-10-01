const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeLocalTransfers}=require('../toteat-local-transfers');
const products=[{custom_id:'MATCHA',stock_unit:'KG',name:{translations:{default:'Matcha'}}}];
const doc=()=>({key:123,st:30,fc:'2026-09-28',fre:'2026-09-29',fes:'',doc:[],det:{proveedor:{ir:'r',il:1},receptor:{ir:'r',il:2},fechas:['2026-09-28','2026-09-28','2026-09-28','2026-09-29'],listas:[[],[],[{plProv:'MATCHA',plRecep:'MATCHA',w:1,cant:1000,unit_select:'G'}],[{plProv:'MATCHA',plRecep:'MATCHA',w:2,cant:1,unit_select:'KG'}]]}});
const source=(localId='1',documents=[doc()])=>({restaurantId:'r',localId,range:{from:'2026-09-01',to:'2026-09-30'},warehouses:[{id:'central',custom_id:1},{id:'local',custom_id:2}],localTransfers:{documents}});
test('received transfer debits dispatch warehouse and credits receiving warehouse exactly once',()=>{
 const out=normalizeLocalTransfers(source(),products),incoming=normalizeLocalTransfers(source('2'),products);
 assert.equal(out.lines[0].column,'transfer_local_out');assert.equal(out.lines[0].warehouse,'central');assert.equal(out.lines[0].quantity,1);assert.equal(out.lines[0].date,'2026-09-29');
 assert.equal(incoming.lines[0].column,'transfer_local_in');assert.equal(incoming.lines[0].warehouse,'local');assert.equal(incoming.lines[0].quantity,1);
 assert.throws(()=>normalizeLocalTransfers(source('1',[doc(),doc()]),products),/única/);
});
test('pending and cancelled requests do not move stock; confirmed dispatch uses its own date',()=>{
 for(const st of [0,1,10,11,20,-1,-2,-3]){const d=doc();d.st=st;assert.equal(normalizeLocalTransfers(source('1',[d]),products).lines.length,0);}
 const d=doc();d.st=20;d.fes='2026-09-28';assert.equal(normalizeLocalTransfers(source('1',[d]),products).lines[0].date,'2026-09-28');assert.equal(normalizeLocalTransfers(source('2',[d]),products).lines.length,0);
 d.st=30;d.det.listas[3][0].cant=.8;assert.equal(normalizeLocalTransfers(source('2',[d]),products).lines[0].quantity,.8);
});
test('foreign locations, missing details, unknown warehouses and invalid quantities fail closed',()=>{
 assert.throws(()=>normalizeLocalTransfers(source('3'),products),/ajena/);
 for(const change of [d=>d.det.listas[2]=null,d=>d.det.listas[2][0].w=9,d=>d.det.listas[2][0].cant=-1,d=>d.fre=null,d=>d.st=99]){const d=doc();change(d);assert.throws(()=>normalizeLocalTransfers(source('1',[d]),products));}
 const s=source();delete s.localTransfers;assert.equal(normalizeLocalTransfers(s,products).issues[0].kind,'local-transfer-coverage');
});
test('document outside movement period is excluded and legitimate repeated product lines are preserved',()=>{
 const s=source();s.range.to='2026-09-28';assert.equal(normalizeLocalTransfers(s,products).lines.length,0);
 const d=doc();d.det.listas[2].push({...d.det.listas[2][0]});const result=normalizeLocalTransfers(source('1',[d]),products);assert.equal(result.lines.length,2);assert.notEqual(result.lines[0].id,result.lines[1].id);
});
