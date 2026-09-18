export interface Env { MIND: DurableObjectNamespace; DB: D1Database; AI: Ai; WEB_ORIGIN: string; DIARY_MODEL: string }
const json=(value:unknown,status=200,origin='*')=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','access-control-allow-origin':origin,'vary':'Origin'}});
const mindStub=(env:Env)=>env.MIND.get(env.MIND.idFromName('public-mind'));
export default {
 async fetch(request:Request,env:Env){
  const origin=request.headers.get('Origin')||''; if(origin&&origin!==env.WEB_ORIGIN)return json({error:'origin_not_allowed'},403,env.WEB_ORIGIN);
  if(request.method==='OPTIONS')return new Response(null,{headers:{'access-control-allow-origin':env.WEB_ORIGIN,'access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'86400'}});
  const url=new URL(request.url); if(url.pathname==='/health')return json({ok:true,service:'doxomachy-api'},200,env.WEB_ORIGIN);
  if(url.pathname==='/v1/mind'&&request.method==='GET')return mindStub(env).fetch(request);
  if((url.pathname==='/v1/beliefs'||url.pathname.match(/^\/v1\/beliefs\/[^/]+\/protect$/))&&request.method==='POST')return mindStub(env).fetch(request);
  return json({error:'not_found'},404,env.WEB_ORIGIN);
 },
 async scheduled(_controller:ScheduledController,env:Env){await mindStub(env).fetch('https://mind.internal/v1/diary',{method:'POST'})}
};

type Belief={id:string;text:string;alias:string;shields:number;createdAt:number;tokens:number};
export class Mind {
 constructor(private state:DurableObjectState,private env:Env){}
 async snapshot(){return (await this.state.storage.get<{beliefs:Belief[];cycle:number}>('mind'))||{beliefs:[],cycle:1}}
 async fetch(request:Request){
  const url=new URL(request.url);const mind=await this.snapshot();
  if(request.method==='GET')return json(mind);
  if(url.pathname==='/v1/beliefs'){
   const body=await request.json<{text?:string;alias?:string}>();const text=(body.text||'').normalize('NFKC').trim();
   if(text.length<8||text.length>120||/https?:\/\/|www\./i.test(text))return json({error:'invalid_belief'},400);
   const belief:Belief={id:crypto.randomUUID(),text,alias:(body.alias||'anonymous').slice(0,20),shields:1,createdAt:Date.now(),tokens:Math.ceil(text.length/4)};mind.beliefs.push(belief);
   while(mind.beliefs.reduce((n,b)=>n+b.tokens,0)>1000)mind.beliefs.sort((a,b)=>a.shields-b.shields||a.createdAt-b.createdAt).shift();
   await this.state.storage.put('mind',mind);return json({belief,mind},201);
  }
  const match=url.pathname.match(/^\/v1\/beliefs\/([^/]+)\/protect$/);if(match){const b=mind.beliefs.find(x=>x.id===match[1]);if(!b)return json({error:'not_found'},404);b.shields++;await this.state.storage.put('mind',mind);return json({belief:b,mind});}
  if(url.pathname==='/v1/diary'){return json({queued:false,reason:'model_generation_requires_moderation_pipeline'},501)}
  return json({error:'not_found'},404);
 }
}
