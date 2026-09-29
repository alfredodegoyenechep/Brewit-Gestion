const fs = require('fs');
const root = 'uploads/.integrations/toteat-api';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const iso = value => String(value || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
const unit = value => String(value || '').trim().toUpperCase();
const near = (a,b) => Math.abs(a-b) < 0.00001;
const reports = [];
for (const location of fs.readdirSync(root + '/purchases').filter(name => name.startsWith('store-'))) {
  const pRoot = `${root}/purchases/${location}`, sRoot = `${root}/stock/${location}`;
  if (!fs.existsSync(pRoot+'/current.json') || !fs.existsSync(sRoot+'/current.json')) continue;
  const pv=read(pRoot+'/current.json').version, sv=read(sRoot+'/current.json').version;
  const purchases=read(`${pRoot}/${pv}/state.json`), stock=read(`${sRoot}/${sv}/state.json`);
  const original=read(`${sRoot}/${sv}/original.json`);
  const from = [purchases.from, stock.range.from].sort().at(-1), to=[purchases.through,stock.range.to].sort()[0];
  const groups=new Map();
  const group=(date,code,u)=> {const key=[date,code,unit(u)].join('|');if(!groups.has(key))groups.set(key,{date,code,unit:unit(u),purchases:{},inventory:{},documents:[]});return groups.get(key);};
  const mixed=[];let documents=0,lines=0;
  for(const d of purchases.documents) {
    const date=iso(d.received_date||d.recieived_date);if(!date||date<from||date>to)continue;
    documents++;
    if(new Set(d.products.map(p=>p.warehouse)).size>1)mixed.push({document:d.document_id,movement:d.movement_id,date,provider:d.provider,lines:d.products.map(p=>({code:p.sku,warehouse:p.warehouse,quantity:p.received_quantity,unit:p.received_measurement}))});
    for(const p of d.products){lines++; const g=group(date,p.sku,p.received_measurement);g.name=p.product;g.purchases[p.warehouse]=(g.purchases[p.warehouse]||0)+p.received_quantity;g.documents.push(d.document_id);}
  }
  // Read original API batches, independently of Brewit's normalized inventory.
  const originalRows=new Map();
  for(const batch of original.batches||[])for(const p of batch.data||[])for(const w of p.warehouses||[])for(const r of w.inventory||[]){const date=iso(r.date);if(date<from||date>to)continue;originalRows.set([date,p.sku,unit(p.unit),w.warehouse_id].join('|'),{date,code:p.sku,unit:p.unit,warehouse:w.warehouse_id,purchase:r.purchase||0});}
  for(const r of originalRows.values()) {if(!r.purchase)continue;const g=group(r.date,r.code,r.unit);g.inventory[r.warehouse]=(g.inventory[r.warehouse]||0)+r.purchase;}
  const mismatches=[],reassigned=[];
  for(const g of groups.values()) {
    const warehouses=new Set([...Object.keys(g.purchases),...Object.keys(g.inventory)]);
    if([...warehouses].every(w=>near(g.purchases[w]||0,g.inventory[w]||0)))continue;
    g.purchaseQuantity=Object.values(g.purchases).reduce((a,b)=>a+b,0);g.inventoryQuantity=Object.values(g.inventory).reduce((a,b)=>a+b,0);
    mismatches.push(g);if(near(g.purchaseQuantity,g.inventoryQuantity)&&g.purchaseQuantity!==0)reassigned.push(g);
  }
  reports.push({location,from,to,purchaseSnapshot:pv,inventorySnapshot:sv,purchaseUpdated:purchases.syncedAt,inventoryUpdated:stock.sourceCapturedAt,documents,lines,mixed,reassigned,mismatches,warehouses:stock.warehouses.map(w=>({id:w.custom_id,name:w.name}))});
}
fs.writeFileSync('tmp/warehouse-audit/results.json',JSON.stringify(reports,null,2));
for(const r of reports)console.log(JSON.stringify({location:r.location,from:r.from,to:r.to,documents:r.documents,lines:r.lines,mixed:r.mixed.length,reassigned:r.reassigned.length,mismatches:r.mismatches.length,examples:r.reassigned.slice(0,12)}));
