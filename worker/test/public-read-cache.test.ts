import {describe,it,expect,vi,afterEach} from 'vitest';
import {worker} from '../src/index';

const ORIGIN='https://doxomachy.flcrom.dev';

function makeEnv(mindFetch:(input:any,init:any)=>Promise<Response>){
 return {
  DB:{prepare:()=>({bind:()=>({first:async()=>null,run:async()=>({meta:{changes:0}}),all:async()=>({results:[]})}),first:async()=>null,run:async()=>({meta:{changes:0}}),all:async()=>({results:[]})})},
  MIND:{idFromName:()=>({}),get:()=>({fetch:mindFetch})},
  WEB_ORIGIN:ORIGIN,WEB_ORIGINS:ORIGIN,
 } as any;
}

function fakeCaches(){
 const map=new Map<string,Response>();
 return {default:{
  match:async(req:Request)=>{const r=map.get(req.url);return r?r.clone():undefined},
  put:async(req:Request,res:Response)=>{map.set(req.url,res.clone())},
 }};
}

const ctx={waitUntil:(p:Promise<unknown>)=>{p.catch(()=>{})},passThroughOnException:()=>{}} as any;
const get=(auth?:string)=>new Request('https://api.example/v1/mind?clientId=probe',{headers:{Origin:ORIGIN,...(auth?{authorization:auth}:{})}});
const mindBody=(version:number)=>JSON.stringify({beliefs:[{id:'b1',text:'public belief',alias:'a',shields:1,createdAt:1,tokens:3}],cycle:1,version,moves:3,diary:null});

afterEach(()=>vi.unstubAllGlobals());

describe('anonymous public read offload',()=>{
 it('caches one anonymous read and serves the next from the edge without touching the DO',async()=>{
  vi.stubGlobal('caches',fakeCaches());
  let calls=0;
  const env=makeEnv(async()=>{calls++;return new Response(mindBody(7),{status:200,headers:{'content-type':'application/json'}})});
  const first=await worker.fetch(get(),env,ctx);
  expect(first.status).toBe(200);
  expect(first.headers.get('x-doxomachy-cache')).toBe('miss');
  expect(first.headers.get('cache-control')).toBe('no-store'); // browsers never cache; only the POP does
  const second=await worker.fetch(get(),env,ctx);
  expect(second.headers.get('x-doxomachy-cache')).toBe('hit');
  expect(calls).toBe(1);
  const body:any=await second.json();
  expect(body.version).toBe(7);
 });
 it('never caches per-session state (moves stripped)',async()=>{
  vi.stubGlobal('caches',fakeCaches());
  const env=makeEnv(async()=>new Response(mindBody(3),{status:200,headers:{'content-type':'application/json'}}));
  const res=await worker.fetch(get(),env,ctx);
  const body:any=await res.json();
  expect('moves' in body).toBe(false);
  expect(JSON.stringify(body)).not.toContain('"moves"');
 });
 it('authenticated reads bypass the cache and reach the authoritative DO',async()=>{
  vi.stubGlobal('caches',fakeCaches());
  let calls=0;
  const env=makeEnv(async()=>{calls++;return new Response(mindBody(calls),{status:200,headers:{'content-type':'application/json'}})});
  await worker.fetch(get(),env,ctx); // warm the cache
  const before=calls;
  const authed=await worker.fetch(get('Bearer abc'),env,ctx);
  expect(calls).toBe(before+1);
  const body:any=await authed.json();
  expect(body.version).toBe(before+1); // fresh authoritative response, not the cached v1
 });
 it('falls through to the DO when the Cache API is unavailable',async()=>{
  let calls=0;
  const env=makeEnv(async()=>{calls++;return new Response(mindBody(1),{status:200,headers:{'content-type':'application/json'}})});
  const res=await worker.fetch(get(),env,ctx);
  expect(res.status).toBe(200);
  expect(calls).toBe(1);
 });
 it('does not cache DO errors',async()=>{
  vi.stubGlobal('caches',fakeCaches());
  let calls=0;
  const env=makeEnv(async()=>{calls++;return new Response(JSON.stringify({error:'internal_error'}),{status:500,headers:{'content-type':'application/json'}})});
  const res=await worker.fetch(get(),env,ctx);
  expect(res.status).toBe(500);
  await worker.fetch(get(),env,ctx);
  expect(calls).toBe(2);
 });
});
