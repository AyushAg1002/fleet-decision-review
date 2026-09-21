'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('./core.js'),D=JSON.parse(fs.readFileSync(path.join(__dirname,'data.json'),'utf8'));
test('original extract retains known independently audited model totals',()=>{
 assert.equal(D.rows.length,5581);assert.equal(D.fingerprint,'3feb1ab3b9f8597921a2dc6499508de772f3629156d3d41c568c255a8569a6f9');
 const o=C.summarize(D.rows,'O'),s=C.summarize(D.rows,'S');
 assert.deepEqual([o.n,o.late,o.reviews.length],[4154,762,9]);assert.deepEqual([s.n,s.late,s.reviews.length],[1425,104,2]);
 assert.deepEqual(D.rows.filter(r=>!r.eligible).map(r=>r.id).sort(),['EVT-90804','EVT-92191']);
});
test('brief retains counterevidence and original-data authority distinctions',()=>{
 const o=C.summarize(D.rows,'O'),g=o.sites.find(g=>g.site==='IND-Hyderabad'),r=C.recommendation(g,C.defaults);
 assert.deepEqual(r.cohort,{clock:'03:00',n:66,late:65,lateDays:10});assert.deepEqual(r.timing,{n:66,departure:32,arrival:-4});
 const brief=C.managerBrief(g,C.defaults);assert.match(brief,/134\/209/);assert.match(brief,/-4 min/);assert.match(brief,/NOT OPERATIONAL APPROVAL/);
 const s=C.summarize(D.rows,'S').sites.find(g=>g.site==='Northwind');assert.match(C.managerBrief(s,C.defaults),/No lateness intervention is justified/);assert.match(C.managerBrief(s,C.defaults),/client transport lead \/ authorised operator owns dispatch/);
});
test('imported rules drop unknown properties and retain validation',()=>{
 assert.deepEqual(C.validateRules({...C.defaults,untrusted:'discard'}),C.defaults);assert.throws(()=>C.validateRules({...C.defaults,grace:-1}));assert.throws(()=>C.validateRules({...C.defaults,minRate:Infinity}));
});
