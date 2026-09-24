const express=require('express');
const path=require('node:path');
const {database}=require('./database');
const {service,access}=require('./service');
const {authentication}=require('./auth');
const {baseline}=require('./migration');
const {importedRows}=require('./master-import');
const {reviewImport}=require('./import-review');
const {DomainError,check}=require('./domain');
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
function registerOperations(app,{connectionString,authKey,db:providedDb,masters=()=>null,protectLegacy=false}={}) {
  app.get('/operaciones',(req,res)=>res.sendFile(path.join(__dirname,'view.html')));
  app.get('/operations-view.js',(req,res)=>res.sendFile(path.join(__dirname,'view.js')));
  const router=express.Router();router.use(express.json({limit:'1mb'}));router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  if(!connectionString && !providedDb){
    router.get('/status',(_req,res)=>res.json({configured:false,mode:'preparation',message:'Configura PostgreSQL y los usuarios para habilitar la operación de prueba.'}));
    router.use((_req,res)=>res.status(503).json({error:'La base operativa todavía no está configurada.'}));
    app.use('/api/v1/operations',router);
    if(protectLegacy)throw new Error('La protección de acceso requiere la base operativa.');return;
  }
  const db=providedDb || database(connectionString), auth=authentication(db,authKey),svc=service(db);
  app.locals.operations={db,service:svc};
  const cookie=req=>String(req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('brewit_session='))?.slice(15);
  function sameOrigin(req){
    if(req.headers.origin)check(req.headers.origin===`${req.protocol}://${req.get('host')}`,'Origen de solicitud no autorizado.',403);
    check(req.headers['sec-fetch-site']!=='cross-site','Solicitud de otro sitio no autorizada.',403);
  }
  const authenticated=wrap(async(req,res,next)=>{
    const session=await auth.session(cookie(req));check(session,'Inicia sesión para continuar.',401);
    req.actor=session.user;req.csrf=session.csrf;
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){sameOrigin(req);check(req.get('X-CSRF-Token')===session.csrf,'Sesión de formulario inválida; recarga la página.',403);}
    next();
  });
  router.get('/status',wrap(async(_req,res)=>{await db.pool.query('SELECT id FROM brewit.settings WHERE id=1');res.json({configured:true,mode:'preparation',productionCutover:false});}));
  router.post('/login',wrap(async(req,res)=>{
    sameOrigin(req); const r=await auth.login(req.body.email,req.body.password,req.body.code,req.ip);
    res.cookie('brewit_session',r.token,{httpOnly:true,sameSite:'strict',secure:req.secure,maxAge:8*3600000,path:'/'});
    res.json({user:r.user,csrf:r.csrf});
  }));
  router.post('/enrollment/start',wrap(async(req,res)=>{sameOrigin(req);res.json(await auth.beginEnrollment(req.body.token));}));
  router.post('/enrollment/finish',wrap(async(req,res)=>{sameOrigin(req);res.json(await auth.finishEnrollment(req.body.token,req.body.password,req.body.code));}));
  router.use(authenticated);
  router.get('/session',(req,res)=>res.json({user:req.actor,csrf:req.csrf}));
  router.post('/logout',wrap(async(req,res)=>{await auth.logout(cookie(req));res.clearCookie('brewit_session',{path:'/'});res.json({ok:true});}));
  router.get('/baseline',(req,res)=>{access(req.actor,null,['director','admin']);res.json(baseline(masters()));});
  router.get('/imports',wrap(async(req,res)=>{access(req.actor,null,['director','admin']);res.json(await importedRows(db));}));
  router.post('/imports/:id/review',wrap(async(req,res)=>res.json(await reviewImport(db,req.actor,req.params.id,req.body))));
  router.get('/data/:resource',wrap(async(req,res)=>res.json({rows:await svc.list(req.actor,req.params.resource,req.query.location)})));
  router.post('/items',wrap(async(req,res)=>res.status(201).json(await svc.saveItem(req.actor,req.body.item,req.body.version || 0))));
  router.post('/warehouses',wrap(async(req,res)=>res.status(201).json(await svc.saveWarehouse(req.actor,req.body))));
  router.post('/suppliers',wrap(async(req,res)=>res.status(201).json(await svc.saveSupplier(req.actor,req.body))));
  router.post('/documents',wrap(async(req,res)=>res.status(201).json(await svc.createDocument(req.actor,req.body,req.get('Idempotency-Key')))));
  router.post('/documents/:id/submit',wrap(async(req,res)=>res.json(await svc.submit(req.actor,req.params.id))));
  router.post('/documents/:id/post',wrap(async(req,res)=>res.json(await svc.publish(req.actor,req.params.id))));
  router.post('/documents/:id/reverse',wrap(async(req,res)=>res.json(await svc.reverse(req.actor,req.params.id,req.body.reason))));
  router.use((error,req,res,_next)=>{
    const conflict=['23505','23503'].includes(error.code);
    res.status(error instanceof DomainError?error.status:conflict?409:503).json({error:error instanceof DomainError?error.message:conflict?'Registro duplicado o referencia inválida.':'No se completó la operación. Revisa la conexión y las migraciones de PostgreSQL.'});
  });
  app.use('/api/v1/operations',router);
  if(protectLegacy){
    app.use(['/api','/uploads','/upload'],authenticated,(req,res,next)=>{
      // Legacy reports do not yet enforce location scopes. Do not pretend they do.
      if(req.actor.role!=='director')return res.status(403).json({error:'Las vistas históricas completas requieren Dirección durante la migración.'});
      next();
    });
  }
}
module.exports={registerOperations};
