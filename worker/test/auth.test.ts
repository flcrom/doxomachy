import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {worker,Mind} from '../src/index';
import {profileSql} from '../src/profile';
import {authSql,AUTH_LINK_TTL_MS,AUTH_SESSION_TTL_MS,AUTH_RATE_LIMIT_IP,allowedOrigins,isValidTokenFormat,normalizeEmail,pepperId,randomToken,reconcileAccountSpends,refundAccountCredit,resolveOrigin,settleAccountSpend,spendAccountCredit,validOrigin} from '../src/auth';

const ORIGIN='https://doxomachy.flcrom.dev';
const T0=1_800_000_000_000;
const ch=(n:number)=>({meta:{changes:n}});
type Row=Record<string,any>;

// In-memory D1 stand-in. batch() mirrors D1's transactional contract:
// statements run sequentially and a failure rolls the whole batch back.
class MockD1{
 accounts:Row[]=[];links:Row[]=[];sessions:Row[]=[];rates=new Map<string,Row>();credits=new Map<string,number>();spends=new Map<string,Row>();meta=new Map<string,Row>();freeUsed=new Map<string,number>();intents:Row[]=[];beforeBatch?:()=>void;
 failBatchAt=-1;batchCalls=0;
 prepare(sql:string){const db=this;return {bind(...p:any[]){return {__sql:sql,__params:p,run:async()=>db.exec(sql,p),first:async()=>db.one(sql,p),all:async()=>({results:db.all(sql,p)})}}}}
 async batch(stmts:any[]){
  this.batchCalls++;
  this.beforeBatch?.(); // model a concurrent transaction committing before ours
  const snap=JSON.stringify({accounts:this.accounts,links:this.links,sessions:this.sessions,rates:[...this.rates],credits:[...this.credits],spends:[...this.spends],meta:[...this.meta],freeUsed:[...this.freeUsed]});
  const out=[];
  for(let i=0;i<stmts.length;i++){
   if(i===this.failBatchAt&&stmts[0].__sql===authSql.verifyConsume){this.restore(snap);throw new Error('d1_batch_failure')}
   try{out.push(await this.exec(stmts[i].__sql,stmts[i].__params))}catch(e){this.restore(snap);throw e}
  }
  return out;
 }
 private restore(snap:string){const d=JSON.parse(snap);this.accounts=d.accounts;this.links=d.links;this.sessions=d.sessions;this.rates=new Map(d.rates);this.credits=new Map(d.credits);this.spends=new Map(d.spends);this.meta=new Map(d.meta);this.freeUsed=new Map(d.freeUsed)}
 exec(sql:string,p:any[]){
  switch(sql){
   case authSql.prune[0]:{const n=this.links.length;this.links=this.links.filter(r=>r.expires_at>p[0]);return ch(n-this.links.length)}
   case authSql.prune[1]:{const n=this.sessions.length;this.sessions=this.sessions.filter(r=>r.expires_at>p[0]);return ch(n-this.sessions.length)}
   case authSql.prune[2]:{let n=0;for(const [k,r] of this.rates)if(p[0]-r.window_start>=p[1]){this.rates.delete(k);n++}return ch(n)}
   case authSql.prune[3]:{let n=0;for(const [k,r] of this.spends)if(r.status!=='pending'&&p[0]-r.created_at>=p[1]){this.spends.delete(k);n++}return ch(n)}
   case authSql.prune[4]:{let n=0;for(const k of [...this.meta.keys()])if(!this.spends.has(k)){this.meta.delete(k);n++}return ch(n)}
   case authSql.rateEnsure:{if(this.rates.has(p[0]))return ch(0);this.rates.set(p[0],{key:p[0],count:0,window_start:p[1]});return ch(1)}
   case authSql.rateReset:{const r=this.rates.get(p[1]);if(r&&p[2]-r.window_start>=p[3]){r.count=0;r.window_start=p[0];return ch(1)}return ch(0)}
   case authSql.rateHit:{const r=this.rates.get(p[0]);if(r&&r.count<p[1]){r.count++;return ch(1)}return ch(0)}
   case authSql.rateRefund:{const r=this.rates.get(p[0]);if(r&&r.count>0){r.count--;return ch(1)}return ch(0)}
   case authSql.accountUpsert:{if(this.accounts.some(a=>a.email_hmac===p[1]))return ch(0);this.accounts.push({id:p[0],email_hmac:p[1],pepper_id:p[2],created_at:p[3]});return ch(1)}
   case authSql.accountRekey:{const r=this.accounts.find(a=>a.email_hmac===p[2]);if(r){r.email_hmac=p[0];r.pepper_id=p[1];return ch(1)}return ch(0)}
   case authSql.linkInsert:{this.links.push({token_hash:p[0],account_id:p[1],email_hmac:p[2],expires_at:p[3],consumed_at:null,consume_key:null,created_at:p[4]});return ch(1)}
   case authSql.linkDeleteUnused:{const n=this.links.length;this.links=this.links.filter(r=>!(r.token_hash===p[0]&&r.consumed_at===null));return ch(n-this.links.length)}
   case authSql.verifyConsume:{const r=this.links.find(x=>x.token_hash===p[2]);if(r&&r.consumed_at===null&&r.expires_at>p[3]){r.consumed_at=p[0];r.consume_key=p[1];return ch(1)}return ch(0)}
   case authSql.verifySession:{const l=this.links.find(x=>x.consume_key===p[3]);if(l){this.sessions.push({token_hash:p[0],account_id:l.account_id,created_at:p[1],expires_at:p[2],revoked_at:null});return ch(1)}return ch(0)}
   case authSql.sessionRevokeOne:{const r=this.sessions.find(x=>x.token_hash===p[1]);if(r&&r.revoked_at===null){r.revoked_at=p[0];return ch(1)}return ch(0)}
   case authSql.creditSpendGuarded:{const r=this.spends.get(p[4]);const b=this.credits.get(p[2])||0;if(r&&r.resolver===p[5]&&b>=p[3]){this.credits.set(p[2],b-p[0]);return ch(1)}return ch(0)}
   case authSql.creditDelete:{const b=this.credits.get(p[0]);if(b!==undefined&&b<=p[1]){this.credits.delete(p[0]);return ch(1)}return ch(0)}
   case authSql.paidSpendInsert:{if(this.spends.has(p[0]))return ch(0);if(!this.credits.has(p[4])||(this.credits.get(p[4])||0)<p[5])return ch(0);this.spends.set(p[0],{key:p[0],account_id:p[1],status:'pending',created_at:p[2],resolved_at:null,resolver:p[3]});return ch(1)}
   case authSql.freeSpendInsert:{if(this.spends.has(p[0]))return ch(0);if((this.freeUsed.get(p[4])||0)>=p[5])return ch(0);this.spends.set(p[0],{key:p[0],account_id:p[1],status:'pending',created_at:p[2],resolved_at:null,resolver:p[3]});return ch(1)}
   case authSql.spendMetaInsert:{const r=this.spends.get(p[3]);if(!r||r.resolver!==p[4]||this.meta.has(p[0]))return ch(0);this.meta.set(p[0],{key:p[0],kind:p[1],amount:p[2]});return ch(1)}
   case authSql.freeShieldUse:{const r=this.spends.get(p[2]);if(!r||r.resolver!==p[3])return ch(0);this.freeUsed.set(p[0],(this.freeUsed.get(p[0])||0)+1);return ch(1)}
   case authSql.freeShieldRefundGuarded:{const r=this.spends.get(p[2]);const m=this.meta.get(p[4]);const u=this.freeUsed.get(p[1])||0;if(r&&r.resolver===p[3]&&m?.kind==='free_shield'&&u>0){this.freeUsed.set(p[1],u-1);return ch(1)}return ch(0)}
   case authSql.deleteAccountSpendMeta:{let n=0;for(const [k,r] of this.spends)if(r.account_id===p[0]&&this.meta.delete(k))n++;return ch(n)}
   case authSql.deleteAccountFreeShields:{return ch(this.freeUsed.delete(p[0])?1:0)}
   case authSql.deleteAccountIntents:{const n=this.intents.length;this.intents=this.intents.filter(r=>r.account_id!==p[0]);return ch(n-this.intents.length)}
   case authSql.deleteAccountProfile:{return ch(0)}
   case authSql.tombstoneAccount:{const r=this.accounts.find(a=>a.id===p[0]);if(r){r.email_hmac='deleted:'+r.id;r.pepper_id='';return ch(1)}return ch(0)}
   case authSql.paidSpendClaim:{const r=this.spends.get(p[3]);if(r&&r.status==='pending'){r.status=p[0];r.resolved_at=p[1];r.resolver=p[2];return ch(1)}return ch(0)}
   case authSql.paidSpendRefundGuarded:{const r=this.spends.get(p[3]);const m=this.meta.get(p[0]);if(r&&r.resolver===p[4]&&m?.kind!=='free_shield'){this.credits.set(p[2],(this.credits.get(p[2])||0)+(m?.amount??1));return ch(1)}return ch(0)}
   case authSql.deleteAccountSessions:{const n=this.sessions.length;this.sessions=this.sessions.filter(r=>r.account_id!==p[0]);return ch(n-this.sessions.length)}
   case authSql.deleteAccountLinks:{const n=this.links.length;this.links=this.links.filter(r=>r.account_id!==p[0]);return ch(n-this.links.length)}
   case authSql.deleteAccountSpends:{let n=0;for(const [k,r] of this.spends)if(r.account_id===p[0]){this.spends.delete(k);n++}return ch(n)}
   case authSql.deleteAccountRates:{const had=this.rates.delete(p[0]);return ch(had?1:0)}
  }
  throw new Error('unexpected sql: '+sql);
 }
 one(sql:string,p:any[]){
  switch(sql){
   case profileSql.select:{return null}
   case authSql.accountSelect:{const r=this.accounts.find(a=>a.email_hmac===p[0]);return r?{id:r.id}:null}
   case authSql.linkAccount:{const r=this.links.find(x=>x.token_hash===p[0]);return r?{account_id:r.account_id}:null}
   case authSql.sessionSelect:{const r=this.sessions.find(x=>x.token_hash===p[0]&&x.revoked_at===null&&x.expires_at>p[1]);return r?{account_id:r.account_id,expires_at:r.expires_at}:null}
   case authSql.creditsSelect:{return this.credits.has(p[0])?{balance:this.credits.get(p[0])}:null}
   case authSql.accountHmac:{const r=this.accounts.find(a=>a.id===p[0]);return r?{email_hmac:r.email_hmac}:null}
   case authSql.freeShieldsUsed:{return this.freeUsed.has(p[0])?{used:this.freeUsed.get(p[0])}:null}
   case authSql.paidSpendStatus:{const r=this.spends.get(p[0]);return r?{status:r.status}:null}
  }
  throw new Error('unexpected sql: '+sql);
 }
 all(sql:string,p:any[]):Row[]{
  switch(sql){
   case authSql.paidSpendPending:{return [...this.spends.values()].filter(r=>r.account_id===p[0]&&r.status==='pending'&&r.created_at<p[1]).slice(0,10).map(r=>({key:r.key,created_at:r.created_at}))}
   case authSql.paidSpendPendingAccounts:{return [...new Set([...this.spends.values()].filter(r=>r.status==='pending'&&r.created_at<p[0]).map(r=>r.account_id))].slice(0,25).map(account_id=>({account_id}))}
  }
  throw new Error('unexpected sql: '+sql);
 }
}

