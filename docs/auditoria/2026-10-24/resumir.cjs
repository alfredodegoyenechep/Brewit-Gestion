// Produce aggregate evidence only; no transactions, credentials or customer data.
const fs=require('node:fs'),path=require('node:path');
const dir=__dirname,work=fs.readFileSync('/private/tmp/brewit-audit-current.txt','utf8').trim();
const read=name=>fs.existsSync(path.join(work,name))?JSON.parse(fs.readFileSync(path.join(work,name),'utf8')):null;
const base=read('baseline-private.json'),measure=read('measurements-private.json'),synthetic=read('synthetic-results.json'),supplementary=read('supplementary.json');
const median=values=>{const s=[...values].sort((a,b)=>a-b);return s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2;};
const rounded=n=>Number.isFinite(n)?Math.round(n*100)/100:null;
function csv(name,rows){if(!rows.length)return;const columns=Object.keys(rows[0]);const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';fs.writeFileSync(path.join(dir,name),[columns.map(cell).join(','),...rows.map(row=>columns.map(k=>cell(typeof row[k]==='object'?JSON.stringify(row[k]):row[k])).join(','))].join('\n')+'\n');}
const groups=new Map();
for(const r of base.historical.filter(r=>r.origin!=='legacy'&&r.startedAt>='2026-10-01'&&Number.isFinite(r.ms))) {
  const key=[r.origin,r.label,r.location,r.reception].join('|');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
}
const historical=[...groups].map(([key,rows])=>({group:key,n:rows.length,medianSeconds:rounded(median(rows.map(r=>r.ms))/1000),minSeconds:rounded(Math.min(...rows.map(r=>r.ms))/1000),maxSeconds:rounded(Math.max(...rows.map(r=>r.ms))/1000)}));
csv('TIEMPOS_HISTORICOS.csv',historical);
const coverage=[];
for(const kind of ['sales','purchases','stock','original-counts','masters'])for(const location of ['store-1','store-2']){
 const root=path.join(work,'uploads/.integrations/toteat-api',kind,location),pointer=path.join(root,'current.json');if(!fs.existsSync(pointer))continue;
 const version=JSON.parse(fs.readFileSync(pointer)).version,folder=path.join(root,version),stateFile=path.join(folder,fs.existsSync(path.join(folder,'state.json'))?'state.json':'normalized.json');
 const s=JSON.parse(fs.readFileSync(stateFile));coverage.push({source:kind,location,from:s.from||s.range?.from||'',through:s.through||s.range?.to||'',updatedAt:s.syncedAt||s.sourceCapturedAt||s.capturedAt||s.observedAt||'',orders:s.orderCount??'',payments:s.payments?.length??'',documents:s.documents?.length??'',lines:s.lineCount??s.lines?.length??s.operationLines?.length??'',dailyRows:s.daily?.length??'',products:s.products?.length??'',issues:s.issues?.length??s.warnings?.length??'',sourceKind:s.sourceKind||s.source||'',issueKinds:s.issues?.reduce((a,i)=>{const k=i.kind||i.type||'unclassified';a[k]=(a[k]||0)+1;return a;},{})||{}});
}
csv('COBERTURA_FUENTES.csv',coverage);
const endpointStats=[];
if(measure)for(const label of new Set(measure.api.map(r=>r.label))){
  const rows=label==='costos'&&supplementary?.costReview?.length===5?supplementary.costReview:measure.api.filter(r=>r.label===label);endpointStats.push({action:label,n:rows.length,firstMs:rounded(rows[0].ms),medianMs:rounded(median(rows.map(r=>r.ms))),minMs:rounded(Math.min(...rows.map(r=>r.ms))),maxMs:rounded(Math.max(...rows.map(r=>r.ms))),statuses:[...new Set(rows.map(r=>r.status))].join('|'),error:rows.find(r=>r.error)?.error||''});
}
csv('TIEMPOS_API.csv',endpointStats);
const ui=[];if(measure)for(const view of new Set(measure.browser.map(r=>r.view))){const rows=measure.browser.filter(r=>r.view===view),fixed=view==='inventory'?supplementary?.inventory?.[0]:null;ui.push({view,n:rows.length,medianObservedMs:rounded(median(rows.map(r=>r.ms))),immediateStatus:fixed?.text||rows[0].immediate.text||'',statusVisible:fixed?.visible??rows[0].immediate.visible,requests:rows[0].requests.map(r=>r.url).join(' | ')});}
csv('TIEMPOS_UI.csv',ui);
// Request samples retain paths and aggregate timings, never response bodies.
if(measure)csv('MUESTRAS_SOLICITUDES.csv',measure.requests.map(r=>({route:r.url.replace(/OC-[\w-]+/g,'ORDER_ID'),method:r.method,status:r.status,ms:rounded(r.ms),fsReads:r.parts.fsRead?.calls||0,fsReadMs:rounded(r.parts.fsRead?.ms||0),workbookReads:r.parts.workbookRead?.calls||0,workbookMs:rounded(r.parts.workbookRead?.ms||0),sheetToRowsMs:rounded(r.parts.sheetToRows?.ms||0),stockReads:r.parts.stockCurrent?.calls||0,stockMs:rounded(r.parts.stockCurrent?.ms||0)})));
const recent=base.historical.filter(r=>r.origin==='toteat-public-api'&&r.label==='Ventas y pagos'&&r.reception==='complete').sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,2);
const timeline=[];for(const r of recent){const m=JSON.parse(fs.readFileSync(path.join(work,'uploads/.historical-control/runs',r.id,'manifest.json')));for(const a of m.artifacts)timeline.push({location:m.location,runStartedAt:m.startedAt,responseSavedAt:a.savedAt,name:a.name,originalBytes:a.originalBytes,compressedBytes:a.bytes,msFromRunStart:Date.parse(a.savedAt)-Date.parse(m.startedAt)});}
csv('TRAZA_VENTAS_HISTORICA.csv',timeline.sort((a,b)=>a.responseSavedAt.localeCompare(b.responseSavedAt)));
const output={capturedAt:base.capturedAt,commit:base.commit,trackedDiffSha256:base.trackedDiffSha256,node:base.node,copy:base.copy,inconsistentFiles:base.inconsistent.length,historyRuns:base.historical.length,settings:base.settings,lastRefresh:base.lastRefresh,historical,coverage,endpointStats,ui,
  runtime:measure?{failure:measure.failure||null,eventLoop:measure.eventLoop,blockedExternal:[...new Set(measure.blockedExternal)],pageErrors:measure.pageErrors,hypotheses:measure.hypotheses,navigation:measure.navigation}:null,synthetic,supplementary,
  instrumentationNotes:['Subtimings overlap and must not be added.','Initial cost-review URL used date instead of dateTo; five supplementary measurements with dateTo supersede that summary.','Initial inventory status selector was plural; five supplementary browser checks use inventory-source-status.','Projection CPU was sampled for three seconds; two brief debugger inspections were performed on the isolated measurement process.','Browser completion includes a 200–300 ms quiet-window allowance; API timings are reported separately.']};
fs.writeFileSync(path.join(dir,'EVIDENCIA_AGREGADA.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({historicalGroups:historical.length,endpoints:endpointStats.length,views:ui.length,synthetic:!!synthetic,runtimeFailure:output.runtime?.failure}));
