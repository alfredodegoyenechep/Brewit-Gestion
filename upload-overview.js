const fs = require('node:fs');
const path = require('node:path');
const { atomicJson } = require('./toteat-sales');
const columns = [
  ['sales', 'Transacciones de venta'], ['payment-details', 'Detalle Pagos'],
  ['mercadopago', 'Transacciones MercadoPago'], ['marketing', 'Consumo de Marketing'],
  ['employees', 'Consumo de Colaboradores'], ['purchases', 'Compras'],
  ['counts', 'Tomas de Inventario'], ['transformations', 'Transformaciones'], ['transfers', 'Transferencias entre bodegas']
];
const masterLabels = [
  ['master-catalog', 'Productos / Ingredientes / Extras'], ['product-hierarchy', 'Jerarquía Productos'],
  ['ingredient-hierarchy', 'Jerarquía Ingredientes'], ['extras-hierarchy', 'Jerarquía Extras'],
  ['master-recipes', 'Recetas'], ['master-suppliers', 'Proveedores']
];
function registerUploadOverview(app, { locations, sales, masters, stock, files, masterFiles, uploadsRoot, enableSync = false, now = () => Date.now() }) {
  const settingsFile = uploadsRoot ? path.join(uploadsRoot, '.integrations/toteat-api/native-refresh.json') : null;
  let settings = settingsFile && fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  const persist = () => { if (settingsFile) atomicJson(settingsFile, settings); };
  // Preserve automatic refresh at the shortest supported interval for old settings.
  if (['masters','inventory'].some(key => settings[key]?.minutes === 5)) {
    for (const key of ['masters','inventory']) if (settings[key]?.minutes === 5) settings[key].minutes = 15;
    persist();
  }
  const schedule = () => Object.fromEntries(['masters','inventory'].map(key => [key, { minutes: settings[key]?.minutes || null, lastAttempt: settings[key]?.lastAttempt || null }]));
  app.put('/api/uploads/schedule', (req, res) => {
    const body=req.body || {};
    if (!['masters','inventory'].every(key => body[key] === null || [15,60,1440].includes(body[key]))) return res.status(400).json({error:'Selecciona Manual, 15 min, 1 hora o 24 horas para ambas fuentes.'});
    const previous=settings;
    settings=Object.fromEntries(['masters','inventory'].map(key=>[key,{minutes:body[key],lastAttempt:settings[key]?.minutes===body[key]?settings[key]?.lastAttempt:new Date(now()).toISOString()}]));
    try { persist(); res.json(schedule()); } catch { settings=previous;res.status(500).json({error:'No se pudo guardar la frecuencia.'}); }
  });
  const jobFile = uploadsRoot ? path.join(uploadsRoot, '.integrations/toteat-api/last-refresh.json') : null;
  let job = jobFile && fs.existsSync(jobFile) ? JSON.parse(fs.readFileSync(jobFile, 'utf8')) : { running: false, steps: [], finishedAt: null };
  const saveJob = () => { if(jobFile)atomicJson(jobFile,job); };
  if(job.running) {
    job.running=false;job.finishedAt=new Date(now()).toISOString();
    for(const step of job.steps)if(['pending','running'].includes(step.state))Object.assign(step,{state:'error',message:'Proceso interrumpido por reinicio. Vuelve a actualizar.',finishedAt:job.finishedAt});
    saveJob();
  }
  const publicJob = () => ({...job,summary:Object.fromEntries(['pending','running','complete','error','skipped'].map(state=>[state,job.steps.filter(step=>step.state===state).length]))});
  const active = () => locations().filter(l => l.status === 'active');
  const latest = records => [...records].sort((a,b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))[0];
  app.get('/api/uploads/overview', (req, res) => {
    try {
      const rows = active().map(location => {
        const central = location.id === 'main-warehouse', source = central ? 'store-1' : location.id;
        const store = location.type === 'store' || central;
        const sale = store ? sales.status(source) : null, purchase = store ? sales.purchases.status(source) : null;
        const inventory = store ? stock.status(source) : null;
        const cells = columns.map(([key]) => {
          if (location.type === 'warehouse' && !['purchases','counts','transformations','transfers'].includes(key)) return { key, applicable: false };
          let status, updatedAt, origin = 'Archivo cargado';
          if (['sales','payment-details'].includes(key)) { status=sale; updatedAt=sale?.lastSuccess; }
          if (key === 'purchases') { status=purchase; updatedAt=purchase?.lastSuccess; }
          if (['counts','transformations','transfers'].includes(key)) { status=inventory; updatedAt=inventory?.updatedAt; origin=inventory?.sourceKind==='public-inventory'?'Toteat API pública':'Toteat'; }
          if (updatedAt && origin === 'Archivo cargado') origin='Toteat API';
          if (!updatedAt && !['counts','transformations','transfers'].includes(key)) updatedAt=latest(files(source,key))?.savedAt;
          return { key, applicable: true, updatedAt: updatedAt || null, origin, sharedFrom:central?'La Concepción':null,
            running:!!status?.running, error:status?.lastError || status?.error || null };
        });
        return { id:location.id, name:location.name, cells,
          schedules:location.type==='store'?[{label:'Ventas y detalle de pagos',enabled:!!sale?.enabled,minutes:sale?.intervalMinutes},{label:'Compras',enabled:!!purchase?.enabled,minutes:purchase?.intervalMinutes}]:[] };
      });
      res.set('Cache-Control','no-store').json({ columns:columns.map(([key,label])=>({key,label})), rows, job:publicJob(), schedule:schedule(),
        masters:masterLabels.map(([key,label])=>{const record=latest(masterFiles(key));return {key,label,updatedAt:record?.savedAt || null};}),
        masterStatus: masters.sharedStatus() });
    } catch { res.status(500).json({error:'No se pudo consultar el estado de las cargas.'}); }
  });
  function refresh({ updateMasters=true, updateInventory=true, updateTransactions=true } = {}) {
    if(job.running)return;
    const plan=[];
    const add=(label,sources,method,execute,message=null)=>plan.push({step:{label,sources,method,state:message?'skipped':'pending',message,startedAt:null,finishedAt:null},execute});
    if(updateMasters)add('Maestros compartidos · La Concepción',masterLabels.map(([,label])=>label),require('./toteat-direct-masters').configured(uploadsRoot)?'API interna directa · autenticación autorizada':'Servicios internos · sesión web',()=>masters.synchronizeShared());
    const stores=active().filter(l=>l.type==='store');
    for(const location of stores) {
      const s=sales.status(location.id),p=sales.purchases.status(location.id);
      if(updateTransactions)for(const [label,sources,status,service] of [
        ['Ventas y pagos',['Transacciones de venta','Detalle Pagos'],s,sales],
        ['Compras',['Compras'],p,sales.purchases]
      ])add(`${location.name} · ${label}`,sources,'API pública · token',()=>service.synchronize(location.id),status.configured&&status.from?null:'Sin conexión o fecha inicial configurada.');
      if(updateInventory){
        const from=stock.status(location.id).range?.from || s.from;
        add(`${location.name} · Inventario${location.id==='store-1'?' (incluye Bodega Principal y mermas)':' (incluye mermas)'}`,
          ['Tomas de Inventario','Transformaciones','Transferencias entre bodegas'],'API pública · token',
          ()=>stock.synchronize(location.id,{from,to:new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Santiago'}).format(new Date())}),
          s.configured&&from?null:'Configura la conexión y el período inicial.');
      }
    }
    job={id:require('node:crypto').randomUUID(),trigger:updateTransactions?'manual':'scheduled',running:true,startedAt:new Date(now()).toISOString(),steps:plan.map(p=>p.step),finishedAt:null,
      excluded:['Transacciones MercadoPago','Consumo de Marketing','Consumo de Colaboradores']};
    saveJob();
    const mark = key => { settings[key]={...settings[key],lastAttempt:new Date(now()).toISOString()};persist(); };
    return (async()=>{
      if(updateMasters)mark('masters');if(updateInventory)mark('inventory');
      for(const {step,execute} of plan){
        if(step.state==='skipped')continue;
        Object.assign(step,{state:'running',startedAt:new Date(now()).toISOString()});saveJob();
        try { await execute();step.state='complete';step.message='Fuentes actualizadas y guardadas.'; }
        catch (error) {step.state='error';step.message=error.safeMasterMessage || (step.method.startsWith('API pública')
          ? 'No se completó la lectura. Revisa credenciales, permisos o límites de Toteat en Configuración. Se conserva la actualización anterior.'
          : 'No se completó la lectura o publicación. Revisa la sesión web de Toteat y la conexión del local. Se conserva la actualización anterior.');}
        step.finishedAt=new Date(now()).toISOString();saveJob();
      }
    })().catch(()=>{
      for(const step of job.steps)if(['pending','running'].includes(step.state))Object.assign(step,{state:'error',message:'No se pudo finalizar el proceso. Vuelve a actualizar.',finishedAt:new Date(now()).toISOString()});
    }).finally(()=>{job.running=false;job.finishedAt=new Date(now()).toISOString();saveJob();});
  }
  app.post('/api/uploads/refresh', (req,res)=>{
    try { const task=refresh();task?.catch(()=>{});res.status(202).json(publicJob()); }
    catch {res.status(500).json({error:'No se pudo iniciar o guardar el proceso de actualización.'});}
  });
  function tick() {
    if(job.running || masters.sharedStatus().running || active().some(l=>l.type==='store'&&stock.status(l.id).running))return;
    const due=key=>settings[key]?.minutes && now()-(Date.parse(settings[key].lastAttempt)||0)>=settings[key].minutes*60000;
    const updateMasters=!!due('masters'),updateInventory=!!due('inventory');
    if(updateMasters||updateInventory)return refresh({updateMasters,updateInventory,updateTransactions:false});
  }
  const timer=enableSync?setInterval(()=>{Promise.resolve().then(tick).catch(()=>{});},30000):null;
  timer?.unref();
  const control={tick,stop:()=>clearInterval(timer)};
  app.locals.uploadRefresh=control;
  return control;
}
module.exports={registerUploadOverview};
