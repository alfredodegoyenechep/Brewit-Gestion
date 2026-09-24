const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {database}=require('../operations/database');
const {service}=require('../operations/service');
const {convert,validateItem,explode}=require('../operations/domain');
const {authentication,totp}=require('../operations/auth');
const {baseline}=require('../operations/migration');
const url=process.env.BREWIT_TEST_DATABASE_URL;
test('conversiones exactas y errores explícitos',()=>{
  const item=validateItem({code:'BOL008',name:'Galleta',policy:'stock',bar:'other',baseUnit:'UN',conversions:[{unit:'CAJ',numerator:'36',denominator:'1'}]});
  assert.equal(convert(item,'1','CAJ').toString(),'36');
  assert.equal(convert({...item,baseUnit:'KG'},'250','G').toString(),'0.25');
  assert.throws(()=>convert(item,'1','L'),/Falta conversión/);
  assert.throws(()=>validateItem({...item,conversions:[{unit:'CAJ',numerator:0,denominator:1}]}),/mayor que cero/);
});
test('recetas: sustitución y preparado no explotan dos veces',async()=>{
  const data={MILK:{code:'MILK',baseUnit:'L',policy:'stock',active:true,conversions:[]},OAT:{code:'OAT',baseUnit:'L',policy:'stock',active:true,conversions:[]},DRINK:{code:'DRINK',baseUnit:'UN',policy:'recipe',active:true,conversions:[],recipe:{yield:'1',lines:[{code:'MILK',quantity:'200',unit:'ML'}]}}};
  const resolve=async code=>({version:1,body:data[code]});
  let rows=await explode(resolve,'DRINK','2','UN',{substitutions:[{removeCode:'MILK',removeQuantity:'400',removeUnit:'ML',addCode:'OAT',addQuantity:'400',addUnit:'ML'}]});
  assert.equal(rows.length,1);assert.equal(rows[0].item.body.code,'OAT');assert.equal(rows[0].quantity.toString(),'0.4');
  data.DRINK.policy='prepared';rows=await explode(resolve,'DRINK','2','UN');assert.equal(rows[0].item.body.code,'DRINK');
});
test('línea base no considera válida una conversión cero',()=>{
  const r=baseline({products:[{code:'X',name:'X',stockManaged:true,stockUnit:'UN',conversions:[{conversion_unit:'CAJ',numerator:0,denominator:1}]}]});
  assert.equal(r.cutover.ready,false);assert.match(r.issues[0].message,/Conversión inválida/);
});
test('operación PostgreSQL: documentos, costos, permisos y autenticación',{skip:!url},async t=>{
  assert.match(new URL(url).pathname,/_test$/,'Usar exclusivamente una base cuyo nombre termine en _test.');
  const db=database(url),svc=service(db);
  const maker={id:crypto.randomUUID(),email:'operator@test.local',name:'Operador',role:'operator',active:true,locations:['store-1','store-2','main-warehouse']};
  const approver={id:crypto.randomUUID(),email:'director@test.local',name:'Director',role:'director',active:true,locations:maker.locations};
  const at='2026-01-01T12:00:00Z';
  async function reset(){
    await db.pool.query('TRUNCATE brewit.master_import_rows,brewit.master_imports,brewit.sessions,brewit.login_attempts,brewit.audit,brewit.issues,brewit.payables,brewit.movements,brewit.balances,brewit.lots,brewit.documents,brewit.item_versions,brewit.items,brewit.suppliers,brewit.warehouses,brewit.users CASCADE');
    for(const u of [maker,approver])await db.pool.query('INSERT INTO brewit.users(id,email,name,password_hash,role,locations) VALUES($1,$2,$3,$4,$5,$6)',[u.id,u.email,u.name,'test-only',u.role,JSON.stringify(u.locations)]);
    await svc.saveWarehouse(approver,{id:'central',name:'Central',location:'main-warehouse',kind:'operating'});
    await svc.saveWarehouse(approver,{id:'cafe',name:'Cafetería',location:'store-1',kind:'operating'});
    await svc.saveItem(approver,{code:'BOL008',name:'Galleta',baseUnit:'UN',policy:'stock',bar:'other',effectiveAt:at,conversions:[{unit:'CAJ',numerator:'36',denominator:'1'}]});
  }
  async function post(kind,body,location='main-warehouse',effectiveAt='2026-01-02T12:00:00Z'){
    const d=await svc.createDocument(maker,{kind,body,location,effectiveAt},crypto.randomUUID());await svc.submit(maker,d.id);return svc.publish(approver,d.id);
  }
  try{
    await db.migrate();await db.migrate();
    await t.test('revisión de maestros: borrador, publicación atómica, permisos, conflictos y originales',async()=>{
      await reset();
      const {importShared,importedRows}=require('../operations/master-import');
      const {reviewImport}=require('../operations/import-review');
      await importShared(db,{observedAt:at,products:[{code:'NEW',name:'Nuevo ingrediente',active:true,stockManaged:true,stockUnit:'UN',conversions:[]},{code:'DRINK',name:'Bebida',stockManaged:false,stockUnit:'UN',recipe:{quantity:1,quantity_unit:'UN',portions_per_unit:1,ingredients:[{custom_id:'NEW',name:'Nuevo',quantity:1,quantity_unit:'UN',yield_rate:100}]}}],suppliers:[{code:'SUP',name:'Proveedor'}],warehouses:[{code:'W',name:'Bodega'}],hierarchies:{products:[{code:'H',name:'Jerarquía'}]}});
      let rows=(await importedRows(db)).rows;
      const ingredient=rows.find(r=>r.code==='NEW'),drink=rows.find(r=>r.code==='DRINK'&&r.kind==='item');
      const stock={code:'NEW',name:'Revisado',baseUnit:'UN',policy:'stock',bar:'other',conversions:[{unit:'CAJ',numerator:36,denominator:1}]};
      const beverage={code:'DRINK',name:'Bebida',baseUnit:'UN',policy:'recipe',bar:'hot',conversions:[],recipe:{yield:'1',lines:[{code:'NEW',quantity:'2',unit:'UN'}]}};
      const review=(row,proposal,revision=0,publish=true)=>reviewImport(db,approver,row.id,{proposal,revision,publish,reason:'Revisión completa del maestro'});
      await assert.rejects(()=>reviewImport(db,maker,ingredient.id,{proposal:stock,revision:0,reason:'Revisión completa',publish:true}),/permiso/);
      await assert.rejects(()=>review(drink,beverage),/sin versión vigente/);
      assert.equal((await db.pool.query("SELECT count(*) FROM brewit.items WHERE code='DRINK'")).rows[0].count,'0');
      const saved=await review(ingredient,stock,0,false);assert.equal(saved.revision,1);assert.equal(saved.status,'pending');
      await assert.rejects(()=>review(ingredient,stock),/Otra persona/);
      const results=await Promise.allSettled([review(ingredient,stock,1),review(ingredient,stock,1)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      await review(drink,beverage);
      rows=(await importedRows(db)).rows;assert.equal(rows.find(r=>r.kind==='recipe').status,'accepted');assert.equal(rows.find(r=>r.code==='NEW').original.name,'Nuevo ingrediente');
      await assert.rejects(()=>db.pool.query("UPDATE brewit.master_import_rows SET original='{}' WHERE id=$1",[ingredient.id]),/immutable/);
      for(const row of rows.filter(r=>['supplier','warehouse','hierarchy-products'].includes(r.kind))){
        const b=row.kind==='warehouse'?{id:'imported',name:'Bodega revisada',location:'store-2',kind:'operating'}:{code:row.code,name:'Nombre revisado'};await review(row,b);
      }
      assert.equal((await svc.list(approver,'movements')).length,0);
      assert.equal((await db.pool.query("SELECT count(*) FROM brewit.audit WHERE action='masters.review.publish'")).rows[0].count,'5');
    });
    await t.test('caja/unidad; promedio separado de último costo; idempotencia concurrente',async()=>{
      await reset();
      await post('receipt',{warehouse:'central',lines:[{code:'BOL008',quantity:'1',unit:'CAJ',unitCost:'38960'}]});
      const d=await svc.createDocument(maker,{kind:'receipt',location:'main-warehouse',effectiveAt:'2026-01-03T12:00:00Z',body:{warehouse:'central',lines:[{code:'BOL008',quantity:'36',unit:'UN',unitCost:'1082.5'}]}},'unique-receipt-1');
      await svc.submit(maker,d.id);await Promise.all([svc.publish(approver,d.id),svc.publish(approver,d.id)]);
      const b=(await svc.list(approver,'balances'))[0];
      assert.equal(b.quantity,'72.00000000');assert.equal(b.value,'77930.00000000');assert.equal(b.last_purchase_cost,'1082.50000000');assert.equal(b.average_cost,'1082.36111111');
      assert.equal((await svc.list(approver,'movements')).length,2);
    });
    await t.test('fallo de segunda línea revierte toda la publicación',async()=>{
      await reset();await assert.rejects(()=>post('receipt',{warehouse:'central',lines:[{code:'BOL008',quantity:'1',unit:'CAJ',unitCost:'38960'},{code:'UNKNOWN',quantity:'1',unit:'UN',unitCost:'1'}]}),/inexistente/);
      assert.equal((await svc.list(approver,'balances')).length,0);assert.equal((await svc.list(approver,'movements')).length,0);
    });
    await t.test('transferencia parcial conserva valor y stock en tránsito',async()=>{
      await reset();await post('receipt',{warehouse:'central',lines:[{code:'BOL008',quantity:'1',unit:'CAJ',unitCost:'36000'}]});
      const d=await post('transfer_dispatch',{warehouse:'central',destinationWarehouse:'cafe',lines:[{code:'BOL008',quantity:'10',unit:'UN'}]});
      await post('transfer_receive',{warehouse:'cafe',dispatchId:d.id,lines:[{code:'BOL008',quantity:'6',unit:'UN'}]},'store-1');
      const balances=await svc.list(approver,'balances');assert.equal(balances.find(b=>b.warehouse==='cafe').quantity,'6.00000000');assert.equal(balances.find(b=>b.kind==='transit').quantity,'4.00000000');
      assert.equal(balances.reduce((s,b)=>s+Number(b.value),0),36000);
      await assert.rejects(()=>post('transfer_receive',{warehouse:'cafe',dispatchId:d.id,lines:[{code:'BOL008',quantity:'5',unit:'UN'}]},'store-1'),/insuficiente/);
    });
    await t.test('factura y pago no aumentan stock y rechazan sobrepago',async()=>{
      await reset();const s=await svc.saveSupplier(approver,{code:'SUP',name:'Proveedor'});
      const inv=await post('invoice',{supplierId:s.id,documentType:'invoice',number:'100',dueOn:'2026-02-01',lines:[{total:'1000'}]});
      await post('payment',{reference:'Transferencia 1',lines:[{invoiceId:inv.id,total:'400'}]});
      assert.equal((await svc.list(approver,'payables'))[0].paid,'400.00000000');assert.equal((await svc.list(approver,'movements')).length,0);
      await assert.rejects(()=>post('payment',{reference:'Transferencia 2',lines:[{invoiceId:inv.id,total:'700'}]}),/excede/);
    });
    await t.test('permisos por local y separación autor/aprobador',async()=>{
      await reset();const d=await svc.createDocument(approver,{kind:'opening',location:'main-warehouse',effectiveAt:at,body:{warehouse:'central',lines:[{code:'BOL008',quantity:'1',unit:'UN',unitCost:'1'}]}},'separation-1');
      await svc.submit(approver,d.id);await assert.rejects(()=>svc.publish(approver,d.id),/propio documento/);
      await assert.rejects(()=>svc.list({...maker,locations:['store-1']},'documents','main-warehouse'),/Ubicación no autorizada/);
      await assert.rejects(()=>svc.saveItem(maker,{}),/permiso/);
    });
    await t.test('consumo usa versión vigente; preparado no consume receta otra vez',async()=>{
      await reset();await svc.saveItem(approver,{code:'DRINK',name:'Preparado',baseUnit:'UN',policy:'prepared',bar:'hot',effectiveAt:at,recipe:{yield:'1',lines:[{code:'BOL008',quantity:'2',unit:'UN'}]}});
      await post('receipt',{warehouse:'central',lines:[{code:'BOL008',quantity:'10',unit:'UN',unitCost:'100'}]});
      await post('production',{warehouse:'central',lines:[{code:'BOL008',quantity:'4',unit:'UN'}],outputs:[{code:'DRINK',quantity:'2',unit:'UN',costShare:'1'}]});
      await post('consumption',{warehouse:'central',lines:[{code:'DRINK',quantity:'1',unit:'UN'}]});
      const b=await svc.list(approver,'balances');assert.equal(b.find(r=>r.code==='BOL008').quantity,'6.00000000');assert.equal(b.find(r=>r.code==='DRINK').value,'200.00000000');
    });
    await t.test('lotes vencidos y cantidades insuficientes no salen por transferencia',async()=>{
      await reset();await svc.saveItem(approver,{code:'MILK',name:'Leche',baseUnit:'L',policy:'stock',bar:'other',effectiveAt:at,lotRequired:true,expiryRequired:true});
      await post('receipt',{warehouse:'central',lines:[{code:'MILK',quantity:'10',unit:'L',unitCost:'1000',lot:'L1',expiresOn:'2026-01-01'}]});
      await assert.rejects(()=>post('transfer_dispatch',{warehouse:'central',destinationWarehouse:'cafe',lines:[{code:'MILK',quantity:'1',unit:'L',lot:'L1'}]}),/vencido/);
      assert.equal((await svc.list(approver,'balances'))[0].quantity,'10.00000000');
    });
    await t.test('2FA, sesiones revocables y códigos no reutilizables',async()=>{
      await reset();const auth=authentication(db,'ab'.repeat(32));
      const u=await auth.provision({email:'login@test.local',name:'Persona',password:'long-password-test',role:'admin',scopes:['store-1']});
      const code=totp(u.totpSecret,Math.floor(Date.now()/30000));
      await assert.rejects(()=>auth.login('login@test.local','incorrect','000000','127.0.0.1'),/Credenciales/);
      const session=await auth.login('login@test.local','long-password-test',code,'127.0.0.1');assert.equal((await auth.session(session.token)).user.id,u.user.id);
      await assert.rejects(()=>auth.login('login@test.local','long-password-test',code,'127.0.0.1'),/ya utilizado/);
      await auth.logout(session.token);assert.equal(await auth.session(session.token),null);
    });
    await t.test('invitaciones privadas: activación única, expiración y sin acceso previo',async()=>{
      await reset();const auth=authentication(db,'ef'.repeat(32));
      const r=await auth.invite({email:'invite@test.local',name:'Invitado',role:'admin'});
      assert.equal(r.user.active,false);const setup=await auth.beginEnrollment(r.token);assert.equal(setup.email,'invite@test.local');
      await assert.rejects(()=>auth.login(setup.email,'not-a-real-password','000000','local'),/Credenciales/);
      const stored=(await db.pool.query('SELECT token_hash FROM brewit.enrollments WHERE user_id=$1',[r.user.id])).rows[0];assert.notEqual(stored.token_hash,r.token);
      const step=Math.floor(Date.now()/30000);await auth.finishEnrollment(r.token,'user-chosen-password',totp(setup.secret,step));
      await assert.rejects(()=>auth.beginEnrollment(r.token),/inválido o vencido/);
      await assert.rejects(()=>auth.finishEnrollment(r.token,'another-password',totp(setup.secret,step)),/inválido o vencido/);
      const logged=await auth.login(setup.email,'user-chosen-password',totp(setup.secret,step+1),'local');assert.equal(logged.user.id,r.user.id);
      const expired=await auth.invite({email:'expired@test.local',name:'Vencido',role:'admin'});await db.pool.query("UPDATE brewit.enrollments SET expires_at=now()-interval '1 minute' WHERE user_id=$1",[expired.user.id]);
      await assert.rejects(()=>auth.beginEnrollment(expired.token),/inválido o vencido/);
    });
    await t.test('importación revisable conserva recetas y conversiones originales; no publica ni duplica',async()=>{
      await reset();const {importShared,importedRows}=require('../operations/master-import');
      const source={source:'toteat-internal-direct-api',observedAt:at,products:[{id:'source-1',code:'SUB014',name:'Preparado',stockManaged:true,stockUnit:'UN',conversions:[{conversion_unit:'KG',numerator:0,denominator:1}],recipe:{quantity:2,portions_per_unit:1,ingredients:[{custom_id:'SUB014',name:'Prueba',quantity:2,quantity_unit:'UN',yield_rate:100}]}}],suppliers:[{id:'supplier-original',name:'Sin código',code:null}],warehouses:[{id:'warehouse-original',code:1,name:'Principal'}],hierarchies:{products:[{code:'AB',name:'Productos'}]}};
      const r=await importShared(db,source),again=await importShared(db,source);assert.equal(r.id,again.id);assert.equal(again.reused,true);
      const saved=await importedRows(db);assert.equal(saved.rows.length,5);assert.equal(saved.rows.find(r=>r.kind==='item').original.conversions[0].numerator,0);assert.equal(saved.rows.find(r=>r.kind==='recipe').original.ingredients[0].quantity,2);
      assert.equal(saved.rows.find(r=>r.kind==='supplier').code,'supplier-original');assert.ok(saved.rows.find(r=>r.kind==='item').issues.length);assert.equal((await svc.list(approver,'items')).length,1);assert.equal((await svc.list(approver,'movements')).length,0);
      await assert.rejects(()=>importShared(db,{...source,products:[...source.products,...source.products]}),/repetido/);
    });
    await t.test('reverso conserva evidencia y restaura el saldo; SQL impide editar movimientos',async()=>{
      await reset();const doc=await post('receipt',{warehouse:'central',lines:[{code:'BOL008',quantity:'1',unit:'CAJ',unitCost:'36000'}]});
      await assert.rejects(()=>db.pool.query("UPDATE brewit.documents SET body='{}' WHERE id=$1",[doc.id]),/immutable/);
      await assert.rejects(()=>db.pool.query('DELETE FROM brewit.movements WHERE document_id=$1',[doc.id]),/Append-only/);
      const r=await svc.reverse(approver,doc.id,'Error de recepción');await svc.reverse(approver,doc.id,'Error de recepción');
      assert.equal((await svc.list(approver,'balances'))[0].quantity,'0.00000000');assert.equal((await svc.list(approver,'balances'))[0].value,'0.00000000');
      assert.equal((await svc.list(approver,'movements')).length,2);assert.equal((await svc.list(approver,'documents')).find(d=>d.id===doc.id).reversed_by,r.id);
    });
    await t.test('venta con faltante conserva cantidades y alerta; no inventa un lote',async()=>{
      await reset();await svc.saveItem(approver,{code:'LOT',name:'Con lote',baseUnit:'UN',policy:'stock',bar:'other',effectiveAt:at,lotRequired:true,expiryRequired:true});
      await post('sale',{warehouse:'central',source:'toteat',orderId:'order-1',lines:[{lineId:'line-1',code:'LOT',quantity:'2',unit:'UN'}]});
      const b=(await svc.list(approver,'balances'))[0];assert.equal(b.quantity,'-2.00000000');assert.equal(b.cost_pending,true);assert.equal(b.average_cost,null);
      assert.ok((await svc.list(approver,'issues')).some(i=>i.code==='pending-lot'));
      assert.equal((await svc.list(approver,'lots'))[0].lot,'');
      await assert.rejects(()=>post('sale',{warehouse:'central',source:'toteat',orderId:'order-1',lines:[{lineId:'line-1',code:'LOT',quantity:'2',unit:'UN'}]}),e=>e.code==='23505');
    });
    await t.test('toma con fecha anterior a movimientos y conteo duplicado se rechazan',async()=>{
      await reset();await post('receipt',{warehouse:'central',lines:[{code:'BOL008',quantity:'10',unit:'UN',unitCost:'100'}]},'main-warehouse','2026-01-05T12:00:00Z');
      await assert.rejects(()=>post('count',{warehouse:'central',lines:[{code:'BOL008',quantity:'5',unit:'UN'}]}),/movimiento posterior/);
      await assert.rejects(()=>post('count',{warehouse:'central',lines:[{code:'BOL008',quantity:'5',unit:'UN'},{code:'BOL008',quantity:'5',unit:'UN'}]},'main-warehouse','2026-01-05T12:00:00Z'),/repetido/);
    });
    await t.test('API exige sesión, CSRF y ámbito; navegador crea maestro y borrador',async()=>{
      await reset();const express=require('express'),{registerOperations}=require('../operations/routes');
      const key='cd'.repeat(32),auth=authentication(db,key),user=await auth.provision({email:'ui@test.local',name:'Directora',password:'ui-password-long',role:'director',scopes:maker.locations});
      const app=express();registerOperations(app,{db,authKey:key,protectLegacy:true});app.get('/api/private',(_req,res)=>res.json({ok:true}));
      const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
      let browser;
      try{
        assert.equal((await fetch(`${base}/api/v1/operations/data/items`)).status,401);
        const {chromium}=require('playwright-core');browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
        const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.goto(`${base}/operaciones`);await page.locator('#login-panel').waitFor({state:'visible'});
        await page.locator('#login [name=email]').fill('ui@test.local');await page.locator('#login [name=password]').fill('ui-password-long');await page.locator('#login [name=code]').fill(totp(user.totpSecret,Math.floor(Date.now()/30000)));
        await page.getByRole('button',{name:'Ingresar',exact:true}).click();await page.locator('#workspace').waitFor({state:'visible'});
        await page.locator('#new').click();await page.locator('#edit-form [name=code]').fill('UI001');await page.locator('#edit-form [name=name]').fill('Producto de prueba');
        await page.getByRole('button',{name:'Publicar versión'}).click();await page.locator('#editor').waitFor({state:'hidden'});
        assert.match(await page.locator('#content').textContent(),/UI001/);
        await page.locator('[data-tab=documents]').click();await page.locator('#new').click();await page.locator('#edit-form [name=location]').selectOption('main-warehouse');await page.locator('#edit-form [name=warehouse]').selectOption('central');
        await page.locator('#lines [data-field=code]').selectOption('BOL008');await page.locator('#lines [data-field=quantity]').fill('1');await page.locator('#lines [data-field=unit]').fill('CAJ');await page.locator('#lines [data-field=unitCost]').fill('38960');
        await page.getByRole('button',{name:'Guardar borrador'}).click();await page.locator('#editor').waitFor({state:'hidden'});assert.match(await page.locator('#content').textContent(),/draft/);
        await require('../operations/master-import').importShared(db,{observedAt:at,products:[{code:'UIIMPORT',name:'Artículo importado',active:true,stockManaged:true,stockUnit:'UN',conversions:[{conversion_unit:'CAJ',base_unit:'UN',numerator:36,denominator:1}]}],suppliers:[],warehouses:[]});
        await page.locator('[data-tab=imports]').click();await page.getByRole('button',{name:'Ver detalle',exact:true}).click();await page.locator('#review-import').click();
        await page.locator('#edit-form [name=bar]').selectOption('other');await page.locator('#edit-form [name=reviewReason]').fill('Conversión revisada de caja de 36');
        await page.getByRole('button',{name:'Aplicar revisión',exact:true}).click();await page.locator('#editor').waitFor({state:'hidden'});
        assert.equal((await db.pool.query("SELECT count(*) FROM brewit.items WHERE code='UIIMPORT'")).rows[0].count,'0');
        await page.getByRole('button',{name:'Ver detalle',exact:true}).click();await page.locator('#review-import').click();
        assert.equal(await page.locator('#conversions [data-field=numerator]').inputValue(),'36');
        await page.locator('#edit-form [name=reviewReason]').fill('Aprobación final de conversión y política');await page.locator('#edit-form [name=reviewAction]').selectOption('publish');
        await page.getByRole('button',{name:'Aplicar revisión',exact:true}).click();await page.locator('#editor').waitFor({state:'hidden'});assert.match(await page.locator('#content').textContent(),/Aprobado/);
        assert.equal((await db.pool.query("SELECT body FROM brewit.items WHERE code='UIIMPORT'")).rows[0].body.conversions[0].numerator,'36');
        const cookies=await page.context().cookies(),cookie=cookies.map(c=>`${c.name}=${c.value}`).join(';');
        assert.equal((await fetch(`${base}/api/v1/operations/suppliers`,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({code:'BLOCK',name:'Blocked'})})).status,403);
        assert.equal((await fetch(`${base}/api/private`,{headers:{cookie}})).status,200);
        assert.deepEqual(errors,[]);
        const invited=await auth.invite({email:'browser-enroll@test.local',name:'Activación navegador',role:'admin'});
        await page.context().clearCookies();await page.goto(`${base}/operaciones#activate=${invited.token}`);await page.locator('#activation-panel').waitFor({state:'visible'});
        assert.equal(new URL(page.url()).hash,'');const secret=await page.locator('#activation-secret').textContent();
        await page.locator('#activation-form [name=password]').fill('browser-new-password');await page.locator('#activation-form [name=confirmation]').fill('browser-new-password');await page.locator('#activation-form [name=code]').fill(totp(secret,Math.floor(Date.now()/30000)));
        await page.getByRole('button',{name:'Activar cuenta',exact:true}).click();await page.locator('#activation-panel').waitFor({state:'hidden'});assert.equal(await page.locator('#activation-secret').textContent(),'');assert.match(await page.locator('#message').textContent(),/Cuenta activada/);
      }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
    });
  }finally{await db.close();}
});