let doCalls:any[];
let doApplied:Set<string>;
let doResponse:()=>Response;
function makeEnv(db:MockD1,over:Record<string,any>={}):any{
 return {WEB_ORIGIN:ORIGIN,WEB_ORIGIN_EXTRA:'https://doxomachy.vercel.app',DIARY_MODEL:'m',RESEND_API_KEY:'re_test',AUTH_EMAIL_PEPPER:'test-pepper',AUTH_FROM:'Doxomachy <login@doxomachy.flcrom.dev>',DB:db,
  MIND:{idFromName:()=>({}),get:()=>({fetch:async(input:any,init:any)=>{
   const req=new Request(input,init);
   if(new URL(req.url).pathname==='/internal/idempotency'){
    if(req.headers.get('x-internal-reconcile')!=='1')return new Response('{"error":"not_found"}',{status:404,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({applied:doApplied.has(new URL(req.url).searchParams.get('key')||'')}),{status:200,headers:{'content-type':'application/json'}});
   }
   doCalls.push({req});
   const res=doResponse();
   if(res.status<400&&req.headers.get('x-paid-move')==='1')doApplied.add(req.headers.get('x-session-id')+':'+req.headers.get('idempotency-key'));
   return res;
  }})},AI:{},...over};
}
const j=async(r:Response):Promise<any>=>await (r.json() as Promise<any>);
const post=(path:string,body:unknown,ip='203.0.113.7')=>new Request('https://api.example'+path,{method:'POST',headers:{Origin:ORIGIN,'content-type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify(body)});
const authed=(path:string,method:string,token:string)=>new Request('https://api.example'+path,{method,headers:{Origin:ORIGIN,authorization:`Bearer ${token}`}});
const paidPost=(path:string,token:string,idem='idem-key-0000000001')=>new Request('https://api.example'+path,{method:'POST',headers:{Origin:ORIGIN,'content-type':'application/json',authorization:`Bearer ${token}`,'idempotency-key':idem},body:JSON.stringify({text:'a calm useful belief',alias:'qa'})});

let sent:{from:string;to:string[];subject:string;text:string;html:string}[];
let failSend=false;

beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(T0);
 sent=[];failSend=false;doCalls=[];doApplied=new Set();
 doResponse=()=>new Response(JSON.stringify({belief:{id:'b1'},mind:{beliefs:[],cycle:1},moves:undefined}),{status:201,headers:{'content-type':'application/json'}});
 vi.stubGlobal('fetch',async(_url:any,init:any)=>{const b=JSON.parse(init.body);if(!failSend)sent.push(b);return new Response(failSend?'{}':'{"id":"email_1"}',{status:failSend?500:200})});
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()});

async function requestLink(db:MockD1,email='person@example.com',ip?:string){return worker.fetch(post('/v1/auth/magic-link',{email},ip),makeEnv(db))}
function lastToken(){const link=sent[sent.length-1].text.match(/#token=([A-Za-z0-9_-]{43})/);return link?link[1]:''}
async function verify(db:MockD1,token:string){return worker.fetch(post('/v1/auth/verify',{token}),makeEnv(db))}
async function signIn(db:MockD1,email='person@example.com'){await requestLink(db,email);return j(await verify(db,lastToken()))}

describe('email normalization, token format and origin allowlist',()=>{
 it('normalizes case, whitespace and rejects malformed input',()=>{
  expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
  expect(normalizeEmail('a@b.co')).toBe('a@b.co');
  for(const bad of ['',42,null,'no-at-sign','a@b','a@','@b.com','a@@b.com','a b@c.com'])expect(normalizeEmail(bad)).toBe('');
 });
 it('mints 43-character base64url tokens',()=>{
  const t=randomToken();expect(t).toHaveLength(43);expect(isValidTokenFormat(t)).toBe(true);
  expect(isValidTokenFormat('short')).toBe(false);expect(isValidTokenFormat(t+'!')).toBe(false);expect(isValidTokenFormat(undefined)).toBe(false);
 });
 it('accepts only exact allowlisted HTTPS origins',()=>{
  const env=makeEnv(new MockD1());
  expect(validOrigin('https://doxomachy.flcrom.dev')).toBe(true);
  expect(validOrigin('http://doxomachy.flcrom.dev')).toBe(false);
  expect(validOrigin('https://doxomachy.flcrom.dev/')).toBe(false);
  expect(validOrigin('javascript:alert(1)')).toBe(false);
  expect(allowedOrigins(env)).toEqual(['https://doxomachy.flcrom.dev','https://doxomachy.vercel.app']);
  expect(resolveOrigin(env,'https://doxomachy.vercel.app')).toBe('https://doxomachy.vercel.app');
  expect(resolveOrigin(env,'https://evil.example')).toBeUndefined();
  expect(resolveOrigin(env,'https://doxomachy.flcrom.dev.evil.example')).toBeUndefined();
 });
});

describe('magic-link requests',()=>{
 it('stores no plaintext email and only the token hash',async()=>{
  const db=new MockD1();
  const res=await requestLink(db,'Person@Example.com');
  expect(res.status).toBe(200);
  expect(sent).toHaveLength(1);expect(sent[0].to).toEqual(['person@example.com']);
  const dump=JSON.stringify({accounts:db.accounts,links:db.links,sessions:db.sessions});
  expect(dump).not.toContain('person@example.com');expect(dump).not.toContain('Person@Example.com');
  expect(db.links).toHaveLength(1);
  expect(db.links[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(db.links[0].token_hash).not.toBe(lastToken());
  expect(db.links[0].expires_at).toBe(T0+AUTH_LINK_TTL_MS);
  expect(db.links[0].account_id).toBe(db.accounts[0].id);
  expect(db.accounts[0].pepper_id).toBe(await pepperId('test-pepper'));
 });
 it('answers identically for any deliverable-looking address and never reveals state',async()=>{
  const db=new MockD1();
  const a=await requestLink(db,'first@example.com');const b=await requestLink(db,'second@example.com');
  expect(a.status).toBe(b.status);expect(await a.text()).toBe(await b.text());
 });
 it('rejects malformed email without sending',async()=>{
  const db=new MockD1();
  const res=await requestLink(db,'not-an-email');
  expect(res.status).toBe(400);expect(sent).toHaveLength(0);expect(db.links).toHaveLength(0);
 });
 it('fails closed when auth is not configured',async()=>{
  const db=new MockD1();
  for(const missing of ['RESEND_API_KEY','AUTH_EMAIL_PEPPER','AUTH_FROM']){
   const env=makeEnv(db);delete env[missing];
   const res=await worker.fetch(post('/v1/auth/magic-link',{email:'person@example.com'}),env);
   expect(res.status).toBe(503);expect((await j(res)).error).toBe('auth_not_configured');
  }
  const env=makeEnv(db,{WEB_ORIGIN:'http://insecure.example',WEB_ORIGIN_EXTRA:ORIGIN});
  expect((await worker.fetch(post('/v1/auth/magic-link',{email:'person@example.com'}),env)).status).toBe(503);
  expect(sent).toHaveLength(0);expect(db.links).toHaveLength(0);
 });
 it('caps requests per email at 5/hour while answering generically',async()=>{
  const db=new MockD1();
  await Promise.all(Array.from({length:8},()=>requestLink(db,'same@example.com')));
  expect(sent).toHaveLength(5);expect(db.links).toHaveLength(5);
  const res=await requestLink(db,'same@example.com');
  expect(res.status).toBe(200);expect(sent).toHaveLength(5);
  vi.setSystemTime(T0+3_600_001);
  await requestLink(db,'same@example.com');
  expect(sent).toHaveLength(6);
 });
 it('uses a generous per-IP backstop so shared NAT/campus networks are not locked out',async()=>{
  const db=new MockD1();
  // 60 distinct addresses from one shared IP all get through; the 61st is stopped.
  for(let i=0;i<AUTH_RATE_LIMIT_IP;i++)await requestLink(db,`user${i}@example.com`);
  expect(sent).toHaveLength(60);
  await requestLink(db,'user60@example.com');
  expect(sent).toHaveLength(60);
  // the rejected request must not have burned its per-email bucket
  await requestLink(db,'user60@example.com','198.51.100.9');
  expect(sent).toHaveLength(61);
 });
 it('deletes the challenge when delivery fails and still answers generically',async()=>{
  const db=new MockD1();failSend=true;
  const res=await requestLink(db);
  expect(res.status).toBe(200);expect(db.links).toHaveLength(0);
 });
});

describe('verification, expiry, replay and concurrent sign-ins',()=>{
 it('verifies a link once, creates the account and a 30-day session',async()=>{
  const db=new MockD1();
  await requestLink(db);
  const res=await verify(db,lastToken());
  expect(res.status).toBe(200);
  const body=await j(res);
  expect(isValidTokenFormat(body.session)).toBe(true);
  expect(body.expiresIn).toBe(AUTH_SESSION_TTL_MS/1000);
  expect(body.credits).toBe(0);
  expect(db.accounts).toHaveLength(1);
  expect(db.sessions).toHaveLength(1);
  expect(db.sessions[0].token_hash).not.toBe(body.session);
  expect(db.sessions[0].expires_at).toBe(T0+AUTH_SESSION_TTL_MS);
  const replay=await verify(db,sent[0].text.match(/#token=([A-Za-z0-9_-]{43})/)![1]);
  expect(replay.status).toBe(401);
  expect(db.sessions).toHaveLength(1);
 });
 it('lets exactly one of two concurrent verifications of the same link succeed',async()=>{
  const db=new MockD1();
  await requestLink(db);
  const token=lastToken();
  const [a,b]=await Promise.all([verify(db,token),verify(db,token)]);
  expect([a.status,b.status].sort()).toEqual([200,401]);
  expect(db.sessions.filter(s=>s.revoked_at===null)).toHaveLength(1);
 });
 it('lets two devices sign in at once and keeps both sessions live',async()=>{
  const db=new MockD1();
  await requestLink(db);const t1=lastToken();
  await requestLink(db);const t2=lastToken();
  const [a,b]=await Promise.all([verify(db,t1),verify(db,t2)]);
  expect([a.status,b.status].sort()).toEqual([200,200]);
  expect(db.sessions.filter(s=>s.revoked_at===null)).toHaveLength(2);
 });
 it('rolls the whole verify batch back on partial D1 failure: no burned link',async()=>{
  for(const failAt of [0,1]){
   const db=new MockD1();db.failBatchAt=failAt;
   await requestLink(db);
   const token=lastToken();
   const failed=await verify(db,token);expect(failed.status).toBe(500); // observability wrapper converts the batch failure into a 500
   const row=db.links[0];
   expect(row.consumed_at).toBeNull();
   expect(row.consume_key).toBeNull();
   expect(db.sessions).toHaveLength(0);
   db.failBatchAt=-1;
   expect((await verify(db,token)).status).toBe(200); // link still usable
  }
 });
 it('is fail-closed at the exact expiry boundary',async()=>{
  const db=new MockD1();
  await requestLink(db,'boundary@example.com');
  const token=lastToken();
  vi.setSystemTime(T0+AUTH_LINK_TTL_MS);
  expect((await verify(db,token)).status).toBe(401);
  vi.setSystemTime(T0);
  await requestLink(db,'boundary2@example.com');
  const token2=lastToken();
  vi.setSystemTime(T0+AUTH_LINK_TTL_MS-1);
  expect((await verify(db,token2)).status).toBe(200);
 });
 it('rejects malformed tokens without touching storage',async()=>{
  const db=new MockD1();
  for(const bad of ['','abc','x'.repeat(44),'!!!!!!!!!'])
   expect((await verify(db,bad)).status).toBe(401);
  expect(db.sessions).toHaveLength(0);
 });
});

describe('account-bound sessions, credits and sign-out',()=>{
 it('signs in a second device without disturbing the first and keeps credits',async()=>{
  const db=new MockD1();
  const first=await signIn(db);
  db.credits.set(db.accounts[0].id,5);
  vi.setSystemTime(T0+1000);
  const second=await signIn(db);
  expect(db.accounts).toHaveLength(1);
  expect(second.credits).toBe(5);
  const old=await worker.fetch(authed('/v1/auth/session','GET',first.session),makeEnv(db));
  expect(old.status).toBe(200); // no epoch bump: the first device stays signed in
  const live=await worker.fetch(authed('/v1/auth/session','GET',second.session),makeEnv(db));
  expect(live.status).toBe(200);expect((await j(live)).credits).toBe(5);
 });
 it('serves account-bound credits only to a live bearer',async()=>{
  const db=new MockD1();
  expect((await worker.fetch(authed('/v1/credits','GET','nope'),makeEnv(db))).status).toBe(401);
  expect((await worker.fetch(new Request('https://api.example/v1/credits',{headers:{Origin:ORIGIN}}),makeEnv(db))).status).toBe(401);
  const {session}=await signIn(db);
  db.credits.set(db.accounts[0].id,7);
  const res=await worker.fetch(authed('/v1/credits','GET',session),makeEnv(db));
  expect(res.status).toBe(200);expect((await j(res)).credits).toBe(7);
 });
 it('revokes the current session on demand',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  expect((await worker.fetch(authed('/v1/auth/session','DELETE',session),makeEnv(db))).status).toBe(200);
  expect((await worker.fetch(authed('/v1/auth/session','GET',session),makeEnv(db))).status).toBe(401);
  expect((await worker.fetch(authed('/v1/auth/session','DELETE',session),makeEnv(db))).status).toBe(401);
 });
 it('has no sign-out-all route; signing out one device leaves the others signed in',async()=>{
  const db=new MockD1();
  const first=await signIn(db,'one@example.com');
  const second=await signIn(db,'one@example.com'); // same account, second device
  expect((await worker.fetch(authed('/v1/auth/sessions','DELETE',first.session),makeEnv(db))).status).toBe(404);
  expect((await worker.fetch(authed('/v1/auth/session','DELETE',first.session),makeEnv(db))).status).toBe(200);
  expect((await worker.fetch(authed('/v1/auth/session','GET',first.session),makeEnv(db))).status).toBe(401);
  expect((await worker.fetch(authed('/v1/auth/session','GET',second.session),makeEnv(db))).status).toBe(200);
 });
 it('expires sessions at the 30-day boundary',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  vi.setSystemTime(T0+AUTH_SESSION_TTL_MS-1);
  expect((await worker.fetch(authed('/v1/auth/session','GET',session),makeEnv(db))).status).toBe(200);
  vi.setSystemTime(T0+AUTH_SESSION_TTL_MS);
  expect((await worker.fetch(authed('/v1/auth/session','GET',session),makeEnv(db))).status).toBe(401);
 });
 it('resolves accounts through the previous pepper during rotation and lazily re-keys',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db); // pepper 'test-pepper'
  const before=db.accounts[0].email_hmac;
  const rotated=makeEnv(db,{AUTH_EMAIL_PEPPER:'new-pepper',AUTH_EMAIL_PEPPER_PREVIOUS:'test-pepper'});
  const res=await worker.fetch(post('/v1/auth/magic-link',{email:'person@example.com'}),rotated);
  expect(res.status).toBe(200);expect(sent).toHaveLength(2);
  const v=await worker.fetch(post('/v1/auth/verify',{token:lastToken()}),rotated);
  expect(v.status).toBe(200);
  expect(db.accounts).toHaveLength(1);
  expect(db.accounts[0].email_hmac).not.toBe(before); // re-keyed to the new pepper
  expect(db.accounts[0].pepper_id).toBe(await pepperId('new-pepper')); // rotation bookkeeping updated
  expect((await worker.fetch(authed('/v1/auth/session','GET',session),rotated)).status).toBe(200); // existing sessions are untouched by rotation
 });
 it('keeps a dormant paid account resolvable as long as the previous pepper is retained',async()=>{
  const db=new MockD1();
  await signIn(db);
  db.credits.set(db.accounts[0].id,9);
  // user goes dormant; pepper rotates; runbook keeps PREVIOUS because rows lag
  const rotated=makeEnv(db,{AUTH_EMAIL_PEPPER:'new-pepper',AUTH_EMAIL_PEPPER_PREVIOUS:'test-pepper'});
  vi.setSystemTime(T0+200*86_400_000); // 200 days later, long past any window
  const res=await worker.fetch(post('/v1/auth/magic-link',{email:'person@example.com'}),rotated);
  expect(res.status).toBe(200);
  const body=await j(await worker.fetch(post('/v1/auth/verify',{token:lastToken()}),rotated));
  expect(body.credits).toBe(9); // credits found, not orphaned
  expect(db.accounts).toHaveLength(1);
  expect(db.accounts[0].pepper_id).toBe(await pepperId('new-pepper'));
 });
});

describe('account deletion',()=>{
 it('refuses deletion while paid moves remain',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  db.credits.set(db.accounts[0].id,3);
  const res=await worker.fetch(authed('/v1/auth/account','DELETE',session),makeEnv(db));
  expect(res.status).toBe(409);expect((await j(res)).error).toBe('credits_remaining');
  expect(db.accounts).toHaveLength(1);
 });
 it('deletes an account on our side: tombstones the row, removes sessions, links, spends and balance',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id,hmac=db.accounts[0].email_hmac;
  db.credits.set(id,0);db.freeUsed.set(id,2);
  db.spends.set('paid:'+id+':x',{key:'paid:'+id+':x',account_id:id,status:'spent',created_at:T0,resolved_at:T0});
  db.meta.set('paid:'+id+':x',{key:'paid:'+id+':x',kind:'credit',amount:2});
  const res=await worker.fetch(authed('/v1/auth/account','DELETE',session),makeEnv(db));
  expect(res.status).toBe(200);
  expect(db.accounts).toHaveLength(1);expect(db.accounts[0].email_hmac).toBe('deleted:'+id);expect(JSON.stringify(db.accounts)).not.toContain(hmac);
  expect(db.sessions).toHaveLength(0);expect(db.links).toHaveLength(0);expect(db.spends.size).toBe(0);expect(db.meta.size).toBe(0);expect(db.freeUsed.has(id)).toBe(false);
  expect(db.credits.has(id)).toBe(false);
  expect((await worker.fetch(authed('/v1/auth/session','GET',session),makeEnv(db))).status).toBe(401);
  // Signing up again with the same email creates a fresh account.
  const again=await signIn(db);expect(again.ok).toBe(true);expect(db.accounts).toHaveLength(2);expect(again.free_shields).toBe(3);
 });
});

describe('paid gameplay spend',()=>{
 it('spends one credit atomically, forwards a marked request to the Durable Object and settles spent',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  db.credits.set(db.accounts[0].id,3);
  const res=await worker.fetch(paidPost('/v1/beliefs',session),makeEnv(db));
  expect(res.status).toBe(201);
  expect(res.headers.get('x-account-credits')).toBe('1'); // a belief costs 2 credits by default
  expect(res.headers.get('x-free-shields')).toBe('3');
  expect(db.credits.get(db.accounts[0].id)).toBe(1);
  expect(doCalls).toHaveLength(1);
  expect(doCalls[0].req.headers.get('x-paid-move')).toBe('1');
  expect(doCalls[0].req.headers.get('x-session-id')).toBe('paid:'+db.accounts[0].id);
  expect(db.spends.get('paid:'+db.accounts[0].id+':idem-key-0000000001')!.status).toBe('spent');
 });
 it('does not double-spend on an idempotent replay',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  db.credits.set(db.accounts[0].id,3);
  await worker.fetch(paidPost('/v1/beliefs',session),makeEnv(db));
  const replay=await worker.fetch(paidPost('/v1/beliefs',session),makeEnv(db));
  expect(replay.status).toBe(201);
  expect(db.credits.get(db.accounts[0].id)).toBe(1);
 });
 it('rejects spend with no credits and leaves no idempotency marker behind',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const res=await worker.fetch(paidPost('/v1/beliefs',session),makeEnv(db));
  expect(res.status).toBe(402);expect(doCalls).toHaveLength(0);
  expect(db.spends.size).toBe(0);
  expect((await worker.fetch(paidPost('/v1/beliefs',session),makeEnv(db))).status).toBe(402);
 });
 it('refunds and marks the spend refunded when the Durable Object write fails',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  db.credits.set(db.accounts[0].id,2);
  doResponse=()=>new Response('{"error":"boom"}',{status:500});
  const res=await worker.fetch(paidPost('/v1/beliefs',session),makeEnv(db));
  expect(res.status).toBe(500);
  expect(db.credits.get(db.accounts[0].id)).toBe(2);
  const spend=db.spends.get('paid:'+db.accounts[0].id+':idem-key-0000000001')!;
  expect(spend.status).toBe('refunded');
  // a refunded key is consumed: replaying it must not apply a free move
  const retry=await worker.fetch(paidPost('/v1/beliefs',session),makeEnv(db));
  expect(retry.status).toBe(409);
  expect(db.credits.get(db.accounts[0].id)).toBe(2);
 });
 it('recovers a crash between the D1 decrement and the Durable Object call: refund path',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,1);
  const spend=await spendAccountCredit(makeEnv(db),id,'crash-key-000000001',T0-120_000); // worker "crashed" before the DO call
  expect(spend).toEqual({ok:true,replay:false});
  expect(db.credits.get(id)).toBe(0);
  const res=await worker.fetch(authed('/v1/credits','GET',session),makeEnv(db));
  expect(res.status).toBe(200);
  expect((await j(res)).credits).toBe(1); // refunded by reconciliation
  expect(db.spends.get('paid:'+id+':crash-key-000000001')!.status).toBe('refunded');
 });
 it('recovers a crash between the D1 decrement and the Durable Object call: applied path',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,1);
  await spendAccountCredit(makeEnv(db),id,'crash-key-000000002',T0-120_000);
  doApplied.add('paid:'+id+':crash-key-000000002'); // the DO actually applied the move before the worker died
  const res=await worker.fetch(authed('/v1/credits','GET',session),makeEnv(db));
  expect((await j(res)).credits).toBe(0); // not refunded: the move happened
  expect(db.spends.get('paid:'+id+':crash-key-000000002')!.status).toBe('spent');
 });
 it('rejects unknown or revoked bearers without touching credits',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  db.credits.set(db.accounts[0].id,2);
  expect((await worker.fetch(paidPost('/v1/beliefs','not-a-real-token-00000000000000000000000000'),makeEnv(db))).status).toBe(401);
  await worker.fetch(authed('/v1/auth/session','DELETE',session),makeEnv(db));
  expect((await worker.fetch(paidPost('/v1/beliefs',session),makeEnv(db))).status).toBe(401);
  expect(db.credits.get(db.accounts[0].id)).toBe(2);expect(doCalls).toHaveLength(0);
 });
 it('refuses every move without an account and never reaches the Durable Object',async()=>{
  const db=new MockD1();
  const res=await worker.fetch(post('/v1/beliefs',{text:'a calm useful belief',alias:'qa'}),makeEnv(db));
  expect(res.status).toBe(401);expect((await j(res)).error).toBe('account_required');
  const shield=await worker.fetch(post('/v1/beliefs/00000000-0000-4000-8000-000000000000/protect',{}),makeEnv(db));
  expect(shield.status).toBe(401);
  const sess=await worker.fetch(post('/v1/session',{}),makeEnv(db));
  expect(sess.status).toBe(410);
  expect(doCalls).toHaveLength(0);
 });
});

