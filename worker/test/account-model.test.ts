// Account-only moves against the REAL migrated schema (node:sqlite), so the
// new spend/refund/deletion SQL is exercised as SQLite runs it, not a mock.
import {describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spendAccountMove,refundAccountCredit,settleAccountSpend,accountBalances,authSql,freeShieldAllowance} from '../src/auth';
import {planEviction,lastDiaryCutoff,decayShields,SHIELD_TTL} from '../src/index';
import {packs,packByKey,packByProduct} from '../src/payments/catalog';

const DIR=join(dirname(fileURLToPath(import.meta.url)),'..','migrations');
function d1(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 for(const f of readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(join(DIR,f),'utf8'));
 const stmt=(sql:string,p:any[]=[])=>({__sql:sql,__p:p,
  run:async()=>{const r=db.prepare(sql).run(...p);return {meta:{changes:Number(r.changes)}}},
  first:async()=>db.prepare(sql).get(...p)??null,
  all:async()=>({results:db.prepare(sql).all(...p)})});
 const D1:any={prepare:(sql:string)=>({bind:(...p:any[])=>stmt(sql,p),...stmt(sql)}),
  batch:async(list:any[])=>{db.exec('BEGIN');try{const out=list.map(s=>{if(/^\s*SELECT/i.test(s.__sql))return {results:db.prepare(s.__sql).all(...s.__p),meta:{changes:0}};const r=db.prepare(s.__sql).run(...s.__p);return {meta:{changes:Number(r.changes)}}});db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}}};
 return {db,D1};
}
const T=1_800_000_000_000;
function setup(credits=0){const {db,D1}=d1();db.prepare('INSERT INTO accounts (id,email_hmac,created_at) VALUES (?,?,?)').run('a1','h1',T);if(credits)db.prepare('INSERT INTO credits (subject,balance,updated_at) VALUES (?,?,?)').run('a1',credits,T);return {db,env:{DB:D1} as any}}

describe('free shields and credit costs (real SQLite)',()=>{
 it('every account starts with 3 free shields, spent before credits',async()=>{
  const {env}=setup(5);
  expect(await accountBalances(env,'a1')).toEqual({credits:5,free_shields:3});
  for(let i=0;i<3;i++){const r=await spendAccountMove(env,'a1','shield-key-000000'+i,T,'shield',1);expect(r).toMatchObject({ok:true,kind:'free_shield'});await settleAccountSpend(env,'a1','shield-key-000000'+i,'spent',T)}
  expect(await accountBalances(env,'a1')).toEqual({credits:5,free_shields:0});
  const paid=await spendAccountMove(env,'a1','shield-key-0000009',T,'shield',1);
  expect(paid).toMatchObject({ok:true,kind:'credit'});
  expect(await accountBalances(env,'a1')).toEqual({credits:4,free_shields:0});
 });
 it('a belief always costs credits, never a free shield',async()=>{
  const {env}=setup(0);
  expect(await spendAccountMove(env,'a1','belief-key-000001',T,'belief',2)).toMatchObject({ok:false,status:402,error:'no_credits'});
  expect(await accountBalances(env,'a1')).toEqual({credits:0,free_shields:3});
 });
 it('a belief costing 2 needs 2 credits and takes exactly 2',async()=>{
  const {env,db}=setup(1);
  expect((await spendAccountMove(env,'a1','belief-key-000002',T,'belief',2)).ok).toBe(false);
  db.prepare('UPDATE credits SET balance=3 WHERE subject=?').run('a1');
  expect((await spendAccountMove(env,'a1','belief-key-000003',T,'belief',2)).ok).toBe(true);
  expect((await accountBalances(env,'a1')).credits).toBe(1);
 });
 it('no credits and no free shields left means no_shields',async()=>{
  const {env,db}=setup(0);db.prepare('INSERT INTO account_free_shields (account_id,used,updated_at) VALUES (?,?,?)').run('a1',3,T);
  expect(await spendAccountMove(env,'a1','shield-key-0000010',T,'shield',1)).toMatchObject({ok:false,error:'no_shields'});
 });
 it('refunding a failed move returns exactly what it took',async()=>{
  const {env}=setup(4);
  await spendAccountMove(env,'a1','shield-key-0000020',T,'shield',1);
  await refundAccountCredit(env,'a1','shield-key-0000020',T);
  expect(await accountBalances(env,'a1')).toEqual({credits:4,free_shields:3});
  await spendAccountMove(env,'a1','belief-key-0000021',T,'belief',2);
  expect((await accountBalances(env,'a1')).credits).toBe(2);
  await refundAccountCredit(env,'a1','belief-key-0000021',T);
  await refundAccountCredit(env,'a1','belief-key-0000021',T); // second refund is a no-op
  expect(await accountBalances(env,'a1')).toEqual({credits:4,free_shields:3});
 });
 it('an idempotent replay never charges twice; a refunded key is consumed',async()=>{
  const {env}=setup(4);
  await spendAccountMove(env,'a1','belief-key-0000030',T,'belief',2);
  expect(await spendAccountMove(env,'a1','belief-key-0000030',T,'belief',2)).toMatchObject({ok:true,replay:true});
  expect((await accountBalances(env,'a1')).credits).toBe(2);
  await refundAccountCredit(env,'a1','belief-key-0000030',T);
  expect(await spendAccountMove(env,'a1','belief-key-0000030',T,'belief',2)).toMatchObject({ok:false,status:409});
 });
 it('a pre-migration pending marker (no spend_meta row) refunds one credit',async()=>{
  const {env,db}=setup(0);
  db.prepare("INSERT INTO paid_spends (key,account_id,status,created_at) VALUES ('paid:a1:legacy-key-0000001','a1','pending',?)").run(T);
  db.prepare('INSERT INTO credits (subject,balance,updated_at) VALUES (?,?,?)').run('a1',0,T);
  await refundAccountCredit(env,'a1','legacy-key-0000001',T);
  expect((await accountBalances(env,'a1')).credits).toBe(1);
 });
 it('the free allowance is configuration',()=>{expect(freeShieldAllowance({} as any)).toBe(3);expect(freeShieldAllowance({FREE_SHIELDS:'5'} as any)).toBe(5);expect(freeShieldAllowance({FREE_SHIELDS:'x'} as any)).toBe(3)});
});

