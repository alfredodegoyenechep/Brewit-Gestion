// Read-only, paginated consultation of already synchronized/uploaded records.
function registerUploadRecords(app,{location,load,today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Santiago'}).format(new Date())}) {
 const fields=new Set(['sales','payment-details','mercadopago','marketing','employees','purchases','counts','transformations','transfers']);
 const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
 app.get('/api/uploads/records',(req,res)=>{
  try {
   const l=location(req.query.location),field=req.query.field;
   if(!l||!fields.has(field))return res.status(400).json({error:'Ubicación o tipo de datos inválido.'});
   if(l.type==='warehouse'&&!['purchases','counts','transformations','transfers'].includes(field))return res.status(400).json({error:'Estos datos no aplican a esta ubicación.'});
   const to=req.query.to||today(),from=req.query.from;
   if(!valid(from)||!valid(to)||from>to||Date.parse(to)-Date.parse(from)>366*86400000)return res.status(400).json({error:'Selecciona fechas válidas, en orden y con un máximo de un año.'});
   const page=Number(req.query.page||1);if(!Number.isInteger(page)||page<1)return res.status(400).json({error:'Página inválida.'});
   const result=load(l,field,from,to),rows=result.rows||[],size=100;
   const columns=[...new Set(rows.flatMap(r=>Object.keys(r)))];
   res.set('Cache-Control','no-store').json({...result,location:l.name,field,from,to,total:rows.length,page,pageSize:size,pages:Math.max(1,Math.ceil(rows.length/size)),columns,rows:rows.slice((page-1)*size,page*size)});
  }catch{res.status(400).json({error:'No se pudieron leer los registros de esta fuente. Se conservan los datos guardados.'});}
 });
}
module.exports={registerUploadRecords};