describe('Durable Object paid-move gate',()=>{
 function makeMind(){
  const storage=new Map<string,any>();
  const state:any={storage:{get:async(k:string)=>storage.get(k),put:async(k:string,v:any)=>{storage.set(k,v)}},getWebSockets:()=>[],blockConcurrencyWhile:(fn:()=>Promise<void>)=>{void fn()}};
  const env:any={DB:{prepare:()=>({bind:()=>({first:async()=>null})})},DIARY_MODEL:'m'};
  return new Mind(state,env);
 }
 const beliefReq=(headers:Record<string,string>)=>new Request('https://mind.internal/v1/beliefs',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'0123456789abcdef',...headers},body:JSON.stringify({text:'a calm useful belief',alias:'qa'})});
 it('accepts a worker-marked paid move without a device session',async()=>{
  const mind=makeMind();
  const res=await mind.fetch(beliefReq({'x-paid-move':'1','x-session-id':'paid:acc-1'}));
  expect(res.status).toBe(201);
 });
 it('rejects the same request without the worker mark',async()=>{
  const mind=makeMind();
  const res=await mind.fetch(beliefReq({'x-session-id':'paid:acc-1'}));
  expect(res.status).toBe(401);
 });
 it('reports idempotency state to the reconciler through the internal endpoint only',async()=>{
  const mind=makeMind();
  const key='paid:acc-1:0123456789abcdef';
  const ask=(headers:Record<string,string>)=>mind.fetch(new Request('https://mind.internal/internal/idempotency?key='+encodeURIComponent(key),{headers}));
  expect((await ask({})).status).toBe(404); // no internal header: not found
  const before=await j(await ask({'x-internal-reconcile':'1'}));
  expect(before.applied).toBe(false);
  await mind.fetch(beliefReq({'x-paid-move':'1','x-session-id':'paid:acc-1'}));
  const after=await j(await ask({'x-internal-reconcile':'1'}));
  expect(after.applied).toBe(true);
 });
});

