const test = require('node:test'), assert = require('node:assert/strict');
const { buildItemDetail } = require('../inventory-item-detail');
test('item detail preserves distinct transfer lines, scope, count boundaries and original quantities', () => {
  const line = { id: 't:1', document: 't', source: 'transfers', column: 'transfer_warehouse_out', code: 'C', unit: 'KG', warehouse: 'w2', date: '2026-09-02', quantity: 1, originalQuantity: 1000, originalUnit: 'G', active: true };
  const finalCount = { ...line, id: 'count', document: 'c', source: 'counts', column: 'count', date: '2026-09-04', quantity: 0 };
  const operations = [line, { ...line, id: 't:2' }, { ...line, id: 't:in', column: 'transfer_warehouse_in', warehouse: 'w1' }, finalCount,
    { ...line, id: 'pending', document: 'p', date: '2026-09-03', active: false, status: 'CREATED' },
    { ...line, id: 'other-code', code: 'OTHER' }, { ...line, id: 'other-unit', unit: 'UN' }, { ...line, id: 'outside', date: '2026-09-05' }];
  const state = { sourceKind: 'native-documents', warehouses: [{id:'w1',custom_id:1,name:'Principal'}, {id:'w2',custom_id:2,name:'Cafetería'}],
    operationLines: operations, movements: [line, { ...line, id:'sale',document:'order1',source:'sales',column:'use',quantity:.2,estimated:true }],
    documents: [{key:'t',id:'TR-7',status:'APPROVED',createdAt:'2026-09-02T12:00:00Z',approvedAt:'2026-09-02T13:00:00Z',observation:'Traslado'}], daily: [], issues: [{code:'OTHER',message:'wrong'}, {code:'C',message:'check'}] };
  const report = {dateFrom:'2026-09-01',dateTo:'2026-09-03',selection:{finalDate:'2026-09-04'}};
  const detail = buildItemDetail(state,{type:'store',name:'La Concepción'},report,{code:'C',unit:'KG'});
  assert.equal(detail.movements.length,5);assert.equal(detail.documentsAvailable,true);
  const transfers=detail.movements.filter(m=>m.document==='TR-7');assert.equal(transfers.length,2);
  assert.ok(transfers.every(m=>m.origin==='Cafetería' && m.destination==='Principal' && m.effect===-1 && m.originalQuantity===1000 && m.originalUnit==='G' && m.approvedAt));
  assert.equal(detail.movements.find(m=>m.id==='count').quantity,0);assert.equal(detail.movements.find(m=>m.id==='count').effect,null);
  assert.equal(detail.movements.find(m=>m.id==='pending').effect,null);
  assert.equal(detail.movements.find(m=>m.id==='sale').effect,-.2);assert.deepEqual(detail.issues,['check']);
  assert.equal(buildItemDetail(null,{type:'store'},report,{code:'C',unit:'KG'}).documentsAvailable,false);
  const withConsumption=buildItemDetail(state,{type:'store'},report,{code:'C',unit:'KG'},{
    consumption:{marketing:{available:true,label:'Marketing',products:{products:[]},ingredients:{items:[{code:'C',unit:'G',dailyQuantities:[{date:'2026-09-02',quantity:200,source:'Marketing.xlsx',productCode:'LATTE',productName:'Latte'},{date:'2026-09-05',quantity:100}]}]}}},
    convertQuantity:quantity=>quantity/1000
  });
  assert.equal(withConsumption.consumptionMovements.length,1);assert.equal(withConsumption.consumptionMovements[0].quantity,.2);assert.equal(withConsumption.consumptionMovements[0].effect,-.2);assert.equal(withConsumption.consumptionMovements[0].product,'LATTE · Latte');
});
