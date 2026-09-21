(function(){
 'use strict';
 let leaving=false,checking=false,expiresAt=0,expiryTimer;
 function clearNotes(){try{for(const key of Object.keys(localStorage))if(key.startsWith('fleet-review-v1:'))localStorage.removeItem(key);}catch{}}
 function leave(){
  if(leaving)return;leaving=true;
  document.body.innerHTML='<main class="wrap"><section class="panel" style="padding:28px;margin:32px auto;max-width:560px"><h1>Session locked</h1><p>Your session expired or access could not be verified. Saved notes remain in this browser; unsaved drafts may be lost.</p><p><a class="button" href="/">Reopen prototype</a></p><p class="small muted">The server will verify access again. Sign out after reopening if you want to clear saved notes.</p></section></main>';
  document.documentElement.style.visibility='';
  window.FLEET_DATA=undefined;
  window.dispatchEvent(new Event('fleet-session-ended'));
 }
 // This listener runs before the app's unsaved-draft guard. Explicit sign-out
 // and access expiry must not leave confidential data visible behind that guard.
 window.addEventListener('beforeunload',event=>{if(leaving)event.stopImmediatePropagation();});
 async function check(){
  if(leaving)return;if(expiresAt&&Date.now()>=expiresAt){leave();return;}if(checking)return;checking=true;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
  try{const response=await fetch('/session',{cache:'no-store',credentials:'same-origin',signal:controller.signal});const state=response.ok?await response.json():null;if(!state?.authenticated||!Number.isFinite(state.expiresAt)||state.expiresAt<=Date.now()){leave();return;}expiresAt=state.expiresAt;clearTimeout(expiryTimer);expiryTimer=setTimeout(leave,expiresAt-Date.now());}
  catch{leave();return;}
  finally{clearTimeout(timeout);checking=false;}
  document.documentElement.style.visibility='';
 }
 document.addEventListener('submit',event=>{if(event.target.id==='logout-form'){leaving=true;clearNotes();}});
 window.addEventListener('pageshow',event=>{if(event.persisted&&!leaving)document.documentElement.style.visibility='hidden';check();});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')check();});
 window.addEventListener('storage',event=>{if(event.key?.startsWith('fleet-review-v1:')&&event.newValue===null)check();});
 setInterval(check,60000);
})();
