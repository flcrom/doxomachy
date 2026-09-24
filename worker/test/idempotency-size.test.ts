import {describe,expect,it} from 'vitest';
import {Mind} from '../src/index';

function makeMind(){
 const storage=new Map<string,any>();
 const state:any={storage:{get:async(k:string)=>storage.get(k),put:async(k:string,v:any)=>{storage.set(k,structuredClone(v))}},getWebSockets:()=>[],blockConcurrencyWhile:(fn:()=>Promise<void>)=>{void fn()}};
 const env:any={DB:{prepare:()=>({bind:()=>({first:async()=>null}),first:async()=>null})},DIARY_MODEL:'m',PROTECT_NEW_UNTIL_DIARY:'false'};
 return {mind:new Mind(state,env),storage};
}
const post=(i:number,key=`idem-size-${String(i).padStart(8,'0')}`)=>new Request('https://mind.internal/v1/beliefs',{method:'POST',headers:{'content-type':'application/json','x-paid-move':'1','x-session-id':'paid:acc-'+(i%50),'idempotency-key':key},body:JSON.stringify({text:`load test belief ${i} about quiet work`,alias:'qa'})});

describe('idempotency records stay small',()=>{
 it('400 paid moves keep the stored mind well under the storage value limit',async()=>{
  const {mind,storage}=makeMind();
  for(let i=0;i<400;i++){const r=await mind.fetch(post(i));expect(r.status).toBe(201)}
  const bytes=JSON.stringify(storage.get('mind')).length;
  expect(Object.keys(storage.get('mind').idempotency)).toHaveLength(400);
  expect(bytes).toBeLessThan(500_000);
 });
 it('a replay returns the original result with the current belief list',async()=>{
  const {mind}=makeMind();
  const first:any=await (await mind.fetch(post(1,'idem-replay-0000001'))).json();
  await mind.fetch(post(2));
  const again:any=await (await mind.fetch(post(1,'idem-replay-0000001'))).json();
  expect(again.belief).toEqual(first.belief);
  expect(again.mind.version).toBe(first.mind.version);
  expect(again.mind.beliefs.length).toBe(first.mind.beliefs.length+1);
 });
 it('slims legacy records that stored a full mind copy',async()=>{
  const {mind,storage}=makeMind();
  await mind.fetch(post(1));
  const m=storage.get('mind');const key=Object.keys(m.idempotency)[0];
  m.idempotency[key].body.mind.beliefs=Array(200).fill({text:'x'.repeat(200)});storage.set('mind',m);
  const {Mind:M}=await import('../src/index');
  const fresh=new M({storage:{get:async(k:string)=>storage.get(k),put:async(k:string,v:any)=>{storage.set(k,structuredClone(v))}},getWebSockets:()=>[],blockConcurrencyWhile:(fn:()=>Promise<void>)=>{void fn()}} as any,{DB:{prepare:()=>({bind:()=>({first:async()=>null}),first:async()=>null})},DIARY_MODEL:'m'} as any);
  await fresh.fetch(post(2));
  expect(storage.get('mind').idempotency[key].body.mind.beliefs).toBeUndefined();
 });
});
