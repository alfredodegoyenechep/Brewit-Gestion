const fs=require('node:fs');
const path=require('node:path');
const {database}=require('../operations/database');
const {authentication}=require('../operations/auth');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function main(){
  const [email,name,role]=process.argv.slice(2);
  if(!email || !name || !role || !process.env.BREWIT_DATABASE_URL)throw Error('Faltan argumentos o conexión.');
  const db=database(process.env.BREWIT_DATABASE_URL);
  try{
    const root=path.join(process.env.BREWIT_UPLOADS_ROOT || path.join(__dirname,'..','uploads'),'.integrations','brewit','activation');fs.mkdirSync(root,{recursive:true,mode:0o700});
    const slug=email.toLowerCase().replace(/[^a-z0-9]/g,'_'),file=path.join(root,`${slug}.html`);
    if(fs.existsSync(file))throw Error('Ya existe una invitación local para este correo.');
    const result=await authentication(db,process.env.BREWIT_AUTH_KEY).invite({email,name,role});
    const link=`http://localhost:3000/operaciones#activate=${result.token}`;
    fs.writeFileSync(file,`<!doctype html><html lang="es"><meta charset="utf-8"><title>Activación privada Brewit</title><body style="font:18px system-ui;padding:40px"><h1>Activar ${esc(name)}</h1><p>${esc(email)} · ${esc(role)}</p><p>Este enlace privado vence en 48 horas y se utiliza una sola vez. Ábrelo únicamente en este equipo. No lo compartas.</p><p><a href="${esc(link)}" rel="noreferrer">Elegir contraseña y configurar autenticador</a></p></body></html>`,{flag:'wx',mode:0o600});
    console.log(`Usuario preparado: ${name} (${role}). Archivo privado: ${file}`);
  }finally{await db.close();}
}
main().catch(()=>{console.error('No se completó el alta. Revisa los argumentos, el correo no duplicado y la conexión.');process.exitCode=1;});
