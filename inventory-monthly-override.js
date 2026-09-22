function monthlyInventoryOverride(records, locationId, from, to, automatic) {
  const parts=[];
  for(let month=from.slice(0,7);month<=to.slice(0,7);) {
    const [year,m]=month.split('-').map(Number),days=new Date(Date.UTC(year,m,0)).getUTCDate();
    const start=from>month+'-01'?from:month+'-01',end=to<month+'-'+days?to:month+'-'+days;
    const record=records.find(r=>r.locationId===locationId&&r.month===month);
    const value=record?.values?.inventoryDifference;
    parts.push({month,from:start,to:end,days,coveredDays:Math.round((Date.parse(end)-Date.parse(start))/86400000)+1,manual:typeof value==='number'&&Number.isFinite(value),monthlyAmount:value});
    month=new Date(Date.UTC(year,m,1)).toISOString().slice(0,7);
  }
  if(!parts.some(p=>p.manual))return null;
  const detail=parts.map(p=>p.manual?{...p,amount:p.monthlyAmount*p.coveredDays/p.days,available:true,source:'manual-monthly'}:{...p,...automatic(p.from,p.to),source:'inventory-report'});
  return {amount:detail.reduce((n,p)=>n+(p.available?p.amount:0),0),available:detail.every(p=>p.available),source:'monthly-override',detail};
}
module.exports={monthlyInventoryOverride};
