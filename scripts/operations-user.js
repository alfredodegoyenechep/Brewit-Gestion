const readline=require('node:readline/promises');
const {Writable}=require('node:stream');
const {database}=require('../operations/database');
const {authentication}=require('../operations/auth');
async function main(){
  if(!process.stdin.isTTY)throw Error('Ejecuta este comando en una terminal interactiva.');
  let muted=false;
  const output=new Writable({write(chunk,_encoding,callback){if(!muted)process.stdout.write(chunk);callback();}});
  const rl=readline.createInterface({input:process.stdin,output,terminal:true});
  let db;
  try{
    const email=await rl.question('Correo: '),name=await rl.question('Nombre: '),role=await rl.question('Rol (director/admin/manager/operator/viewer): ');
    const scope=await rl.question('Ubicaciones, separadas por coma (store-1,store-2,main-warehouse): ');
    process.stdout.write('Contraseña (mínimo 12 caracteres; no se muestra): ');muted=true;const password=await rl.question('');muted=false;process.stdout.write('\n');
    if(!process.env.BREWIT_DATABASE_URL)throw Error('Falta PostgreSQL.');
    db=database(process.env.BREWIT_DATABASE_URL);
    const result=await authentication(db,process.env.BREWIT_AUTH_KEY).provision({email,name,password,role,scopes:scope.split(',').map(s=>s.trim())});
    console.log('Usuario creado. Registra este secreto UNA VEZ en tu autenticador y no lo compartas:');
    console.log(result.totpSecret);
  }finally{rl.close();if(db)await db.close();}
}
main().catch(()=>{console.error('No se creó el usuario. Revisa conexión, rol, ubicaciones, contraseña y correo no duplicado.');process.exitCode=1;});
