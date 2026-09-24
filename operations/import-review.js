const {check}=require('./domain');
const {service,access}=require('./service');

// Both the native master and the approval are committed on the same connection.
async function reviewImport(db,actor,key,{revision,proposal,reason,publish=false}) {
  access(actor,null,['director','admin']);
  check(typeof publish==='boolean','Acción de revisión inválida.');
  check(Number.isInteger(revision),'Falta versión de revisión.');
  check(typeof reason==='string' && reason.trim().length>=5 && reason.length<=2000,'Explica la revisión o corrección (mínimo 5 caracteres).');
  check(proposal && typeof proposal==='object' && !Array.isArray(proposal),'Propuesta inválida.');
  return db.transaction(async c=>{
    const row=(await c.query('SELECT * FROM brewit.master_import_rows WHERE id=$1 FOR UPDATE',[key])).rows[0];
    check(row,'Registro importado inexistente.',404);
    check(row.status==='pending','Este registro ya fue publicado; edítalo desde el catálogo.',409);
    check(row.revision===revision,'Otra persona modificó esta revisión. Recarga antes de continuar.',409);
    check(row.kind!=='recipe','Revisa y publica la receta junto con su artículo.');
    const b=JSON.parse(JSON.stringify(proposal));
    if(row.kind==='warehouse')access(actor,b.location,['director','admin']);
    else check(b.code===row.code,'No se puede cambiar el código importado.');
    let target=null;
    if(publish){
      const svc=service({transaction:fn=>fn(c),pool:c});
      if(row.kind==='item'){
        check(!(await c.query('SELECT 1 FROM brewit.items WHERE code=$1',[row.code])).rowCount,'El artículo ya existe. Revisa su versión en Catálogo; no se sobrescribe desde una importación.',409);
        check(!row.original.recipe?.ingredients?.length || b.recipe,'Debes revisar y conservar la receta importada antes de publicar.');
        b.effectiveAt=new Date().toISOString();
        b.importOrigin={rowId:row.id,importId:row.import_id};
        target=await svc.saveItem(actor,b,0);
      }else if(row.kind==='supplier')target=await svc.saveSupplier(actor,{...b,importOrigin:row.id});
      else if(row.kind==='warehouse')target=await svc.saveWarehouse(actor,b);
      else {
        check(['hierarchy-products','hierarchy-ingredients','hierarchy-extras'].includes(row.kind),'Tipo de maestro no admitido.');
        check(typeof b.name==='string' && b.name.trim().length>0 && b.name.length<=200,'Nombre requerido.');
        target=(await c.query('INSERT INTO brewit.hierarchies(kind,code,body,source_row,approved_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[row.kind,row.code,b,row.id,actor.id])).rows[0];
      }
    }
    const result=(await c.query(`UPDATE brewit.master_import_rows SET proposal=$2,revision=revision+1,
      status=$3,accepted_by=$4,accepted_at=$5 WHERE id=$1 RETURNING *`,[key,b,publish?'accepted':'pending',publish?actor.id:null,publish?new Date():null])).rows[0];
    if(publish && row.kind==='item' && b.recipe){
      await c.query("UPDATE brewit.master_import_rows SET proposal=$3,status='accepted',revision=revision+1,accepted_by=$4,accepted_at=now() WHERE import_id=$1 AND code=$2 AND kind='recipe' AND status='pending'",[row.import_id,row.code,b.recipe,actor.id]);
    }
    await c.query('INSERT INTO brewit.audit(actor,action,entity,details) VALUES($1,$2,$3,$4)',[actor.id,publish?'masters.review.publish':'masters.review.save',key,{reason:reason.trim(),previous:row.proposal,proposal:b,revision:result.revision,kind:row.kind,code:row.code,targetId:target?.id||null}]);
    return result;
  });
}
module.exports={reviewImport};
