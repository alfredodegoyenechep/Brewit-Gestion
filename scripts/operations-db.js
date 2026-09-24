const {database}=require('../operations/database');
async function main(){
  if(!process.env.BREWIT_DATABASE_URL)throw Error('Configura BREWIT_DATABASE_URL.');
  const db=database(process.env.BREWIT_DATABASE_URL);
  try{await db.migrate();console.log('Esquema operativo preparado. Modo preparación; sin cambio de fuentes.');}
  finally{await db.close();}
}
main().catch(()=>{console.error('No se pudo preparar PostgreSQL. Revisa configuración, conexión y permisos.');process.exitCode=1;});
