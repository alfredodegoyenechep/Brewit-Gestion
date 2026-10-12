// Compare previously captured API reports after a storage migration. Runtime
// metadata changes are excluded; business values and errors must be identical.
const fs=require('node:fs'),path=require('node:path');
const directory=path.resolve(process.argv[2]||'tmp/storage-audit'),base=process.argv[3]||'http://localhost:3000';
function stable(value){
 if(Array.isArray(value))return value.map(stable);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.keys(value).sort().filter(k=>!['generatedAt','calculatedAt','requestId','sourceUpdatedAt'].includes(k)).map(k=>[k,stable(value[k])]));
}
function differences(a,b,p='$',out=[]){
 if(JSON.stringify(a)===JSON.stringify(b))return out;
 if(!a||!b||typeof a!=='object'||typeof b!=='object'){out.push({path:p,before:a,after:b});return out;}
 for(const k of new Set([...Object.keys(a),...Object.keys(b)])){if(out.length>=30)break;differences(a[k],b[k],p+'.'+k,out);}return out;
}
(async()=>{
 const result=[];
 for(const name of fs.readdirSync(directory).filter(n=>n.startsWith('before-')&&n.endsWith('.json'))){
  const before=JSON.parse(fs.readFileSync(path.join(directory,name)));const r=await fetch(base+before.url,{signal:AbortSignal.timeout(120000)});const after={url:before.url,status:r.status,data:await r.json()};
  fs.writeFileSync(path.join(directory,name.replace('before-','after-')),JSON.stringify(after));
  const diffs=differences(stable(before),stable(after));result.push({name:name.slice(7,-5),status:r.status,equivalent:diffs.length===0,differences:diffs});console.log(result.at(-1).name,r.status,diffs.length===0?'equivalent':JSON.stringify(diffs));
 }
 fs.writeFileSync(path.join(directory,'report-equivalence.json'),JSON.stringify(result,null,2));
 if(result.some(r=>!r.equivalent))process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
