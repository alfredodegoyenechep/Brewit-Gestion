const test=require('node:test'),assert=require('node:assert/strict');const{buildSalesInsights:build}=require('../sales-insight-filters');
const p=(code,name,barType,quantity,netSales)=>({code,name,barType,quantity,netSales,totalCost:netSales/2,costAvailable:true,hierarchyPath:['Barra Café','Bebidas']});
test('filters both hierarchy and ranking and groups beverage sizes without losing amounts or margins',()=>{const rows=[p('a','Latte (CL)','hot',3,30),p('b','Latte (GR)','hot',2,40),p('c','Latte (XTR)','cold',1,20),p('d','Otro (CL)','other',4,10)];const r=build(rows,{bar:'hot',groupFormats:true});assert.equal(r.topProducts.length,1);assert.equal(r.topProducts[0].name,'Latte');assert.equal(r.topProducts[0].quantity,5);assert.equal(r.topProducts[0].netSales,70);assert.equal(r.hierarchyTree.netSales,70);assert.equal(r.hierarchyTree.contributionMarginPercent,50);assert.equal(r.topProducts[0].cumulativeSalesSharePercent,100);assert.equal(build(rows,{groupFormats:true}).topProducts.length,3);});
test('top 100 retains the full filtered-sales denominator and cumulative amount at every position',()=>{const rows=Array.from({length:110},(_,i)=>p(String(i),'Product '+i,'other',110-i,10));const r=build(rows);assert.equal(r.topProducts.length,100);assert.ok(Math.abs(r.topProducts[9].cumulativeSalesSharePercent-100/11)<1e-9);assert.ok(Math.abs(r.topProducts[99].cumulativeSalesSharePercent-1000/11)<1e-9);assert.equal(build(rows,{bar:'hot'}).topProducts.length,0);});

test('classifies synchronized product hierarchies when extras assignments are empty', () => {
  const { classifySalesBar } = require('../sales-insight-filters');
  const classify = (name, category) => classifySalesBar({name,hierarchyPath:['Barra Cafe',category]});
  assert.equal(classify('Cappuccino (CL)','Café Caliente'),'hot');
  assert.equal(classify('Matcha (hot) (GR)','Matcha & Chai'),'hot');
  assert.equal(classify('Matcha (Ice)(CL)','Matcha & Chai'),'cold');
  assert.equal(classify('Frappé Mocha (XTR)','Signature'),'cold');
  assert.equal(classify('Protein (GR)','Protein'),'other');
  assert.equal(classifySalesBar({name:'Caja Café',hierarchyPath:['Cafe Bolsa - Merch']}),'other');
});

test('groups beverage formats even when the master does not identify their bar', () => {
  const rows = ['CL','GR'].map((size,i) => ({code:String(i),name:`Protein (${size})`,barType:'other',hierarchyPath:['Barra Cafe','Protein'],quantity:1,netSales:100,totalCost:20}));
  const result = build(rows,{bar:'other',groupFormats:true});
  assert.equal(result.topProducts.length,1);
  assert.equal(result.topProducts[0].quantity,2);
  assert.equal(result.totalNetSales,200);
});

test('ranking by sales changes the top 100 and cumulative percentages after grouping', () => {
  const rows = [p('a','Latte (CL)','hot',2,60),p('b','Latte (GR)','hot',1,60),p('c','Tea','hot',10,80)];
  const units = build(rows,{groupFormats:true});
  const sales = build(rows,{groupFormats:true,rankBy:'netSales'});
  assert.equal(units.topProducts[0].name,'Tea');
  assert.equal(sales.topProducts[0].name,'Latte');
  assert.equal(sales.topProducts[0].cumulativeSalesSharePercent,60);
  assert.equal(sales.topProducts[1].cumulativeSalesSharePercent,100);
  assert.equal(sales.hierarchyTree.netSales,units.hierarchyTree.netSales);
  const many = Array.from({length:101},(_,i)=>p(String(i),'Item '+i,'other',101-i,i+1));
  const ranked = build(many,{rankBy:'netSales'}).topProducts;
  assert.equal(ranked.length,100);
  assert.equal(ranked[0].code,'100');
  assert.equal(ranked.at(-1).code,'1');
});

test('format grouping tolerates accents, whitespace and Ice/Iced spelling while preserving distinct recipes', () => {
  const rows = [p('a','Matcha Vainilla (iced) (CL)','cold',1,100),p('b','Matcha Vainilla (ice)( GR )','cold',2,200),p('c','Matcha  Vainílla (Iced) (XTR)','cold',3,300),p('d','Matcha Vainilla sin azúcar (CL)','cold',1,50),p('e','Matcha Vainilla (hot) (CL)','hot',1,60)];
  const result=build(rows,{groupFormats:true});
  assert.equal(result.topProducts.length,3);
  assert.equal(result.topProducts[0].quantity,6);
  assert.equal(result.topProducts[0].netSales,600);
  assert.equal(result.hierarchyTree.products.length,3);
  assert.equal(result.totalNetSales,build(rows).totalNetSales);
  assert.equal(result.hierarchyTree.totalCost,build(rows).hierarchyTree.totalCost);
});

test('annual ranking groups historical M/G/X sizes together with current CL/GR/XTR sizes', () => {
  const rows = ['M','G','X','CL','GR','XTR'].map((size,i)=>p(String(i),`Cappuccino (${size})`,'hot',i+1,(i+1)*100));
  const grouped=build(rows,{groupFormats:true,rankBy:'netSales'});
  assert.equal(grouped.topProducts.length,1);
  assert.equal(grouped.topProducts[0].name,'Cappuccino');
  assert.equal(grouped.topProducts[0].quantity,21);
  assert.equal(grouped.topProducts[0].netSales,2100);
  assert.equal(grouped.topProducts[0].codes.length,6);
  assert.equal(grouped.hierarchyTree.products.length,1);
  assert.equal(grouped.hierarchyTree.totalCost,1050);
  assert.equal(build(rows,{groupFormats:false}).topProducts.length,6);
  assert.equal(build([{...p('retail','Caja (M)','other',1,100),hierarchyPath:['Retail']}],{groupFormats:true}).topProducts[0].name,'Caja (M)');
});
