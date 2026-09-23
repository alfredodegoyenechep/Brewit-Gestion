const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { readDirectMasters, legacyItems, connectionPath } = require('../toteat-direct-masters');
const local = '0123456789abcdef01234567';
const product = {id:'p1',custom_id:'BOL008',local,types:['PRODUCT'],status:'ACTIVE',base_unit:'UN',cost:1082.5,price:2500,stock_enabled:true,name:{translations:{default:'Galleta'}},hierarchies:[{custom_id:'AB.1'}],conversions:[{base_unit:'UN',conversion_unit:'CAJ',numerator:36,denominator:1}],recipe:{quantity:1,portions_per_unit:1,ingredients:[]}};
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'direct-master-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=connectionPath(root);fs.mkdirSync(path.dirname(file),{recursive:true});
  const requests={products:{headers:{authorization:'private-test-credential'}}};
  for(const[k,m]of[['products','5100'],['ingredients','5115'],['extras','5110']])requests[k+'Hierarchy']={url:`https://api.toteat.com/resto/setupconfig?xir=1&xil=2&xmod=${m}`,headers:{}};
  fs.writeFileSync(file,JSON.stringify({restaurantId:'1',localId:'2',localRef:local,requests}));return root;
}
function respond(url) {
  const u=new URL(url);return {ok:true,status:200,json:async()=>u.pathname==='/resto/setupconfig'?{ok:true,data:[{listado:[['AB.1',1,'Prueba','',1]]}]}:{results:u.pathname.endsWith('/products/')?[product]:[]}};
}
test('reads complete masters with GET only and preserves costs, recipes and package conversions',async t=>{
  const root=fixture(t),calls=[];const result=await readDirectMasters(root,{restaurantId:'1',localId:'2'},{fetchImpl:async(u,o)=>{calls.push(u.pathname);assert.equal(o.method,'GET');assert.equal(o.redirect,'error');return respond(u)}});
  assert.equal(calls.length,6);assert.equal(result.source,'toteat-internal-direct-api');assert.equal(result.items[0].det.ce,1082.5);assert.equal(result.items[0].det.conv[0].cnum,36);assert.deepEqual(result.products[0].recipe,product.recipe);
});
test('rejects expired authentication without leaking credential or publishing partial data',async t=>{
  const root=fixture(t);await assert.rejects(readDirectMasters(root,{restaurantId:'1',localId:'2'},{fetchImpl:async()=>({ok:false,status:401})}),e=>!!e.safeMasterMessage&&!e.message.includes('private-test-credential'));
});
test('rejects wrong locations and paginated incomplete masters',async t=>{
  const root=fixture(t);await assert.rejects(readDirectMasters(root,{restaurantId:'3',localId:'2'}),/no corresponde/);
  await assert.rejects(readDirectMasters(root,{restaurantId:'1',localId:'2'},{fetchImpl:async()=>({ok:true,status:200,json:async()=>({results:[product],next:'next-page'})})}),/incompletos/);
  await assert.rejects(readDirectMasters(root,{restaurantId:'1',localId:'2'},{fetchImpl:async()=>({ok:true,status:200,json:async()=>({results:[{...product,local:'different'}]})})}),/otro local/);
});
test('does not invent a positive conversion for a zero factor present in Toteat',()=>{
  const item=legacyItems([{...product,conversions:[{base_unit:'UN',conversion_unit:'UN',numerator:0,denominator:1}]}])[0];assert.equal(item.det.conv[0].cnum,0);
});
