const crypto = require('node:crypto');
const { check, decimal, positive, amount, timestamp, date, convert, validateItem, explode } = require('./domain');
const id = () => crypto.randomUUID();
const digest = body => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const locations = ['store-1','store-2','main-warehouse'];
const kinds = ['opening','receipt','purchase_order','consumption','marketing','employees','waste','count','production','transfer_dispatch','transfer_receive','return','invoice','payment','sale'];
function access(actor, location, roles) {
  check(actor?.active && roles.includes(actor.role), 'No tienes permiso para esta operación.', 403);
  if (location) check(locations.includes(location) && (actor.role === 'director' || actor.locations.includes(location)), 'Ubicación no autorizada.', 403);
}
const writers = ['director','admin','manager','operator'];
const readers = [...writers,'viewer'];
const audit = (c, actor, action, entity, details = {}) => c.query('INSERT INTO brewit.audit(actor,action,entity,details) VALUES($1,$2,$3,$4)', [actor.id,action,entity,details]);

function service(db) {
  async function itemAt(c, code, at) {
    return (await c.query(`SELECT i.id,v.version,v.body FROM brewit.items i JOIN brewit.item_versions v ON v.item_id=i.id
      WHERE i.code=$1 AND v.effective_at<=$2 ORDER BY v.effective_at DESC,v.version DESC LIMIT 1`, [code,at])).rows[0];
  }
  async function warehouse(c, actor, key, { transit = false } = {}) {
    const w = (await c.query('SELECT * FROM brewit.warehouses WHERE id=$1 AND active', [key])).rows[0];
    check(w && (transit || w.kind !== 'transit'), 'Bodega inexistente o no operativa.');
    access(actor,w.location,readers); return w;
  }
  async function saveItem(actor, input, expectedVersion = 0) {
    access(actor,null,['director','admin']);
    const b = validateItem(input), at = timestamp(input.effectiveAt);
    check(Date.parse(at) <= Date.now(), 'Las versiones futuras todavía no pueden publicarse.');
    return db.transaction(async c => {
      const existing = (await c.query('SELECT * FROM brewit.items WHERE code=$1', [b.code])).rows[0];
      check((existing?.version || 0) === expectedVersion, 'El artículo fue modificado; recarga antes de guardar.',409);
      if (existing) {
        const last = (await c.query('SELECT max(effective_at) AS at FROM brewit.item_versions WHERE item_id=$1',[existing.id])).rows[0].at;
        check(new Date(at) > last, 'La nueva vigencia debe ser posterior a la versión anterior.');
        const used = (await c.query('SELECT 1 FROM brewit.movements WHERE item_id=$1 LIMIT 1',[existing.id])).rowCount;
        check(!used || existing.body.baseUnit === b.baseUnit, 'No se cambia la unidad base de un artículo con movimientos.');
      }
      const item = { id: existing?.id || id(), version: expectedVersion+1, body:b };
      if (b.recipe) {
        const resolve = async code => code === b.code ? item : itemAt(c,code,at);
        await explode(resolve,b.code,b.recipe.yield,b.baseUnit,{production:true});
      }
      await c.query(`INSERT INTO brewit.items(id,code,version,body) VALUES($1,$2,$3,$4)
        ON CONFLICT(code) DO UPDATE SET version=excluded.version,body=excluded.body,updated_at=now()`,[item.id,b.code,item.version,b]);
      await c.query('INSERT INTO brewit.item_versions VALUES($1,$2,$3,$4,$5)',[item.id,item.version,at,b,actor.id]);
      for(const [location,code] of Object.entries(b.externalCodes || {})) {
        await c.query('INSERT INTO brewit.external_codes(location,external_code,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[location,code,item.id]);
        const mapping=(await c.query('SELECT item_id FROM brewit.external_codes WHERE location=$1 AND external_code=$2',[location,code])).rows[0];
        check(mapping.item_id===item.id,`El código Toteat ${code} ya identifica otro artículo en ${location}.`,409);
      }
      await audit(c,actor,'item.version',item.id,{version:item.version,code:b.code}); return item;
    });
  }
  async function createDocument(actor, input, requestKey) {
    access(actor,input.location,writers);
    check(kinds.includes(input.kind), 'Tipo de documento inválido.');
    check(typeof requestKey === 'string' && requestKey.length >= 8 && requestKey.length <= 160, 'Falta clave de idempotencia.');
    const at = timestamp(input.effectiveAt);
    check(Date.parse(at) <= Date.now(), 'No publiques movimientos con fecha futura.');
    const body = JSON.parse(JSON.stringify(input.body || {})), hash = digest({ ...input, effectiveAt: at });
    check(Array.isArray(body.lines) && body.lines.length > 0 && body.lines.length <= 1000, 'El documento requiere de 1 a 1.000 líneas.');
    return db.transaction(async c => {
      const old = (await c.query('SELECT * FROM brewit.documents WHERE request_key=$1',[requestKey])).rows[0];
      if (old) { access(actor,old.location,readers); check(old.request_hash === hash,'La clave ya pertenece a otro contenido.',409); return old; }
      const doc = (await c.query(`INSERT INTO brewit.documents(id,kind,location,effective_at,status,body,created_by,request_key,request_hash)
        VALUES($1,$2,$3,$4,'draft',$5,$6,$7,$8) RETURNING *`,[id(),input.kind,input.location,at,body,actor.id,requestKey,hash])).rows[0];
      await audit(c,actor,'document.create',doc.id,{kind:doc.kind}); return doc;
    });
  }
  async function submit(actor, key) {
    return db.transaction(async c => {
      const d = (await c.query('SELECT * FROM brewit.documents WHERE id=$1',[key])).rows[0];
      check(d,'Documento inexistente.',404); access(actor,d.location,writers);
      check(d.created_by === actor.id || ['director','admin'].includes(actor.role),'Solo el autor o administración puede presentar el documento.',403);
      check(d.status === 'draft','El documento ya no está en borrador.',409);
      await c.query("UPDATE brewit.documents SET status='submitted',version=version+1 WHERE id=$1",[key]);
      await audit(c,actor,'document.submit',key); return {id:key,status:'submitted'};
    });
  }
  async function publish(actor, key) {
    return db.transaction(async c => {
      const doc = (await c.query('SELECT * FROM brewit.documents WHERE id=$1',[key])).rows[0];
      check(doc,'Documento inexistente.',404); access(actor,doc.location,['director','admin','manager']);
      if (doc.status === 'posted') return doc;
      check(doc.status === 'submitted','Presenta el documento antes de aprobarlo.',409);
      check(doc.created_by !== actor.id,'El autor no puede aprobar su propio documento.',403);
      if (['purchase_order','invoice','payment'].includes(doc.kind)) access(actor,doc.location,['director','admin']);
      const settings = (await c.query('SELECT * FROM brewit.settings WHERE id=1')).rows[0];
      check(!settings.closed_through || doc.effective_at > settings.closed_through,'El período está cerrado.');
      const body = doc.body, at = doc.effective_at.toISOString(), resolve = code => itemAt(c,code,at);
      if (!['invoice','payment','purchase_order'].includes(doc.kind)) {
        const origin = await warehouse(c,actor,body.warehouse);
        check(origin.location === doc.location,'La bodega principal del documento debe pertenecer a su ubicación.');
      }
      if (doc.kind === 'count') {
        const seen = new Set();
        for (const line of body.lines) { const key=JSON.stringify([line.code,line.lot || '']);check(!seen.has(key),'El conteo contiene un artículo/lote repetido.');seen.add(key); }
      }
      const posted = [];
      async function move(item, wh, quantity, cost, lot = '', metadata = {}, expiry = null) {
        const w = await warehouse(c,actor,wh,{transit:true});
        check(w.location === doc.location || ['transfer_dispatch','transfer_receive'].includes(doc.kind), 'La bodega no pertenece al local del documento.');
        const q = decimal(quantity); if (q.isZero()) return decimal(0);
        check(q.eq(decimal(amount(q.toString()))), 'La cantidad excede ocho decimales; ajusta la unidad base.');
        const last = (await c.query('SELECT max(effective_at) AS at FROM brewit.movements WHERE item_id=$1 AND warehouse=$2',[item.id,wh])).rows[0].at;
        check(!last || doc.effective_at >= last,'Existe un movimiento posterior. Requiere conciliación antes de registrar esta fecha.');
        check(!item.body.lotRequired || lot || (doc.kind === 'sale' && metadata.lotAssignment === 'pending'), `Falta lote de ${item.body.code}.`);
        check(typeof lot === 'string' && lot.length <= 120,'Lote inválido.');
        await c.query('INSERT INTO brewit.balances(warehouse,item_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[wh,item.id]);
        const balance = (await c.query('SELECT * FROM brewit.balances WHERE warehouse=$1 AND item_id=$2',[wh,item.id])).rows[0];
        let lotRow = (await c.query('SELECT * FROM brewit.lots WHERE warehouse=$1 AND item_id=$2 AND lot=$3',[wh,item.id,lot])).rows[0];
        if (q.gt(0)) {
          if (expiry) date(expiry);
          check(!item.body.expiryRequired || expiry || lotRow?.expires_on, `Falta vencimiento de ${item.body.code}.`);
          check(!lotRow?.expires_on || !expiry || new Date(lotRow.expires_on).toISOString().slice(0,10) === expiry,'El vencimiento del lote no coincide.');
          check(!lotRow || lotRow.status === 'available','El lote está bloqueado.');
          if (!lotRow) await c.query('INSERT INTO brewit.lots(warehouse,item_id,lot,expires_on) VALUES($1,$2,$3,$4)',[wh,item.id,lot,expiry]);
        } else {
          const sufficient = lotRow && decimal(lotRow.quantity).gte(q.abs()) && decimal(balance.quantity).gte(q.abs());
          if (!sufficient) {
            check(doc.kind === 'sale','Existencia insuficiente para este movimiento.');
            await c.query('INSERT INTO brewit.issues(document_id,code,details) VALUES($1,$2,$3)',[doc.id,'negative-stock',{code:item.body.code,warehouse:wh,lot}]);
            if (!lotRow) await c.query('INSERT INTO brewit.lots(warehouse,item_id,lot) VALUES($1,$2,$3)',[wh,item.id,lot]);
          }
          check(!lotRow || lotRow.status === 'available','El lote está bloqueado.');
          check(!lotRow?.expires_on || new Date(lotRow.expires_on).toISOString().slice(0,10) >= at.slice(0,10) || doc.kind === 'waste','El lote está vencido.');
        }
        const average = decimal(balance.quantity).gt(0) ? decimal(balance.value).div(balance.quantity) : null;
        let unitCost = cost == null ? average : decimal(cost);
        if (unitCost == null) {
          check(doc.kind === 'sale','Falta costo para valorizar el movimiento.'); unitCost = decimal(0);
          await c.query('INSERT INTO brewit.issues(document_id,code,details) VALUES($1,$2,$3)',[doc.id,'pending-cost',{code:item.body.code,warehouse:wh}]);
        }
        check(unitCost.gte(0),'Costo negativo inválido.');
        let value = q.mul(unitCost);
        if (q.lt(0) && q.abs().eq(balance.quantity) && cost == null) value = decimal(balance.value).neg();
        value = decimal(amount(value.toString()));
        const meta = {...metadata,baseUnit:item.body.baseUnit,costMethod:cost == null?'weighted-average':'document',provisional:body.provisionalCost === true};
        const movement = (await c.query(`INSERT INTO brewit.movements(document_id,item_id,warehouse,lot,quantity,value,effective_at,item_version,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[doc.id,item.id,wh,lot,amount(q.toString()),amount(value.toString()),at,item.version,meta])).rows[0];
        await c.query('UPDATE brewit.balances SET quantity=quantity+$3,value=value+$4 WHERE warehouse=$1 AND item_id=$2',[wh,item.id,q.toString(),value.toString()]);
        if (decimal(balance.quantity).add(q).lt(0) || decimal(balance.quantity).lt(0)) {
          await c.query('UPDATE brewit.balances SET cost_pending=true WHERE warehouse=$1 AND item_id=$2',[wh,item.id]);
        }
        await c.query('UPDATE brewit.lots SET quantity=quantity+$4 WHERE warehouse=$1 AND item_id=$2 AND lot=$3',[wh,item.id,lot,q.toString()]);
        if (doc.kind === 'receipt' && q.gt(0)) await c.query('UPDATE brewit.balances SET last_purchase_cost=$3,last_purchase_at=$4 WHERE warehouse=$1 AND item_id=$2',[wh,item.id,amount(unitCost.toString()),at]);
        posted.push(movement); return value;
      }
      async function consume(item, wh, quantity, requestedLot, metadata = {}) {
        let remaining = positive(quantity.toString()), total = decimal(0);
        if (requestedLot != null || !item.body.lotRequired) return move(item,wh,remaining.neg().toString(),null,requestedLot || '',metadata);
        const lots = (await c.query(`SELECT * FROM brewit.lots WHERE warehouse=$1 AND item_id=$2 AND quantity>0 AND status='available'
          AND (expires_on IS NULL OR expires_on >= $3::date) ORDER BY expires_on NULLS LAST,lot`,[wh,item.id,at.slice(0,10)])).rows;
        for (const lot of lots) {
          const q = remaining.lt(lot.quantity) ? remaining : decimal(lot.quantity);
          if (q.gt(0)) total = total.add(await move(item,wh,q.neg().toString(),null,lot.lot,{...metadata,lotAssignment:'automatic-fefo'}));
          remaining = remaining.sub(q); if (remaining.isZero()) break;
        }
        if (!remaining.isZero() && doc.kind === 'sale') {
          total = total.add(await move(item,wh,remaining.neg().toString(),null,'',{...metadata,lotAssignment:'pending'}));
          await c.query('INSERT INTO brewit.issues(document_id,code,details) VALUES($1,$2,$3)',[doc.id,'pending-lot',{code:item.body.code,warehouse:wh,quantity:remaining.toString()}]);
        } else check(remaining.isZero(),'No hay lotes disponibles suficientes; requiere asignación o conciliación.');
        return total;
      }
      if (doc.kind === 'invoice') {
        check(body.lines.length === 1,'La factura requiere una línea de total.');
        check(typeof body.number === 'string' && body.number.trim() && body.number.length <= 100,'Falta número de factura.');
        check(['invoice','receipt'].includes(body.documentType),'Tipo de comprobante inválido.');
        date(body.dueOn); positive(body.lines[0].total);
        const supplier = (await c.query('SELECT id FROM brewit.suppliers WHERE id=$1',[body.supplierId])).rows[0]; check(supplier,'Proveedor inexistente.');
        await c.query('INSERT INTO brewit.payables(id,supplier_id,document_type,number,due_on,total) VALUES($1,$2,$3,$4,$5,$6)',[doc.id,body.supplierId,body.documentType,body.number.trim(),body.dueOn,amount(body.lines[0].total)]);
      } else if (doc.kind === 'payment') {
        check(typeof body.reference === 'string' && body.reference.trim(),'Falta comprobante del pago realizado.');
        for (const line of body.lines) {
          const payable = (await c.query('SELECT p.*,d.location FROM brewit.payables p JOIN brewit.documents d ON d.id=p.id WHERE p.id=$1',[line.invoiceId])).rows[0];
          check(payable && payable.location === doc.location,'Factura inexistente o de otro local.');
          const paid = positive(line.total); check(decimal(payable.total).sub(payable.paid).gte(paid),'El pago excede el saldo pendiente.');
          await c.query('UPDATE brewit.payables SET paid=paid+$2 WHERE id=$1',[line.invoiceId,paid.toString()]);
        }
      } else if (doc.kind === 'transfer_receive') {
        const dispatch = (await c.query("SELECT * FROM brewit.documents WHERE id=$1 AND kind='transfer_dispatch' AND status='posted'",[body.dispatchId])).rows[0];
        check(dispatch && dispatch.body.destinationWarehouse === body.warehouse,'Despacho o destino inválido.');
        const target = await warehouse(c,actor,body.warehouse); check(target.location === doc.location,'Destino fuera del local.');
        for (const line of body.lines) {
          const item = await resolve(line.code); check(item,'Artículo inexistente.');
          const q = convert(item.body,positive(line.quantity).toString(),line.unit), transit = `transit:${dispatch.id}`;
          const cost = (await move(item,transit,q.neg().toString(),null,line.lot || '',{dispatchId:dispatch.id})).neg().div(q);
          const lot = (await c.query('SELECT expires_on FROM brewit.lots WHERE warehouse=$1 AND item_id=$2 AND lot=$3',[transit,item.id,line.lot || ''])).rows[0];
          await move(item,body.warehouse,q.toString(),cost.toString(),line.lot || '',{dispatchId:dispatch.id},lot?.expires_on ? new Date(lot.expires_on).toISOString().slice(0,10):null);
        }
      } else if (doc.kind === 'production') {
        let inputCost = decimal(0);
        for (const line of body.lines) {
          const item = await resolve(line.code); check(item,'Insumo inexistente.');
          check(['stock','prepared'].includes(item.body.policy),'La producción consume insumos almacenables.');
          inputCost = inputCost.sub(await consume(item,body.warehouse,convert(item.body,positive(line.quantity).toString(),line.unit),line.lot,{productionInput:true}));
        }
        check(Array.isArray(body.outputs) && body.outputs.length>0,'Faltan resultados de producción.');
        const shares = body.outputs.reduce((s,o)=>s.add(positive(o.costShare)),decimal(0)); check(shares.eq(1),'Las participaciones de costo deben sumar 1.');
        for (const output of body.outputs) {
          const item = await resolve(output.code); check(item && item.body.policy === 'prepared','El resultado debe ser un preparado.');
          const q = convert(item.body,positive(output.quantity).toString(),output.unit);
          await move(item,body.warehouse,q.toString(),inputCost.mul(output.costShare).div(q).toString(),output.lot || '',{productionOutput:true},output.expiresOn);
        }
      } else if (['consumption','marketing','employees','sale'].includes(doc.kind)) {
        if (doc.kind === 'sale') check(body.source === 'toteat' && typeof body.orderId === 'string' && body.orderId,'Falta identidad de venta Toteat.');
        const seen = new Set();
        for (const line of body.lines) {
          if (doc.kind === 'sale') { check(line.lineId && !seen.has(line.lineId),'Línea de venta repetida o sin identidad.'); seen.add(line.lineId); }
          const expanded = await explode(resolve,line.code,line.quantity,line.unit,{substitutions:line.substitutions || []});
          for (const r of expanded) await consume(r.item,body.warehouse,r.quantity,line.lot,{saleLine:line.lineId || null,recipeCode:line.code,recipeVersion:(await resolve(line.code)).version});
        }
      } else {
        let transit;
        if (doc.kind === 'transfer_dispatch') {
          const dest = await warehouse(c,actor,body.destinationWarehouse);
          check(body.warehouse !== body.destinationWarehouse,'Origen y destino deben ser distintos.');
          transit = `transit:${doc.id}`;
          await c.query("INSERT INTO brewit.warehouses(id,location,name,kind) VALUES($1,$2,$3,'transit')",[transit,dest.location,`En tránsito ${doc.id}`]);
        }
        for (const line of body.lines) {
          const item = await resolve(line.code); check(item && item.body.active,'Artículo inexistente o inactivo.');
          check(['stock','prepared'].includes(item.body.policy),'Este artículo no almacena existencias.');
          const quantity = doc.kind === 'count' ? decimal(line.quantity) : positive(line.quantity);
          check(quantity.gte(0),'El conteo no puede ser negativo.');
          const q = convert(item.body,quantity.toString(),line.unit);
          if (doc.kind === 'purchase_order') { positive(line.unitCost); continue; }
          if (['opening','receipt','return'].includes(doc.kind)) {
            const price = decimal(line.unitCost); check(price.gte(0),'Costo inválido.');
            if (doc.kind === 'opening') check(!(await c.query('SELECT 1 FROM brewit.movements WHERE warehouse=$1 AND item_id=$2 AND lot=$3',[body.warehouse,item.id,line.lot || ''])).rowCount,'Ya existen movimientos para esta apertura.');
            if (doc.kind === 'return') check(body.reason && body.originalDocumentId,'La devolución requiere causa y documento original.');
            await move(item,body.warehouse,q.toString(),price.div(convert(item.body,'1',line.unit)).toString(),line.lot || '',{},line.expiresOn);
          } else if (doc.kind === 'count') {
            const lot = (await c.query('SELECT quantity FROM brewit.lots WHERE warehouse=$1 AND item_id=$2 AND lot=$3',[body.warehouse,item.id,line.lot || ''])).rows[0];
            const diff = q.sub(lot?.quantity || '0');
            await move(item,body.warehouse,diff.toString(),diff.gt(0) && line.unitCost != null ? decimal(line.unitCost).div(convert(item.body,'1',line.unit)).toString():null,line.lot || '',{counted:q.toString(),reason:body.reason},line.expiresOn);
          } else if (['waste','transfer_dispatch'].includes(doc.kind)) {
            check(body.reason || doc.kind === 'transfer_dispatch','La merma requiere causa.');
            const before = posted.length;
            await consume(item,body.warehouse,q,line.lot,{reason:body.reason});
            if (transit) for (const movement of posted.slice(before)) {
              const expiry = (await c.query('SELECT expires_on FROM brewit.lots WHERE warehouse=$1 AND item_id=$2 AND lot=$3',[body.warehouse,item.id,movement.lot])).rows[0]?.expires_on;
              await move(item,transit,decimal(movement.quantity).neg().toString(),decimal(movement.value).div(movement.quantity).toString(),movement.lot,{dispatchId:doc.id},expiry?new Date(expiry).toISOString().slice(0,10):null);
            }
          }
        }
      }
      const result = (await c.query("UPDATE brewit.documents SET status='posted',posted_by=$2,posted_at=now(),version=version+1 WHERE id=$1 RETURNING *",[doc.id,actor.id])).rows[0];
      await audit(c,actor,'document.post',doc.id,{kind:doc.kind,movements:posted.length}); return result;
    });
  }
  async function list(actor, resource, location) {
    access(actor,location || null,readers);
    if(resource==='payables')access(actor,location || null,['director','admin','viewer']);
    const scope = actor.role === 'director' ? locations : actor.locations;
    const selected = location ? [location] : scope;
    if (resource === 'items') return (await db.pool.query('SELECT * FROM brewit.items ORDER BY code')).rows;
    if (resource === 'suppliers') return (await db.pool.query('SELECT * FROM brewit.suppliers ORDER BY code')).rows;
    if (resource === 'warehouses') return (await db.pool.query('SELECT * FROM brewit.warehouses WHERE location=ANY($1) ORDER BY id',[selected])).rows;
    if (resource === 'documents') return (await db.pool.query('SELECT * FROM brewit.documents WHERE location=ANY($1) ORDER BY created_at DESC',[selected])).rows;
    if (resource === 'balances') return (await db.pool.query(`SELECT b.*,i.code,i.body->>'name' AS name,i.body->>'baseUnit' AS unit,w.name AS warehouse_name,w.kind,
      CASE WHEN b.quantity>0 AND NOT b.cost_pending THEN round(b.value/b.quantity,8) ELSE NULL END AS average_cost
      FROM brewit.balances b JOIN brewit.items i ON i.id=b.item_id JOIN brewit.warehouses w ON w.id=b.warehouse WHERE w.location=ANY($1) ORDER BY w.id,i.code`,[selected])).rows;
    if (resource === 'lots') return (await db.pool.query('SELECT l.*,i.code FROM brewit.lots l JOIN brewit.warehouses w ON w.id=l.warehouse JOIN brewit.items i ON i.id=l.item_id WHERE w.location=ANY($1) ORDER BY l.expires_on NULLS LAST',[selected])).rows;
    if (resource === 'movements') return (await db.pool.query('SELECT m.*,i.code FROM brewit.movements m JOIN brewit.warehouses w ON w.id=m.warehouse JOIN brewit.items i ON i.id=m.item_id WHERE w.location=ANY($1) ORDER BY m.id DESC',[selected])).rows;
    if (resource === 'payables') return (await db.pool.query('SELECT p.*,s.code AS supplier FROM brewit.payables p JOIN brewit.documents d ON d.id=p.id JOIN brewit.suppliers s ON s.id=p.supplier_id WHERE d.location=ANY($1) ORDER BY due_on',[selected])).rows;
    if (resource === 'issues') return (await db.pool.query('SELECT i.* FROM brewit.issues i JOIN brewit.documents d ON d.id=i.document_id WHERE d.location=ANY($1) ORDER BY i.id DESC',[selected])).rows;
    check(false,'Recurso inexistente.',404);
  }
  async function saveWarehouse(actor,b) {
    access(actor,b.location,['director','admin']); check(/^[\w-]{1,80}$/.test(b.id) && typeof b.name === 'string' && b.name.trim(),'Bodega inválida.');
    check(['operating','waste'].includes(b.kind),'Tipo de bodega inválido.');
    return db.transaction(async c=> {await c.query('INSERT INTO brewit.warehouses(id,location,name,kind) VALUES($1,$2,$3,$4)',[b.id,b.location,b.name,b.kind]); await audit(c,actor,'warehouse.create',b.id);return b;});
  }
  async function saveSupplier(actor,b) {
    access(actor,null,['director','admin']);check(/^[\w.-]{1,64}$/.test(b.code) && typeof b.name === 'string' && b.name.trim(),'Proveedor inválido.');
    return db.transaction(async c=>{ const r=(await c.query('INSERT INTO brewit.suppliers(id,code,body) VALUES($1,$2,$3) RETURNING *',[id(),b.code,b])).rows[0]; await audit(c,actor,'supplier.create',r.id);return r; });
  }
  async function reverse(actor,key,reason) {
    check(typeof reason === 'string' && reason.trim().length>=5,'Explica el motivo del reverso.');
    return db.transaction(async c=>{
      const doc=(await c.query('SELECT * FROM brewit.documents WHERE id=$1',[key])).rows[0];
      check(doc,'Documento inexistente.',404);access(actor,doc.location,['director','admin']);
      if(doc.status==='reversed')return {id:doc.reversed_by,status:'posted'};
      check(doc.status==='posted','Solo se revierte un documento publicado.');
      check(doc.kind!=='reversal','Un reverso no se revierte nuevamente.');
      check(!['invoice','payment','transfer_dispatch','transfer_receive'].includes(doc.kind),'Este reverso necesita conciliar documentos vinculados; no se permite un reverso aislado.');
      const setting=(await c.query('SELECT closed_through FROM brewit.settings WHERE id=1')).rows[0];
      check(!setting.closed_through || doc.effective_at>setting.closed_through,'El documento pertenece a un período cerrado.');
      const movements=(await c.query('SELECT * FROM brewit.movements WHERE document_id=$1 ORDER BY id DESC',[key])).rows;
      for(const m of movements) {
        const later=await c.query('SELECT 1 FROM brewit.movements WHERE item_id=$1 AND warehouse=$2 AND id>$3 AND document_id<>$4 LIMIT 1',[m.item_id,m.warehouse,m.id,key]);
        check(!later.rowCount,'Existen movimientos dependientes posteriores; requiere conciliación.');
      }
      const reversal=id(),at=new Date().toISOString();
      await c.query(`INSERT INTO brewit.documents(id,kind,location,effective_at,status,body,created_by,posted_by,posted_at,request_key,request_hash)
        VALUES($1,'reversal',$2,$3,'posted',$4,$5,$5,now(),$6,$7)`,[reversal,doc.location,at,{originalId:key,reason},actor.id,`reversal:${key}`,digest({key,reason})]);
      for(const m of movements){
        await c.query(`INSERT INTO brewit.movements(document_id,item_id,warehouse,lot,quantity,value,effective_at,item_version,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[reversal,m.item_id,m.warehouse,m.lot,decimal(m.quantity).neg().toString(),decimal(m.value).neg().toString(),at,m.item_version,{reversalOf:m.id,costMethod:'original-movement'}]);
        await c.query('UPDATE brewit.balances SET quantity=quantity-$3,value=value-$4 WHERE warehouse=$1 AND item_id=$2',[m.warehouse,m.item_id,m.quantity,m.value]);
        await c.query('UPDATE brewit.lots SET quantity=quantity-$4 WHERE warehouse=$1 AND item_id=$2 AND lot=$3',[m.warehouse,m.item_id,m.lot,m.quantity]);
      }
      await c.query("UPDATE brewit.documents SET status='reversed',reversed_by=$2,version=version+1 WHERE id=$1",[key,reversal]);
      if(doc.kind==='receipt')for(const m of movements){
        const last=(await c.query(`SELECT m.value/m.quantity AS cost,m.effective_at FROM brewit.movements m JOIN brewit.documents d ON d.id=m.document_id
          WHERE m.warehouse=$1 AND m.item_id=$2 AND d.kind='receipt' AND d.status='posted' AND m.quantity>0 ORDER BY m.effective_at DESC,m.id DESC LIMIT 1`,[m.warehouse,m.item_id])).rows[0];
        await c.query('UPDATE brewit.balances SET last_purchase_cost=$3,last_purchase_at=$4 WHERE warehouse=$1 AND item_id=$2',[m.warehouse,m.item_id,last?.cost || null,last?.effective_at || null]);
      }
      await audit(c,actor,'document.reverse',key,{reversal,reason});return {id:reversal,status:'posted'};
    });
  }
  return { saveItem,createDocument,submit,publish,reverse,list,saveWarehouse,saveSupplier };
}
module.exports = { service, access, locations, kinds, audit };
