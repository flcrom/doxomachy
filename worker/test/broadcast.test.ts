import {afterEach,describe,expect,it,vi} from 'vitest';
import {Mind} from '../src/index';

function makeMind(sockets:{send:(p:string)=>void}[]){
 const storage=new Map<string,any>();
 const state:any={storage:{get:async(k:string)=>storage.get(k),put:async(k:string,v:any)=>{storage.set(k,v)}},getWebSockets:()=>sockets,blockConcurrencyWhile:(fn:()=>Promise<void>)=>{void fn()}};
 const env:any={DB:{prepare:()=>({bind:()=>({first:async()=>null}),first:async()=>null})},DIARY_MODEL:'m'};
 return new Mind(state,env);
}
const words=['river','lantern','orchard','harbor','meadow','compass','granite','willow'];
const belief=(i:number)=>new Request('https://mind.internal/v1/beliefs',{method:'POST',headers:{'content-type':'application/json','x-paid-move':'1','x-session-id':'paid:acc-'+i,'idempotency-key':'key-000000000000'+i},body:JSON.stringify({text:`a quiet ${words[i]} deserves patient care`,alias:'qa'})});

describe('coalesced broadcast',()=>{
 afterEach(()=>vi.useRealTimers());
 it('sends one latest snapshot for a burst of writes instead of one per write',async()=>{
  vi.useFakeTimers();
  const got:string[][]=[[],[]];
  const mind=makeMind(got.map(g=>({send:(p:string)=>{g.push(p)}})));
  const statuses=await Promise.all(words.map((_,i)=>mind.fetch(belief(i)).then(r=>r.status)));
  expect(statuses.every(s=>s===201)).toBe(true);
  expect(got[0]).toHaveLength(0); // writes returned before any fan-out
  await vi.advanceTimersByTimeAsync(300);
  for(const g of got){
   expect(g.length).toBeGreaterThanOrEqual(1);expect(g.length).toBeLessThanOrEqual(2);
   expect(JSON.parse(g[g.length-1]).beliefs).toHaveLength(words.length);
  }
 });
 it('keeps at least 250ms between snapshots and still delivers the last write',async()=>{
  vi.useFakeTimers();
  const sent:number[]=[];const payloads:string[]=[];
  const mind=makeMind([{send:(p:string)=>{sent.push(Date.now());payloads.push(p)}}]);
  for(let i=0;i<4;i++){await mind.fetch(belief(i));await vi.advanceTimersByTimeAsync(100)}
  await vi.advanceTimersByTimeAsync(500);
  for(let i=1;i<sent.length;i++)expect(sent[i]-sent[i-1]).toBeGreaterThanOrEqual(250);
  expect(sent.length).toBeLessThan(4);
  expect(JSON.parse(payloads[payloads.length-1]).beliefs).toHaveLength(4);
 });
});
