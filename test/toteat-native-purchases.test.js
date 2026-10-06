const test = require('node:test');
const assert = require('node:assert/strict');
const {readNative} = require('../toteat-native');

function pageFixture({reject=false,paginated=false}={}) {
  const listeners=new Map(),calls=[];
  const response=(url,body,status=200)=>({url:()=>url,status:()=>status,ok:()=>status===200,json:async()=>body,
    request:()=>({allHeaders:async()=>({authorization:'test-session'})}),dispose:async()=>{}});
  const emit=(url,body)=>listeners.get('response')?.(response(url,body));
  const page={on:(event,callback)=>listeners.set(event,callback),off:event=>listeners.delete(event),
    goto:async url=>{
      if(url.endsWith('/list-kardex')){
        emit('https://api.toteat.com/locals/branch/products/',{results:[{id:'p',local:'branch',custom_id:'PAC003'}]});
        emit('https://api.toteat.com/locals/branch/warehouses/',{results:[{id:'central',custom_id:1}]});
        emit('https://inventory.toteat.com/kardex/',{});
      }
    },waitForFunction:async()=>{},waitForTimeout:async()=>{},
    evaluate:async()=>({restaurantId:'r',localId:'1',items:[{m_id:'p'}],hierarchies:{}}),
    context:()=>({request:{get:async href=>{
      const url=new URL(href);calls.push(url);
      assert.equal(url.pathname,'/purchases/');assert.equal(url.searchParams.get('source'),'web','the default response omits the receipt header');
      assert.equal(url.searchParams.get('local_ref'),'branch');
      if(reject)return response(href,{},403);
      return response(href,{results:[{id:url.searchParams.get('init_date'),warehouse_receive_ref:'central',purchase_detail:[]}],...(paginated?{next:'another-page'}:{})});
    }}})};
  return {page,calls,listeners};
}

test('native purchases read receipt headers with source=web in bounded date windows, without fetching Kardex balances',async()=>{
  const {page,calls,listeners}=pageFixture();
  const source=await readNative(page,{restaurantId:'r',localId:'1'},{from:'2026-09-01',to:'2026-09-30',includePurchases:true});
  assert.deepEqual(calls.map(url=>[url.searchParams.get('init_date'),url.searchParams.get('finish_date')]),[['2026-09-01','2026-09-15'],['2026-09-16','2026-09-30']]);
  assert.equal(source.operations.purchases.length,2);assert.equal(source.operations.purchases[0].warehouse_receive_ref,'central');
  assert.equal(source.daily,undefined);assert.equal(source.partitions,undefined);assert.equal(listeners.size,0);
  assert.ok(!JSON.stringify(source).includes('test-session'));
});

test('native purchases reject incomplete pages or rejected sessions instead of accepting partial headers',async()=>{
  for(const options of [{reject:true},{paginated:true}]){
    const {page,listeners}=pageFixture(options);
    await assert.rejects(readNative(page,{restaurantId:'r',localId:'1'},{from:'2026-09-01',to:'2026-09-30',includePurchases:true}),options.reject?/Inicia sesión/:/incompleta/);
    assert.equal(listeners.size,0);
  }
});