describe('auth routing boundaries',()=>{
 it('rejects cross-origin auth calls and allows DELETE in preflight',async()=>{
  const db=new MockD1();
  const bad=await worker.fetch(new Request('https://api.example/v1/auth/magic-link',{method:'POST',headers:{Origin:'https://evil.example','content-type':'application/json'},body:'{"email":"a@b.co"}'}),makeEnv(db));
  expect(bad.status).toBe(403);
  const pre=await worker.fetch(new Request('https://api.example/v1/auth/session',{method:'OPTIONS',headers:{Origin:ORIGIN}}),makeEnv(db));
  expect(pre.status).toBe(204);expect(pre.headers.get('access-control-allow-methods')).toContain('DELETE');
  const legacy=await worker.fetch(new Request('https://api.example/v1/auth/session',{method:'OPTIONS',headers:{Origin:'https://doxomachy.vercel.app'}}),makeEnv(db));
  expect(legacy.status).toBe(204);
  expect(legacy.headers.get('access-control-allow-origin')).toBe('https://doxomachy.vercel.app');
 });
 it('does not send unknown auth paths to the Durable Object',async()=>{
  const db=new MockD1();
  const res=await worker.fetch(post('/v1/auth/nope',{}),makeEnv(db));
  expect(res.status).toBe(404);
 });
});

