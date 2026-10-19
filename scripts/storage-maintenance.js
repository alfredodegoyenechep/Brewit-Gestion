#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const maintenance=require('../storage-maintenance');
const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
const root=path.resolve(args.includes('--root')?value('--root'):path.join(__dirname,'../uploads'));
const mutating=args.includes('--apply')||args.includes('--migrate');
let lock,acquired=false;
try {
  if(mutating) {
    if(!args.includes('--offline'))throw Error('Detén el servidor y las sincronizaciones; utiliza --offline para el corte de mantenimiento.');
    lock=path.join(root,'.storage-maintenance.lock');
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
    acquired=true;
    require('../historical-control').get(root).bootstrap();
  }
  const progress=message=>process.stderr.write(message+'\n');
  const result=args.includes('--apply')?maintenance.apply(root,JSON.parse(fs.readFileSync(value('--apply'),'utf8')),{progress})
    :args.includes('--migrate')?maintenance.migrate(root,{remove:args.includes('--remove-originals'),progress})
    :maintenance.audit(root,{progress});
  if(args.includes('--output'))fs.writeFileSync(value('--output'),JSON.stringify(result,null,2),{mode:0o600});
  else process.stdout.write(JSON.stringify(result,null,2)+'\n');
  process.stderr.write(JSON.stringify({candidates:result.candidates?.length,candidateGiB:result.candidateBytes/1024**3,
    removed:result.removed?.length,freedGiB:result.freedBytes/1024**3,migrated:result.migrated?.length,pending:result.pending?.length})+'\n');
} catch(error) {process.stderr.write(error.message+'\n');process.exitCode=1;}
finally{if(acquired)fs.rmSync(lock,{force:true});}
