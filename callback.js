const API='https://doxomachy.matlabdec12.workers.dev';
const status=$=>document.querySelector($);
// The token lives in the URL fragment so it never reaches server request
// logs. Strip it from the address bar and history before using it.
const match=location.hash.match(/^#token=([A-Za-z0-9_-]{43})$/);
history.replaceState(null,'',location.pathname);
const setStatus=t=>{status('#callbackStatus').textContent=t};
const showLink=()=>{status('#callbackLink').hidden=false};
(async()=>{
 if(!match){setStatus('That link is invalid or expired. Request a new one.');showLink();return}
 try{
  const r=await fetch(API+'/v1/auth/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:match[1]})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||'request_failed');
  saveAccountToken(d.session,d.expiresIn);
  setStatus(`Signed in for 30 days on this device. Paid moves on this account: ${d.credits??0}.`);
 }catch{
  setStatus('That link is invalid or expired. Request a new one.');
 }
 showLink();
})();
