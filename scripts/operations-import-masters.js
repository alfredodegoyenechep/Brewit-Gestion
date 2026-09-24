const path=require('node:path');
const {database}=require('../operations/database');
const {readSharedSource,importShared}=require('../operations/master-import');
async function main(){
  if(!process.env.BREWIT_DATABASE_URL)throw Error('Falta BREWIT_DATABASE_URL.');
  const db=database(process.env.BREWIT_DATABASE_URL);
  try{const source=readSharedSource(process.env.BREWIT_UPLOADS_ROOT || path.join(__dirname,'..','uploads'));const r=await importShared(db,source);console.log(JSON.stringify({reused:r.reused,counts:r.report.counts,observations:r.report.issues.length,mode:r.report.mode,published:r.report.published},null,2));}
  finally{await db.close();}
}
main().catch(error=>{console.error(error.status?error.message:'No se pudo importar la captura. Revisa PostgreSQL y los maestros sincronizados.');process.exitCode=1;});
