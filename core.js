(function(root){
'use strict';
const defaults=Object.freeze({grace:15,minLegs:20,minLate:5,minRate:0.2});
function validateRules(input){
 const r={grace:input?.grace,minLegs:input?.minLegs,minLate:input?.minLate,minRate:input?.minRate};
 for(const k of ['grace','minLegs','minLate']) if(typeof r[k]!=='number'||!Number.isInteger(r[k])||r[k]<0||r[k]>10000) throw Error('Enter a whole number from 0 to 10,000 for each count and grace.');
 if(typeof r.minRate!=='number'||!Number.isFinite(r.minRate)||r.minRate<0||r.minRate>1) throw Error('Enter a late rate from 0% to 100%.');
 return r;
}
function key(model,site){return JSON.stringify([model,site]);}
function summarize(rows,model,rules=defaults){
 validateRules(rules);
 const scoped=rows.filter(r=>r.model===model), eligible=scoped.filter(r=>r.eligible), late=eligible.filter(r=>r.delay>rules.grace);
 const groups=new Map();
 for(const row of scoped.filter(r=>r.named)){
  const k=key(row.model,row.site);
  if(!groups.has(k)) groups.set(k,{key:k,model,site:row.site,legs:[],n:0,late:0,directions:{Login:{n:0,late:0},Logout:{n:0,late:0}}});
  const g=groups.get(k);g.legs.push(row);
  if(row.eligible){g.n++;g.directions[row.direction].n++;if(row.delay>rules.grace){g.late++;g.directions[row.direction].late++;}}
 }
 const sites=[...groups.values()].map(g=>({...g,rate:g.n?g.late/g.n:null,review:g.n>=rules.minLegs&&g.late>=rules.minLate&&g.n>0&&g.late/g.n>=rules.minRate,status:!g.n?'No eligible legs':g.n<rules.minLegs?'Low sample':g.late>=rules.minLate&&g.late/g.n>=rules.minRate?'Review':'Below threshold'})).sort((a,b)=>b.late-a.late||(b.rate??0)-(a.rate??0)||a.site.localeCompare(b.site));
 return {model,total:scoped.length,n:eligible.length,late:late.length,rate:eligible.length?late.length/eligible.length:null,unresolved:scoped.filter(r=>!r.named).length,excluded:scoped.length-eligible.length,sites,reviews:sites.filter(s=>s.review)};
}
const api={defaults,validateRules,key,summarize};root.FleetCore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
(function(root){
'use strict';
const C=root.FleetCore;
function decisionPolicy(model){
 if(!['O','S'].includes(model))throw Error('Unknown service model.');
 return {
  status:'Proposed for sign-off. Actual approvers, approved replacement pool and spend limits are not supplied.',
  accountManager:'Within an agreed remit: verify the facts and client promise, coordinate an approved investigation, and communicate verified status. Do not commit extra spend, compensation or a changed client promise.',
  execution:model==='O'?'O site lead / fleet controller: dispatch replacement cover only after eligibility, acceptance, approved pool, quoted cost and signed limits are verified. A missing cap, quote, pool or approval means approval is required.':'S client transport lead / authorised operator owns dispatch and expenditure decisions. The account manager coordinates the response; software access does not grant dispatch authority.',
  escalation:model==='O'?'A coverage gap still open at T-15 goes to the city operations head. Missing authority or a decision outside signed limits goes to the named operational/commercial approver; Meera must identify that person before the pilot.':'A coverage gap still open at T-15 goes to the client transport lead via the account manager. Missing client authority or a promise/spend change goes to the client\'s named approver; confirm that contact before the pilot.',
  hold:'An assigned vehicle with unverified or failed document/capacity eligibility is held while the authorised controller seeks eligible cover. This proposed policy permits no eligibility waiver. T is planned leg departure; these are future operating triggers, not live alerts from this extract.'
 };
}
function managerBrief(g,rules,action=null,isDraft=false){
 const r=C.recommendation(g,rules),p=decisionPolicy(g.model),value=(v,fallback)=>typeof v==='string'&&v.trim()?v.trim():fallback;
 return [
  'DECISION BRIEF — DRAFT FOR REVIEW; NOT OPERATIONAL APPROVAL',
  `Site/model: ${g.site} / ${g.model}. Historical source: 5–18 July 2026.`,
  `Evidence: ${g.late}/${g.n} eligible legs are more than ${rules.grace} minutes after plan. ${r.detail}`,
  r.nuance?`Countercheck: ${r.nuance}`:'Limit: plan adherence is a review proxy; the cause and client SLA are not established.',
  `Suggested next step: ${r.action}`,
  `Account manager: ${p.accountManager}`,
  `Operational authority: ${p.execution}`,
  `Escalate: ${p.escalation}`,
  `Eligibility: ${p.hold}`,
  `Authority status: ${p.status}`,
  `Action record: ${isDraft?'UNSAVED FORM DRAFT':action?'Saved locally; no notification sent':'No action saved'}.`,
  `Status: ${value(action?.status,'Not set')}. Closure time: ${!isDraft&&action?.closedAt?action.closedAt:'No saved closure time for this record/draft'}.`,
  `Outcome / evidence: ${value(action?.evidence,'Not recorded')}`,
  `Owner: ${value(action?.owner,'Not assigned — on-duty lead must name one')}. Due (IST): ${value(action?.due,'Not set')}.`,
  `Recorded next action: ${value(action?.action,'Not set — use or adapt the suggested step above')}`,
  'If approval is needed, add: exact decision requested, options and verified cost, decision deadline, and named approver. These are not supplied by the historical extract.',
  'Check the result: compare the same confirmed cohort/promise after the action; show unserved trips, cancellations, exclusions and plan changes. Closure requires evidence.'
 ].join('\n\n');
}
Object.assign(C,{decisionPolicy,managerBrief});
})(typeof window!=='undefined'?window:globalThis);
(function(root){
'use strict';
const C=root.FleetCore;
const statuses=['Assigned','Investigating','Action agreed','Closed'];
function validDue(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))return false;
 const d=new Date(value+'+05:30');
 return Number.isFinite(d.valueOf())&&new Date(d.valueOf()+330*60000).toISOString().slice(0,16)===value;
}
function validateAction(raw){
 const a={};
 for(const [key,max] of [['owner',120],['action',1500],['evidence',3000]]){
  if(typeof raw[key]!=='string'||raw[key].length>max)throw Error('Action fields contain invalid or overly long text.');
  a[key]=raw[key].trim();
 }
 if(!a.owner)throw Error('Name one accountable person.');
 if(!a.action)throw Error('Write a specific next action.');
 if(!statuses.includes(raw.status))throw Error('Choose a valid action status.');
 if(!validDue(raw.due))throw Error('Enter a valid due date and time in IST.');
 if(raw.status==='Closed'&&!a.evidence)throw Error('Add the outcome and supporting evidence before closing.');
 return {...a,status:raw.status,due:raw.due};
}
function saveAction(previous,input,now=new Date().toISOString()){
 const a=validateAction(input);if(!Number.isFinite(Date.parse(now)))throw Error('Invalid save time.');
 const entry={...a,updatedAt:now,closedAt:a.status==='Closed'?(previous?.status==='Closed'?previous.closedAt:now):null};
 const history=[...(previous?.history||[]),{...entry}];
 return {...entry,history};
}
function validateBundle(raw,fingerprint,validKeys){
 if(!raw||raw.schema!==1||raw.fingerprint!==fingerprint)throw Error('This backup belongs to a different data extract or version.');
 if(!raw.actions||typeof raw.actions!=='object'||Array.isArray(raw.actions))throw Error('The backup has no valid action collection.');
 const actions=Object.create(null);const keys=Object.keys(raw.actions);
 if(keys.length>validKeys.size)throw Error('Backup has unexpected action records.');
 for(const key of keys){
  if(!validKeys.has(key))throw Error('Backup contains an unknown site or service model.');
  const value=raw.actions[key],fields=validateAction(value);
  if(!Number.isFinite(Date.parse(value.updatedAt)))throw Error('Backup has an invalid update time.');
  if(value.status==='Closed'&&(!Number.isFinite(Date.parse(value.closedAt))||Date.parse(value.closedAt)>Date.parse(value.updatedAt)))throw Error('Backup has an invalid closure time.');
  if(value.status!=='Closed'&&value.closedAt!==null)throw Error('Open actions cannot have a closure time.');
  if(!Array.isArray(value.history)||value.history.length>10000)throw Error('Backup history is invalid.');
  const history=value.history.map(h=>{
   const f=validateAction(h);if(!Number.isFinite(Date.parse(h.updatedAt)))throw Error('Backup history has invalid timestamps.');
   if(h.status==='Closed'&&(!Number.isFinite(Date.parse(h.closedAt))||Date.parse(h.closedAt)>Date.parse(h.updatedAt)))throw Error('Backup history has an invalid closure time.');
   if(h.status!=='Closed'&&h.closedAt!==null)throw Error('Backup history has an invalid closure time.');
   return {...f,updatedAt:h.updatedAt,closedAt:h.closedAt};
  });
  const current={...fields,updatedAt:value.updatedAt,closedAt:value.closedAt};
  if(!history.length||JSON.stringify(history[history.length-1])!==JSON.stringify(current))throw Error('Backup history does not match the current action.');
  if(history.some((h,i)=>i>0&&Date.parse(h.updatedAt)<Date.parse(history[i-1].updatedAt)))throw Error('Backup history is out of order.');
  actions[key]={...current,history};
 }
 return {schema:1,fingerprint,actions,rules:C.validateRules(raw.rules??C.defaults)};
}
Object.assign(C,{statuses,validDue,validateAction,saveAction,validateBundle});
})(typeof window!=='undefined'?window:globalThis);
(function(root){
'use strict';
root.FleetCore.recommendation=function(g,rules){
 const focus=['Login','Logout'].sort((a,b)=>g.directions[b].late-g.directions[a].late||(g.directions[b].late/(g.directions[b].n||1))-(g.directions[a].late/(g.directions[a].n||1))||g.directions[b].n-g.directions[a].n)[0];
 const rows=g.legs.filter(r=>r.eligible&&r.direction===focus), clocks=new Map();
 for(const r of rows){const clock=r.planned.slice(11,16);if(!clocks.has(clock))clocks.set(clock,{clock,n:0,late:0,days:new Set()});const c=clocks.get(clock);c.n++;if(r.delay>rules.grace){c.late++;c.days.add(r.date);}}
 const cohort=[...clocks.values()].filter(c=>c.n>=20).sort((a,b)=>b.late-a.late||b.late/b.n-a.late/a.n)[0]||null;
 const minutes=(end,start)=>(Date.parse(end.replace(' ','T')+'Z')-Date.parse(start.replace(' ','T')+'Z'))/60000;
 const median=values=>{const a=[...values].sort((x,y)=>x-y),i=Math.floor(a.length/2);return a.length%2?a[i]:(a[i-1]+a[i])/2;};
 const cohortRows=cohort?rows.filter(r=>r.planned.slice(11,16)===cohort.clock):[];
 const checked=cohortRows.filter(r=>{const actual=minutes(r.end,r.start),plan=minutes(r.plannedEnd,r.plannedStart);return actual>0&&actual<=720&&plan>0&&plan<=720;});
 const timing=focus==='Logout'&&checked.length&&checked.length===cohortRows.length?{n:checked.length,departure:median(checked.map(r=>minutes(r.start,r.plannedStart))),arrival:median(checked.map(r=>minutes(r.end,r.plannedEnd)))}:null;
 const signed=n=>(n>0?'+':'')+n;
 const nuance=timing&&cohort.late/cohort.n>=.5&&timing.arrival<=rules.grace?`For the same ${timing.n} legs, median departure deviation is ${signed(timing.departure)} min and median arrival deviation is ${signed(timing.arrival)} min. All pass the duration plausibility screen. Validate both promised milestones before choosing a change.`:'';
 const capacity=new Map();for(const r of g.legs.filter(r=>r.employees>r.capacity))capacity.set(r.cab,(capacity.get(r.cab)||0)+1);
 const capacityCab=[...capacity.entries()].sort((a,b)=>b[1]-a[1])[0]||null;
 const vendors=new Set(rows.map(r=>r.vendor)).size;
 const title=g.late===0?'Confirm coverage before drawing conclusions':`Start with ${focus==='Login'?'office arrivals':'office departures'}`;
 const detail=g.late===0?`${g.n} eligible legs; none exceed the selected ${rules.grace}-minute grace. ${g.n<rules.minLegs?'The sample is below the site-review floor.':'This is historical plan adherence only.'}`:cohort?`${cohort.late} of ${cohort.n} ${focus} legs planned for ${cohort.clock} are late, on ${cohort.days.size} operating dates.`:`${g.directions[focus].late} of ${g.directions[focus].n} ${focus} legs are late; no planned-time cohort has 20 legs.`;
 const action=g.late===0?'Confirm site mapping, data coverage and the agreed client promise before drawing a service conclusion. Collect the next comparable period, including missed and cancelled legs. No lateness intervention is justified by this sample alone.':focus==='Logout'?`Confirm the ${cohort?cohort.clock+' ':''}departure promise and planned-time definition. Compare cab-ready time, employee release and recorded departure with the site team and operators. Agree one correction after the evidence review.`:`Review ${cohort?cohort.clock+' planned ':''}arrivals against the client's arrival promise. Inspect actual pickup/departure and travel-time evidence for those legs. Agree one correction for the next comparable shift, keeping the client deadline unchanged.`;
 return {focus,cohort:cohort?{clock:cohort.clock,n:cohort.n,late:cohort.late,lateDays:cohort.days.size}:null,timing,nuance,capacityCab,vendors,title,detail,action};
};
})(typeof window!=='undefined'?window:globalThis);