describe('v4 hardening: claim-guarded settle, deletion rollback, pepper ring, hashed IP keys, cron cleanup',()=>{
 it('concurrent refunds of the same spend credit at most once',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,1);
  await spendAccountCredit(makeEnv(db),id,'race-key-000000001',T0);
  const env=makeEnv(db);
  await Promise.all([refundAccountCredit(env,id,'race-key-000000001',T0+1000),refundAccountCredit(env,id,'race-key-000000001',T0+1000)]);
  expect(db.credits.get(id)).toBe(1);
  expect(db.spends.get('paid:'+id+':race-key-000000001')!.status).toBe('refunded');
 });
 it('a settle that wins the claim prevents a later refund from crediting',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,1);
  await spendAccountCredit(makeEnv(db),id,'race-key-000000002',T0);
  const env=makeEnv(db);
  await settleAccountSpend(env,id,'race-key-000000002','spent',T0+1000);
  await refundAccountCredit(env,id,'race-key-000000002',T0+1000);
  expect(db.credits.get(id)).toBe(0);
  expect(db.spends.get('paid:'+id+':race-key-000000002')!.status).toBe('spent');
 });
 it('a credit grant racing deletion stays on the tombstoned account instead of vanishing',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,0);
  db.beforeBatch=()=>db.credits.set(id,5); // a grant lands between the pre-check and the deletion batch
  const res=await worker.fetch(authed('/v1/auth/account','DELETE',session),makeEnv(db));
  expect(res.status).toBe(200);
  expect(db.accounts[0].email_hmac).toBe('deleted:'+id);
  expect(db.credits.get(id)).toBe(5);
 });
 it('resolves accounts through a two-deep pepper ring and lazily re-keys',async()=>{
  const db=new MockD1();
  const envA=makeEnv(db,{AUTH_EMAIL_PEPPER:'pepper-a'});
  await worker.fetch(post('/v1/auth/magic-link',{email:'person@example.com'}),envA);
  const oldHmac=db.accounts[0].email_hmac,oldPepper=db.accounts[0].pepper_id;
  const envC=makeEnv(db,{AUTH_EMAIL_PEPPER:'pepper-c',AUTH_EMAIL_PEPPER_PREVIOUS:'pepper-b, pepper-a'});
  const res=await worker.fetch(post('/v1/auth/magic-link',{email:'person@example.com'}),envC);
  expect(res.status).toBe(200);
  expect(db.accounts).toHaveLength(1);
  expect(db.accounts[0].email_hmac).not.toBe(oldHmac);
  expect(db.accounts[0].pepper_id).not.toBe(oldPepper);
  expect(db.accounts[0].pepper_id).toBe(await pepperId('pepper-c'));
 });
 it('keys IP rate buckets by peppered HMAC, never the plaintext IP',async()=>{
  const db=new MockD1();
  await worker.fetch(post('/v1/auth/magic-link',{email:'person@example.com'}),makeEnv(db));
  const keys=[...db.rates.keys()];
  expect(keys.some(k=>k.startsWith('email:'))).toBe(true);
  const ipKey=keys.find(k=>k.startsWith('ip:'));
  expect(ipKey).toBeDefined();
  expect(ipKey!.slice(3)).toMatch(/^[0-9a-f]{64}$/);
  expect(keys.join('|')).not.toContain('203.0.113.7');
 });
 it('skips the IP bucket when CF-Connecting-IP is absent instead of locking out ip:unknown',async()=>{
  const db=new MockD1();
  const env=makeEnv(db);
  const noIp=(email:string)=>new Request('https://api.example/v1/auth/magic-link',{method:'POST',headers:{Origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({email})});
  for(let i=0;i<8;i++){
   const res=await worker.fetch(noIp(`person${i}@example.com`),env);
   expect(res.status).toBe(200);
  }
  for(let i=0;i<6;i++)expect((await worker.fetch(noIp('capped@example.com'),env)).status).toBe(200);
  expect(sent.filter(m=>m.to.includes('capped@example.com'))).toHaveLength(5); // per-email cap still applies without an IP bucket
 });
 it('cron prunes expired auth rows and settles stale pending spends',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,1);
  await spendAccountCredit(makeEnv(db),id,'stale-key-000000001',T0-120_000);
  db.rates.set('email:dead',{key:'email:dead',count:2,window_start:T0-2*3_600_000});
  db.links.push({token_hash:'expired-link',account_id:id,email_hmac:'x',expires_at:T0-1000,consumed_at:null,consume_key:null,created_at:T0-2_000_000});
  const env=makeEnv(db);
  await worker.scheduled({} as any,env);
  const spend=db.spends.get('paid:'+id+':stale-key-000000001')!;
  expect(spend.status).toBe('refunded'); // the DO never applied it
  expect(db.credits.get(id)).toBe(1);
  expect(db.rates.has('email:dead')).toBe(false);
  expect(db.links.some(l=>l.token_hash==='expired-link')).toBe(false);
  expect(doCalls.some(c=>new URL(c.req.url).pathname==='/v1/diary')).toBe(true); // diary cron preserved
 });
});