describe('account deletion on our side (real SQLite)',()=>{
 it('tombstones the account while order rows keep a valid reference',async()=>{
  const {db,env}=setup(0);
  db.prepare("INSERT INTO dodo_orders (session_id,account_id,status,product_id,credits,total_amount,currency,created_at,updated_at) VALUES ('cs1','a1','succeeded','p',10,500,'USD',?,?)").run(T,T);
  db.prepare("INSERT INTO account_free_shields (account_id,used,updated_at) VALUES ('a1',1,?)").run(T);
  await env.DB.batch([
   env.DB.prepare(authSql.deleteAccountSpendMeta).bind('a1'),env.DB.prepare(authSql.deleteAccountSpends).bind('a1'),
   env.DB.prepare(authSql.deleteAccountFreeShields).bind('a1'),env.DB.prepare(authSql.deleteAccountIntents).bind('a1'),
   env.DB.prepare(authSql.creditDelete).bind('a1',0),env.DB.prepare(authSql.tombstoneAccount).bind('a1')]);
  expect(db.prepare('SELECT email_hmac FROM accounts WHERE id=?').get('a1')).toEqual({email_hmac:'deleted:a1'});
  expect(db.prepare('SELECT account_id FROM dodo_orders').get()).toEqual({account_id:'a1'});
  expect(db.prepare('SELECT COUNT(*) n FROM account_free_shields').get()).toEqual({n:0});
 });
});

describe('eviction',()=>{
 const b=(id:string,tokens:number,shields:number,createdAt:number)=>({id,text:id,alias:'a',tokens,shields,createdAt});
 it('without the switch: fewest shields, then oldest, and a new belief can lose immediately',()=>{
  const old=[b('x',500,2,1),b('y',490,3,2)];const inc=b('new',20,1,10);
  const plan=planEviction(old,inc,null)!;expect(plan.evicted.map(e=>e.id)).toEqual(['new']);
 });
 it('with the switch: beliefs newer than the last diary are safe; the weakest older one goes',()=>{
  const old=[b('x',500,2,1),b('y',490,3,2)];const inc=b('new',20,1,10);
  const plan=planEviction(old,inc,5)!;expect(plan.evicted.map(e=>e.id)).toEqual(['x']);expect(plan.kept.map(e=>e.id)).toContain('new');
 });
 it('with the switch: refuses when only protected beliefs could make room',()=>{
  const old=[b('x',990,1,8)];expect(planEviction(old,b('new',20,1,10),5)).toBeNull();
 });
 it('the diary cutoff is the latest 00:30 UTC',()=>{
  expect(new Date(lastDiaryCutoff(Date.parse('2026-09-24T12:00:00Z'))).toISOString()).toBe('2026-09-24T00:30:00.000Z');
  expect(new Date(lastDiaryCutoff(Date.parse('2026-09-24T00:10:00Z'))).toISOString()).toBe('2026-09-23T00:30:00.000Z');
 });
});

describe('credit packs',()=>{
 it('$5 = 10 credits and $19 = 50 credits, only for configured products',()=>{
  const env={DODO_PRODUCT_ID:'p_small',DODO_PRODUCT_ID_LARGE:'p_large'};
  expect(packs(env)).toEqual([{key:'small',productId:'p_small',credits:10,amountMinor:500},{key:'large',productId:'p_large',credits:50,amountMinor:1900}]);
  expect(packByKey(env,'large')!.credits).toBe(50);expect(packByKey(env,undefined)!.key).toBe('small');
  expect(packByProduct(env,'p_other')).toBeNull();expect(packByKey({DODO_PRODUCT_ID:'p_small'},'large')).toBeNull();
 });
});

describe('shield decay',()=>{
 it('each added shield lasts 7 days; the base shield never decays',()=>{
  const now=1_000_000_000_000;const bs:any[]=[{id:'a',shields:3,shieldTimes:[now-SHIELD_TTL-1,now-1000],createdAt:0,tokens:5,text:'a',alias:'x'}];
  decayShields(bs,now);expect(bs[0].shields).toBe(2);expect(bs[0].shieldTimes).toEqual([now-1000]);
  decayShields(bs,now+SHIELD_TTL);expect(bs[0].shields).toBe(1);
 });
 it('beliefs from before decay start the 7-day clock now',()=>{
  const now=5e12;const bs:any[]=[{id:'a',shields:4,createdAt:0,tokens:5,text:'a',alias:'x'}];
  expect(decayShields(bs,now)).toBe(true);expect(bs[0].shields).toBe(4);expect(bs[0].shieldTimes).toEqual([now,now,now]);
  decayShields(bs,now+SHIELD_TTL);expect(bs[0].shields).toBe(1);
 });
 it('decay can be switched off',()=>{
  const now=5e12;const bs:any[]=[{id:'a',shields:2,shieldTimes:[0],createdAt:0,tokens:5,text:'a',alias:'x'}];
  decayShields(bs,now,false);expect(bs[0].shields).toBe(2);
 });
});
