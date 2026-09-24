const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const { check } = require('./domain');
const { locations } = require('./service');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
async function passwordHash(password) {
  check(typeof password === 'string' && password.length >= 12 && password.length <= 200,'Usa una contraseña de 12 a 200 caracteres.');
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password,salt,64)).toString('hex')}`;
}
async function passwordMatches(password, stored) {
  if (typeof password !== 'string' || password.length > 200) return false;
  const [salt,encoded] = stored.split(':');
  const got = await scrypt(password,salt,64), expected = Buffer.from(encoded,'hex');
  return got.length === expected.length && crypto.timingSafeEqual(got,expected);
}
function secretCodec(key) {
  check(/^[a-f0-9]{64}$/i.test(key || ''),'Configura BREWIT_AUTH_KEY con 32 bytes hexadecimales.');
  const bytes = Buffer.from(key,'hex');
  return {
    encrypt(secret) {const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',bytes,iv);return [iv,c.update(secret,'utf8'),c.final(),c.getAuthTag()].map(b=>b.toString('hex')).join(':');},
    decrypt(encoded) {const [iv,data,last,tag]=encoded.split(':').map(x=>Buffer.from(x,'hex'));const d=crypto.createDecipheriv('aes-256-gcm',bytes,iv);d.setAuthTag(tag);return Buffer.concat([d.update(data),d.update(last),d.final()]).toString('utf8');}
  };
}
function base32(bytes) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits=0,value=0,result='';
  for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){result+=alphabet[(value>>>(bits-5))&31];bits-=5;}}
  if(bits)result+=alphabet[(value<<(5-bits))&31];return result;
}
function totp(secret, step) {
  let bits=0,value=0,bytes=[];
  for(const ch of secret){const n='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);check(n>=0,'Secreto TOTP inválido.');value=(value<<5)|n;bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}
  const counter=Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const mac=crypto.createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=mac[19]&15;
  return String((mac.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
function authentication(db,key) {
  const codec=secretCodec(key);
  const publicUser=u=>({id:u.id,email:u.email,name:u.name,role:u.role,locations:u.locations,active:u.active});
  async function enrollment(c,token) {
    check(typeof token==='string' && /^[a-f0-9]{64}$/.test(token),'Enlace de activación inválido o vencido.',401);
    const r=(await c.query(`SELECT u.*,e.expires_at,e.used_at FROM brewit.enrollments e JOIN brewit.users u ON u.id=e.user_id
      WHERE e.token_hash=$1 AND e.expires_at>now() AND e.used_at IS NULL AND NOT u.active`,[hash(token)])).rows[0];
    check(r,'Enlace de activación inválido o vencido.',401);return r;
  }
  return {
    async invite({email,name,role,scopes=locations}) {
      check(typeof email==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Correo inválido.');
      check(typeof name==='string' && name.trim() && ['director','admin','manager','operator','viewer'].includes(role),'Nombre o rol inválido.');
      check(scopes.length>0 && scopes.every(l=>locations.includes(l)),'Ubicaciones inválidas.');
      const token=crypto.randomBytes(32).toString('hex'),secret=base32(crypto.randomBytes(20));
      const encoded=await passwordHash(crypto.randomBytes(32).toString('hex'));
      return db.transaction(async c=>{
        const u=(await c.query(`INSERT INTO brewit.users(id,email,name,password_hash,role,locations,active,totp_secret)
          VALUES($1,$2,$3,$4,$5,$6,false,$7) RETURNING *`,[crypto.randomUUID(),email.trim().toLowerCase(),name.trim(),encoded,role,JSON.stringify(scopes),codec.encrypt(secret)])).rows[0];
        const expires=(await c.query("INSERT INTO brewit.enrollments(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '48 hours') RETURNING expires_at",[hash(token),u.id])).rows[0].expires_at;
        await c.query('INSERT INTO brewit.audit(actor,action,entity,details) VALUES(NULL,$1,$2,$3)',['user.invited',u.id,{method:'local-cli',role,locations:scopes}]);
        return {user:publicUser(u),token,expiresAt:expires};
      });
    },
    async beginEnrollment(token) {
      const u=await enrollment(db.pool,token);return {name:u.name,email:u.email,secret:codec.decrypt(u.totp_secret)};
    },
    async finishEnrollment(token,password,code) {
      const u=await enrollment(db.pool,token),limitKey=hash(`enroll:${token}`);
      const limit=(await db.pool.query(`INSERT INTO brewit.login_attempts(key,attempts,reset_at) VALUES($1,1,now()+interval '15 minutes')
        ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN brewit.login_attempts.reset_at<now() THEN 1 ELSE brewit.login_attempts.attempts+1 END,
        reset_at=CASE WHEN brewit.login_attempts.reset_at<now() THEN now()+interval '15 minutes' ELSE brewit.login_attempts.reset_at END RETURNING attempts`,[limitKey])).rows[0];
      check(limit.attempts<=10,'Demasiados intentos. Espera 15 minutos.',429);
      check(typeof code==='string' && /^\d{6}$/.test(code),'Código de autenticación inválido.',401);
      const secret=codec.decrypt(u.totp_secret),step=Math.floor(Date.now()/30000),matched=[step-1,step,step+1].find(s=>totp(secret,s)===code);
      check(matched!=null,'Código de autenticación inválido.',401);
      const encoded=await passwordHash(password);
      return db.transaction(async c=>{
        await enrollment(c,token);
        await c.query('UPDATE brewit.users SET active=true,password_hash=$2,totp_last_step=$3 WHERE id=$1',[u.id,encoded,matched]);
        await c.query('UPDATE brewit.enrollments SET used_at=now() WHERE token_hash=$1',[hash(token)]);
        await c.query('INSERT INTO brewit.audit(actor,action,entity,details) VALUES($1,$2,$3,$4)',[u.id,'user.activated',u.id,{}]);
        return {ok:true};
      });
    },
    async provision({email,name,password,role,scopes=locations}) {
      check(typeof email==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Correo inválido.');
      check(['director','admin','manager','operator','viewer'].includes(role),'Rol inválido.');
      check(scopes.length>0 && scopes.every(l=>locations.includes(l)),'Ubicaciones inválidas.');
      const secret=base32(crypto.randomBytes(20)),encoded=await passwordHash(password);
      const user=(await db.pool.query('INSERT INTO brewit.users(id,email,name,password_hash,role,locations,totp_secret) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[crypto.randomUUID(),email.trim().toLowerCase(),name,encoded,role,JSON.stringify(scopes),codec.encrypt(secret)])).rows[0];
      return {user:publicUser(user),totpSecret:secret};
    },
    async login(email,password,code,ip) {
      check(typeof email==='string' && email.length<=254,'Credenciales inválidas.',401);
      const address=email.trim().toLowerCase(),limitKey=hash(address),ipKey=hash(`ip:${ip}`);
      const keys=[ipKey,limitKey];
      // Persisted limits prevent brute force across sessions or process restarts.
      for(const k of keys){const r=(await db.pool.query(`INSERT INTO brewit.login_attempts(key,attempts,reset_at) VALUES($1,1,now()+interval '15 minutes')
        ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN brewit.login_attempts.reset_at<now() THEN 1 ELSE brewit.login_attempts.attempts+1 END,
        reset_at=CASE WHEN brewit.login_attempts.reset_at<now() THEN now()+interval '15 minutes' ELSE brewit.login_attempts.reset_at END RETURNING attempts`,[k])).rows[0];check(r.attempts <= (k===ipKey?50:10),'Demasiados intentos. Espera 15 minutos.',429);}
      const user=(await db.pool.query('SELECT * FROM brewit.users WHERE email=$1',[address])).rows[0];
      const dummy='0123456789abcdef0123456789abcdef:'+ '00'.repeat(64);
      const valid=await passwordMatches(password,user?.password_hash || dummy);
      check(valid && user?.active,'Credenciales inválidas.',401);
      check(typeof code==='string' && /^\d{6}$/.test(code) && user.totp_secret,'Código de autenticación inválido.',401);
      const step=Math.floor(Date.now()/30000),secret=codec.decrypt(user.totp_secret);
      const matched=[step-1,step,step+1].find(s=>totp(secret,s)===code);
      check(matched != null,'Código de autenticación inválido.',401);
      return db.transaction(async c=>{
        const updated=await c.query('UPDATE brewit.users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step<$2)',[user.id,matched]);
        check(updated.rowCount===1,'Código ya utilizado. Espera el siguiente.',401);
        const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
        await c.query("INSERT INTO brewit.sessions VALUES($1,$2,$3,now()+interval '8 hours')",[hash(token),user.id,csrf]);
        await c.query('DELETE FROM brewit.login_attempts WHERE key=$1',[limitKey]);
        await c.query('INSERT INTO brewit.audit(actor,action,entity,details) VALUES($1,$2,$3,$4)',[user.id,'session.login',user.id,{}]);
        return {token,csrf,user:publicUser(user)};
      });
    },
    async session(token) {
      if(!/^[a-f0-9]{64}$/.test(token || ''))return null;
      const r=(await db.pool.query('SELECT u.*,s.csrf FROM brewit.sessions s JOIN brewit.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active',[hash(token)])).rows[0];
      return r?{user:publicUser(r),csrf:r.csrf}:null;
    },
    logout:token=>db.pool.query('DELETE FROM brewit.sessions WHERE token_hash=$1',[hash(token || '')])
  };
}
module.exports={authentication,passwordHash,passwordMatches,totp,base32};
