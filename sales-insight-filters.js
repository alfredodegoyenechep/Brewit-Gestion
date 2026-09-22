(function(root){
  function classifySalesBar({ hierarchyIds = [], hierarchyPath = [], name = "" }, hotIds = new Set(), coldIds = new Set()) {
    if (hierarchyIds.some(id => coldIds.has(id))) return "cold";
    if (hierarchyIds.some(id => hotIds.has(id))) return "hot";
    const normalize = value => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const path = hierarchyPath.map(normalize);
    if (!path.includes("barra cafe")) return "other";
    const label = normalize(name);
    if (/\b(iced?|frappe|chill|granizado|smoothie|lemonade|limonade)\b/.test(label) || path.some(p => /frappe|chill|granizado|iced|smoothie/.test(p))) return "cold";
    if (/\b(hot|caliente)\b/.test(label) || path.includes("cafe caliente") || path.includes("te verde & infusion")) return "hot";
    return "other";
  }
  function buildSalesInsights(products,{bar='all',groupFormats=false,rankBy='quantity'}={}) {
    const selected=products.filter(p=>bar==='all'||p.barType===bar),groups=new Map();
    for(const p of selected){
      const beverage=['hot','cold'].includes(p.barType) || (p.hierarchyPath || []).some(name => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === 'barra cafe');
      const name=groupFormats&&beverage?p.name.replace(/\s*\(\s*(CL|GR|XTR|M|G|X)\s*\)\s*$/i,'').trim():p.name;
      const grouped=groupFormats&&beverage&&name!==p.name;
      const normalizedName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('es').replace(/\(\s*ice(?:d)?\s*\)/g, '(iced)')
        .replace(/\s+/g, ' ').replace(/\s*\(\s*/g, ' (').replace(/\s*\)/g, ')').trim();
      const key=grouped?JSON.stringify([p.barType,p.hierarchyPath,normalizedName]):p.code||p.name;
      const item=groups.get(key)||{...p,name,code:p.code,codes:[],quantity:0,netSales:0,totalCost:0,costAvailable:true};
      item.quantity+=p.quantity;item.netSales+=p.netSales;item.totalCost+=p.totalCost||0;item.costAvailable=item.costAvailable&&p.costAvailable!==false;
      if(!item.codes.includes(p.code))item.codes.push(p.code);groups.set(key,item);
    }
    const items=[...groups.values()].map(p=>({...p,code:p.codes.join(' / ')}));
    const total=items.reduce((n,p)=>n+p.netSales,0);let accumulated=0;
    const topProducts=items.sort((a,b)=>(rankBy==='netSales' ? b.netSales-a.netSales||b.quantity-a.quantity : b.quantity-a.quantity||b.netSales-a.netSales)||a.name.localeCompare(b.name,'es')).slice(0,100).map(p=>{
      accumulated+=p.netSales;return {...p,salesSharePercent:total?p.netSales/total*100:0,cumulativeSalesSharePercent:total?accumulated/total*100:0};
    });
    const node=(name,path)=>({name,path,netSales:0,totalCost:0,costAvailable:true,children:[],products:[]});
    const tree=node('Todas las jerarquías',[]);
    const add=(n,p)=>{n.netSales+=p.netSales;n.totalCost+=p.totalCost;n.costAvailable=n.costAvailable&&p.costAvailable;n.products.push({...p,contributionMarginPercent:p.costAvailable&&p.netSales?(p.netSales-p.totalCost)/p.netSales*100:null});};
    for(const p of items){let n=tree;add(n,p);for(const name of p.hierarchyPath||['Sin jerarquía']){let child=n.children.find(c=>c.name===name);if(!child){child=node(name,[...n.path,name]);n.children.push(child);}n=child;add(n,p);}}
    function finish(n){n.contributionMarginPercent=n.costAvailable&&n.netSales?(n.netSales-n.totalCost)/n.netSales*100:null;n.children.sort((a,b)=>b.netSales-a.netSales);n.products.sort((a,b)=>b.netSales-a.netSales);n.children.forEach(finish);}finish(tree);
    return {topProducts,hierarchyTree:tree,totalNetSales:total};
  }
  if(typeof module==='object')module.exports={buildSalesInsights,classifySalesBar};else root.buildFilteredSalesInsights=buildSalesInsights;
})(typeof window==='undefined'?globalThis:window);
