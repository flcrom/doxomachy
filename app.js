const LIMIT = 1000;
const STARTER = [
  {id:'m1', text:'Useful software should explain what it changed.', author:'system', shields:4, created:Date.now()-86_400_000*4},
  {id:'m2', text:'A small memory makes every choice visible.', author:'system', shields:3, created:Date.now()-86_400_000*3},
  {id:'m3', text:'Attention is earned by consequences, not decoration.', author:'system', shields:2, created:Date.now()-86_400_000*2},
  {id:'m4', text:'Anything remembered can still be displaced.', author:'system', shields:1, created:Date.now()-86_400_000}
];
const $ = s => document.querySelector(s);
const store = {
  read(){ try{return JSON.parse(localStorage.getItem('doxomachy-state'))||{memories:STARTER,moves:5}}catch{return{memories:STARTER,moves:5}} },
  write(v){ localStorage.setItem('doxomachy-state',JSON.stringify(v)); }
};
let state=store.read();
const approxTokens=t=>Math.max(1,Math.ceil(t.trim().length/4));
const weight=m=>m.shields*1000 + m.created/1e10;
const used=()=>state.memories.reduce((n,m)=>n+approxTokens(m.text),0);
const ordered=()=>[...state.memories].sort((a,b)=>weight(b)-weight(a));
function weakest(){return [...state.memories].sort((a,b)=>weight(a)-weight(b))[0]}
function toast(msg){const el=$('#toast');el.textContent=msg;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>el.hidden=true,2600)}
function diary(){
  const top=ordered().slice(0,3);
  const bits=top.map(m=>m.text.replace(/[.!?]+$/,'').toLowerCase());
  if(!bits.length)return 'I woke without a single belief. The first sentence will decide what I become.';
  if(bits.length===1)return `Today I have room for one certainty: ${bits[0]}. Everything else is still open.`;
  return `Today I believe ${bits[0]}. I also believe ${bits[1]}${bits[2]?`, while ${bits[2]} remains harder to defend`:''}. My limits make these convictions temporary.`;
}
function enforceLimit(incoming){
  const evicted=[]; let total=used()+approxTokens(incoming.text);
  while(total>LIMIT&&state.memories.length){const w=weakest();state.memories=state.memories.filter(m=>m.id!==w.id);total-=approxTokens(w.text);evicted.push(w)}
  return evicted;
}
function render(changed){
  const list=$('#memoryList'); const items=ordered();
  list.innerHTML=items.length?items.map((m,i)=>`<li class="memory-item ${m.id===changed?'changed':''}" data-id="${m.id}"><span class="rank">${String(i+1).padStart(2,'0')}</span><div><p class="belief-text">${escapeHtml(m.text)}</p><p class="meta">${escapeHtml(m.author||'anonymous')} · ${approxTokens(m.text)} tokens</p></div><div class="actions"><button class="shield-button" data-protect="${m.id}" type="button">Protect</button><span class="shield-count">${m.shields} ${m.shields===1?'shield':'shields'}</span></div></li>`).join(''):`<li class="empty">No beliefs yet. The first sentence will define the mind.</li>`;
  const count=used(), pct=Math.min(100,Math.round(count/LIMIT*100));
  $('#capacityPercent').textContent=`${pct}%`;$('#meterFill').style.width=`${pct}%`;$('.meter').setAttribute('aria-valuenow',pct);$('#tokenCount').textContent=`${count} / ${LIMIT.toLocaleString()} tokens`;$('#movesLeft').textContent=state.moves;$('#weakest').textContent=weakest()?`#${String(items.findIndex(m=>m.id===weakest().id)+1).padStart(2,'0')}`:'—';
  const d=new Date();$('#diaryDate').textContent=d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});$('#diaryText').textContent=diary();$('#diarySources').textContent=items.slice(0,3).map((_,i)=>`Belief ${String(i+1).padStart(2,'0')}`).join(' · ');$('#updatedAt').textContent='Updated now';
  list.querySelectorAll('[data-protect]').forEach(b=>b.addEventListener('click',()=>protect(b.dataset.protect)));
  store.write(state);
}
function protect(id){
  if(state.moves<=0)return toast('No free moves remain on this device. Paid moves are not active.');
  const m=state.memories.find(x=>x.id===id);if(!m)return;m.shields++;state.moves--;render(id);toast(`Protected: “${m.text.slice(0,45)}${m.text.length>45?'…':''}”`);
}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
$('#openComposer').addEventListener('click',()=>{$('#composer').hidden=false;$('#beliefText').focus();$('#composer').scrollIntoView({behavior:'smooth',block:'start'})});
$('#closeComposer').addEventListener('click',()=>{$('#composer').hidden=true});
$('#beliefText').addEventListener('input',e=>{const n=e.target.value.length;$('#charCount').textContent=`${n} / 120`;const t=approxTokens(e.target.value),w=weakest();$('#evictionPreview').textContent=used()+t>LIMIT&&w?`Adding this will displace: “${w.text}”`:''});
$('#beliefForm').addEventListener('submit',e=>{e.preventDefault();if(state.moves<=0)return toast('No free moves remain on this device.');const text=$('#beliefText').value.trim();if(text.length<8)return toast('Write at least eight characters.');if(/https?:\/\/|www\./i.test(text))return toast('Links are not allowed in beliefs.');const m={id:`m${Date.now()}`,text,author:$('#alias').value.trim()||'anonymous',shields:1,created:Date.now()};const evicted=enforceLimit(m);state.memories.push(m);state.moves--;e.target.reset();$('#charCount').textContent='0 / 120';$('#evictionPreview').textContent='';$('#composer').hidden=true;render(m.id);toast(evicted.length?`Added. ${evicted.length} weak belief disappeared.`:'Belief added to the public mind.')});
$('#shareDiary').addEventListener('click',async()=>{const text=`Doxomachy diary\n\n${$('#diaryText').textContent}\n\nhttps://flcrom.github.io/doxomachy/`;try{await navigator.clipboard.writeText(text);toast('Diary copied.')}catch{toast('Copy failed. Select the diary text instead.')}});
render();
