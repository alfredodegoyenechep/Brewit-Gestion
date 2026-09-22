const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {registerUploadRecords}=require('../upload-records');
test('record query validates location, warehouse applicability and dates, and paginates without losing columns',async t=>{
 const app=express();let calls=0;registerUploadRecords(app,{location:id=>['store','warehouse'].includes(id)?{id,type:id,name:id}:null,load:()=>{calls++;return {rows:Array.from({length:205},(_,i)=>({Código:i,...(i===204?{Extra:'final'}:{})})),note:'API'};}});
 const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));t.after(()=>new Promise(r=>s.close(r)));const url=`http://127.0.0.1:${s.address().port}/api/uploads/records?`;
 for(const q of ['location=bad&field=sales','location=warehouse&field=sales','location=store&field=sales&from=2026-02-30&to=2026-03-01','location=store&field=bad','location=store&field=sales&from=2026-09-02&to=2026-09-01'])assert.equal((await fetch(url+q)).status,400);
 assert.equal(calls,0);const r=await fetch(url+'location=store&field=sales&from=2026-09-01&to=2026-09-22&page=3');const data=await r.json();assert.equal(data.total,205);assert.equal(data.rows.length,5);assert.equal(data.rows[0].Código,200);assert.ok(data.columns.includes('Extra'));assert.equal(r.headers.get('cache-control'),'no-store');
});
