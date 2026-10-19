const test=require('node:test'),assert=require('node:assert/strict');
const {presentation}=require('../historical-change-presentation');
const change={type:'modified',dataset:'local-transfers',id:'T1'};
const document=lines=>({id:'T1',det:{listas:[[],[],lines,lines]}});
const item=(code,name,quantity,cost=100)=>({pl:code,np:name,cant:quantity,costo:cost,unit_select:'KG',w:1});

test('transfer differences identify the affected ingredient, stage, quantities and costs without raw fields',()=>{
  const before=document([item('SSR008','Salsa chocolate',2,100),item('SSR013','Salsa limón',5)]);
  const after=document([item('SSR013','Salsa limón',5),item('SSR008','Salsa chocolate',4,150)]);
  const result=presentation(change,{before,after});
  assert.equal(result.rows.length,4);
  assert.equal(result.itemCount,1);
  assert.deepEqual(result.rows.map(r=>r.stage),['Despacho','Despacho','Recepción','Recepción']);
  const quantity=result.rows.find(r=>r.field==='Cantidad');
  assert.equal(quantity.itemName,'Salsa chocolate');assert.equal(quantity.code,'SSR008');
  assert.equal(quantity.before,'2 kg');assert.equal(quantity.after,'4 kg');assert.equal(quantity.difference,'+2 kg');
  const cost=result.rows.find(r=>r.field==='Costo unitario');
  assert.equal(cost.before,'$100');assert.equal(cost.after,'$150');assert.equal(cost.difference,'+$50');
  assert.ok(result.rows.every(r=>!r.field.includes('det.')&&!r.itemName.includes('{')));
});

test('the saved list-only comparison is readable and equivalent conversions in another order are explained',()=>{
  const old=item('CCB002','Chips Chocolate',1);old.conv=[{cden:1,cnum:16,umed:'BOLSA',umedb:'kg'},{cden:1,cnum:1,umed:'kg',umedb:'kg'}];
  const next={...old,conv:[...old.conv].reverse()};
  const result=presentation({...change,fields:[{field:'det.listas',before:[[old],[old],[old],[old]],after:[[next],[next],[next],[next]],beforePresent:true,afterPresent:true}]});
  assert.equal(result.rows.length,0);assert.equal(result.notices.length,1);
  assert.equal(result.notices[0].code,'CCB002');assert.equal(result.notices[0].itemName,'Chips Chocolate');
  assert.match(result.summary,/Solo cambió el orden/);
});

test('added and deleted articles are explicit, keep zero values and do not pair unrelated products',()=>{
  const result=presentation(change,{before:document([item('A','Anterior',2,0)]),after:document([item('B','Nuevo',3,0)])});
  assert.ok(result.rows.some(r=>r.code==='A'&&r.field==='Artículo eliminado'&&r.before==='2 kg'&&r.after==='Sin registro'));
  assert.ok(result.rows.some(r=>r.code==='B'&&r.field==='Artículo agregado'&&r.before==='Sin registro'&&r.after==='3 kg'));
  assert.ok(result.rows.some(r=>r.code==='B'&&r.field==='Costo unitario'&&r.after==='$0'));
});

test('unit changes keep each version unit and suppress a misleading quantity delta',()=>{
  const before=document([item('A','Leche',1)]),after=document([{...item('A','Leche',1000),unit_select:'G'}]);
  const result=presentation(change,{before,after});
  const quantity=result.rows.find(r=>r.field==='Cantidad');
  assert.equal(quantity.before,'1 kg');assert.equal(quantity.after,'1.000 g');assert.equal(quantity.difference,'—');
  assert.ok(result.rows.some(r=>r.field==='Unidad del movimiento'&&r.before==='kg'&&r.after==='g'));
});

test('master and purchase changes use original names and catalog labels for otherwise opaque references',()=>{
  const master=presentation({type:'modified',dataset:'master-catalog'},{before:{custom_id:'P1',name:{translations:{default:'Café'}},price:1500},after:{custom_id:'P1',name:{translations:{default:'Café grande'}},price:1700}});
  assert.equal(master.rows.find(r=>r.field==='Precio de venta').after,'$1.700');
  assert.ok(master.rows.some(r=>r.field==='Nombre'&&r.before==='Café'&&r.after==='Café grande'));
  const purchase=presentation({type:'modified',dataset:'purchases'},{before:{products:[{id:'line1',product_ref:'opaque',quantity:1,cost:100}]},after:{products:[{id:'line1',product_ref:'opaque',quantity:2,cost:120}]},catalog:[{id:'opaque',code:'LAC001',name:'Leche'}]});
  assert.equal(purchase.rows[0].itemName,'Leche');assert.equal(purchase.rows[0].code,'LAC001');
});

test('missing values, null, zero and removals remain distinct and duplicate line identities require review',()=>{
  const result=presentation({type:'modified',dataset:'purchases'},{before:{quantity:null,cost:0},after:{quantity:0}});
  assert.equal(result.rows.find(r=>r.field==='Cantidad').before,'Sin informar');
  assert.equal(result.rows.find(r=>r.field==='Cantidad').after,'0');
  assert.equal(result.rows.find(r=>r.field==='Costo unitario').after,'Sin registro');
  const ambiguous=presentation(change,{before:document([item('A','Artículo',1),item('A','Artículo',2)]),after:document([item('A','Artículo',3),item('A','Artículo',2)])});
  assert.equal(ambiguous.rows.length,0);assert.match(ambiguous.warnings[0],/repetidos/);
});

test('administrative fields do not masquerade as price or quantity changes and arbitrary HTML stays plain data',()=>{
  const result=presentation(change,{before:{id:'x',updated_at:'2026-10-18',name:'Anterior'},after:{id:'x',updated_at:'2026-10-19',name:'<img src=x onerror=alert(1)>'}});
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].field,'Nombre');assert.equal(result.administrativeCount,1);
  assert.equal(result.rows[0].after,'<img src=x onerror=alert(1)>');
});