describe('v5 hardening: atomic spend, reconciliation bound, cron independence',()=>{
 it('a spend the balance cannot cover leaves no pending marker',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,0);
  const r=await spendAccountCredit(makeEnv(db),id,'dry-key-0000000001',T0);
  expect(r.ok).toBe(false);expect(!r.ok&&r.error).toBe('no_moves');
  expect(db.spends.size).toBe(0); // nothing to reconcile into a refund later
 });
 it('concurrent spends with the same key decrement exactly once',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,1);
  const env=makeEnv(db);
  const [a,b]=await Promise.all([spendAccountCredit(env,id,'dup-key-0000000001',T0),spendAccountCredit(env,id,'dup-key-0000000001',T0)]);
  expect(db.credits.get(id)).toBe(0);
  expect([a.ok,b.ok]).toEqual([true,true]); // the loser sees a replay, not a charge
  expect(db.spends.get('paid:'+id+':dup-key-0000000001')!.status).toBe('pending');
 });
 it('refunds are refused past the reconciliation hard bound',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,1);
  await spendAccountCredit(makeEnv(db),id,'old-key-00000000001',T0);
  // 7 days later the DO has forgotten the idempotency record
  vi.setSystemTime(T0+7*86_400_000);
  const env=makeEnv(db);
  let consulted=false;
  await reconcileAccountSpends(env,id,async()=>{consulted=true;return false},Date.now());
  expect(consulted).toBe(false); // blind lookups are never made past the bound
  expect(db.spends.get('paid:'+id+':old-key-00000000001')!.status).toBe('spent'); // closed, never refunded blind
  expect(db.credits.get(id)).toBe(0);
 });
 it('reconciles normally inside the bound (25h regression)',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,1);
  await spendAccountCredit(makeEnv(db),id,'day-key-00000000001',T0);
  doApplied.add('paid:'+id+':day-key-00000000001'); // the DO applied the move
  vi.setSystemTime(T0+25*3_600_000); // 25h: past the old 24h DO retention
  const env=makeEnv(db);
  await reconcileAccountSpends(env,id,async key=>{ // DO retains 7 days now
   const r=await env.MIND.get(env.MIND.idFromName()).fetch('https://mind.internal/internal/idempotency?key='+encodeURIComponent(key),{headers:{'x-internal-reconcile':'1'}});
   return Boolean((await r.json() as any).applied);
  },Date.now());
  expect(db.spends.get('paid:'+id+':day-key-00000000001')!.status).toBe('spent'); // no double-dip
  expect(db.credits.get(id)).toBe(0);
 });
 it('auth cleanup runs even when the diary cron fails',async()=>{
  const db=new MockD1();
  const {session}=await signIn(db);
  const id=db.accounts[0].id;
  db.credits.set(id,1);
  await spendAccountCredit(makeEnv(db),id,'cron-key-00000000001',T0-120_000);
  doResponse=()=>new Response('{"error":"ai_down"}',{status:500,headers:{'content-type':'application/json'}});
  const env=makeEnv(db);
  await expect(worker.scheduled({} as any,env)).rejects.toThrow('scheduled_diary_failed');
  expect(db.spends.get('paid:'+id+':cron-key-00000000001')!.status).toBe('refunded'); // auth cleanup ran first
  expect(db.credits.get(id)).toBe(1);
 });
});
