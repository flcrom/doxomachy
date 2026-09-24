import {describe,expect,it,vi} from 'vitest';
import {correlationId,logEvent,routeTemplate,withCorrelation} from '../src/observability';

describe('privacy-safe observability',()=>{
  it('uses a safe supplied correlation id and replaces unsafe values',()=>{
    expect(correlationId(new Request('https://worker.test',{headers:{'x-correlation-id':'release_12345678'}}))).toBe('release_12345678');
    expect(correlationId(new Request('https://worker.test',{headers:{'x-correlation-id':'contains private text'}}))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs only allowlisted fields and redacts unsafe dimensions',()=>{
    const spy=vi.spyOn(console,'error').mockImplementation(()=>{});
    logEvent({operation:'webhook',outcome:'error',correlationId:'correlation_123',status:500,route:'/webhooks/dodo',method:'POST',durationMs:12.4,reason:'payment failed private detail'});
    const event=JSON.parse(String(spy.mock.calls[0][0]));
    expect(event).toMatchObject({service:'doxomachy-worker',operation:'webhook',outcome:'error',correlation_id:'correlation_123',status:500,route:'/webhooks/dodo',method:'POST',duration_ms:12,reason:'redacted'});
    expect(JSON.stringify(event)).not.toContain('private detail');
    spy.mockRestore();
  });

  it('keeps only snake_case numeric gauges',()=>{
    const spy=vi.spyOn(console,'warn').mockImplementation(()=>{});
    logEvent({operation:'durable_object',outcome:'degraded',correlationId:'correlation_123',reason:'writer_queue_saturated',gauges:{queue_depth:12.6,evicted:2,SessionId:5,'bad-key':1,tokens_used:NaN as unknown as number}});
    const event=JSON.parse(String(spy.mock.calls[0][0]));
    expect(event.gauges).toEqual({queue_depth:13,evicted:2});
    spy.mockRestore();
  });

  it('routes errors to console.error, degraded to warn, ok to log',()=>{
    const err=vi.spyOn(console,'error').mockImplementation(()=>{});
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});
    logEvent({operation:'cron',outcome:'error',correlationId:'correlation_123',reason:'diary_failed'});
    logEvent({operation:'durable_object',outcome:'degraded',correlationId:'correlation_123',reason:'quota_exhausted'});
    logEvent({operation:'cron',outcome:'ok',correlationId:'correlation_123',reason:'completed'});
    expect(err).toHaveBeenCalledTimes(1);expect(warn).toHaveBeenCalledTimes(1);expect(log).toHaveBeenCalledTimes(1);
    err.mockRestore();warn.mockRestore();log.mockRestore();
  });

  it('normalizes belief ids out of route templates',()=>{
    expect(routeTemplate('/v1/beliefs/2f6b9c7a-1111-4222-8333-944455556666/protect')).toBe('/v1/beliefs/:id/protect');
    expect(routeTemplate('/v1/mind')).toBe('/v1/mind');
    expect(routeTemplate('/v1/beliefs/has private text/protect')).not.toContain('private');
  });

  it('adds correlation ids without changing the response body',async()=>{
    const response=withCorrelation(new Response('{"ok":true}',{status:202,headers:{'content-type':'application/json'}}),'correlation_123');
    expect(response.status).toBe(202);expect(response.headers.get('x-correlation-id')).toBe('correlation_123');expect(await response.text()).toBe('{"ok":true}');
  });
});

describe('worker instrumentation',()=>{
  const envWith=(mindFetch:(...a:any[])=>Promise<Response>|Response,dbFirst?:()=>Promise<unknown>)=>({
    WEB_ORIGIN:'https://doxomachy.vercel.app',
    DIARY_MODEL:'@cf/test-model',
    MIND:{idFromName:()=>({}),get:()=>({fetch:mindFetch})},
    DB:{prepare:()=>({first:dbFirst||(()=>Promise.resolve({'?column?':1}))})},
  });

  it('adds a correlation id and logs every request with route, status and duration',async()=>{
    const spy=vi.spyOn(console,'log').mockImplementation(()=>{});
    const {worker}=await import('../src/index');
    const response=await worker.fetch(new Request('https://api.example/health',{headers:{Origin:'https://doxomachy.vercel.app'}}),envWith(()=>new Response('{}')) as any);
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    const event=JSON.parse(String(spy.mock.calls[0][0]));
    expect(event).toMatchObject({operation:'http',outcome:'ok',status:200,route:'/health',method:'GET'});
    expect(typeof event.duration_ms).toBe('number');
    spy.mockRestore();
  });

  it('exposes x-correlation-id on every actual CORS response: proxied routes, direct routes, and early errors',async()=>{
    vi.spyOn(console,'log').mockImplementation(()=>{});
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const {worker}=await import('../src/index');
    const origin='https://doxomachy.vercel.app';
    const proxied=await worker.fetch(new Request('https://api.example/v1/mind',{headers:{Origin:origin}}),envWith(()=>new Response('{}')) as any);
    expect(proxied.headers.get('access-control-expose-headers')).toBe('x-correlation-id, x-account-credits');
    const direct=await worker.fetch(new Request('https://api.example/health',{headers:{Origin:origin}}),envWith(()=>new Response('{}')) as any);
    expect(direct.headers.get('access-control-expose-headers')).toBe('x-correlation-id, x-account-credits');
    expect(direct.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    const earlyError=await worker.fetch(new Request('https://api.example/nope',{headers:{Origin:origin}}),envWith(()=>new Response('{}')) as any);
    expect(earlyError.status).toBe(404);
    expect(earlyError.headers.get('access-control-expose-headers')).toBe('x-correlation-id, x-account-credits');
    const tooLarge=await worker.fetch(new Request('https://api.example/v1/session',{method:'POST',headers:{Origin:origin,'content-length':'999999'}}),envWith(()=>new Response('{}')) as any);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get('access-control-expose-headers')).toBe('x-correlation-id, x-account-credits');
    vi.restoreAllMocks();
  });

  it('readiness is 200 when D1 and the Durable Object respond and 503 otherwise',async()=>{
    vi.spyOn(console,'log').mockImplementation(()=>{});
    const {worker}=await import('../src/index');
    const healthy=await worker.fetch(new Request('https://api.example/ready'),envWith(()=>new Response('{"ok":true,"gauges":{"queue_depth":0,"beliefs":3,"tokens_used":42,"sessions":1}}')) as any);
    expect(healthy.status).toBe(200);
    const body:any=await healthy.json();
    expect(body.checks).toEqual({database:'ok',mind:'ok'});
    expect(body.gauges.tokens_used).toBe(42);
    const degraded=await worker.fetch(new Request('https://api.example/ready'),envWith(()=>{throw new Error('down')},()=>Promise.reject(new Error('d1 down'))) as any);
    expect(degraded.status).toBe(503);
    const degradedBody:any=await degraded.json();
    expect(degradedBody).toMatchObject({ok:false,checks:{database:'error',mind:'error'}});
    vi.restoreAllMocks();
  });

  it('scheduled diary logs failure and rethrows so platform execution records show it',async()=>{
    vi.spyOn(console,'log').mockImplementation(()=>{});
    const err=vi.spyOn(console,'error').mockImplementation(()=>{});
    const {worker}=await import('../src/index');
    await expect(worker.scheduled({} as any,envWith(()=>new Response('{}',{status:500})) as any)).rejects.toThrow('scheduled_diary_failed');
    const event=JSON.parse(String(err.mock.calls[0][0]));
    expect(event).toMatchObject({operation:'cron',outcome:'error',reason:'diary_failed'});
    vi.restoreAllMocks();
  });

  it('unhandled exceptions become a logged 500 with a correlation id',async()=>{
    vi.spyOn(console,'log').mockImplementation(()=>{});
    const err=vi.spyOn(console,'error').mockImplementation(()=>{});
    const {worker}=await import('../src/index');
    const response=await worker.fetch(new Request('https://api.example/v1/mind',{headers:{Origin:'https://doxomachy.vercel.app'}}),envWith(()=>{throw new Error('boom')}) as any);
    expect(response.status).toBe(500);
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(err.mock.calls.some(c=>String(c[0]).includes('unhandled_exception'))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('Durable Object readiness and signals',()=>{
  const makeMind=async()=>{
    const {Mind}=await import('../src/index');
    const store=new Map<string,unknown>();
    const state:any={storage:{get:(k:string)=>Promise.resolve(store.get(k)),put:(k:string,v:unknown)=>{store.set(k,v);return Promise.resolve()}},blockConcurrencyWhile:(fn:()=>Promise<void>)=>fn(),getWebSockets:()=>[]};
    const env:any={WEB_ORIGIN:'https://doxomachy.vercel.app',DIARY_MODEL:'@cf/test-model',DB:{prepare:()=>{const q:any={first:()=>Promise.resolve(null),run:()=>Promise.resolve({}),bind:()=>q};return q}},AI:{run:()=>Promise.reject(new Error('quota'))}};
    return new Mind(state,env);
  };

  it('answers internal readiness with saturation gauges only to the internal caller',async()=>{
    vi.spyOn(console,'log').mockImplementation(()=>{});
    const mind=await makeMind();
    const denied=await mind.fetch(new Request('https://mind.internal/internal/ready'));
    expect(denied.status).toBe(404);
    const ready=await mind.fetch(new Request('https://mind.internal/internal/ready',{headers:{'x-internal-ready':'1'}}));
    expect(ready.status).toBe(200);
    const body:any=await ready.json();
    expect(body.gauges).toMatchObject({queue_depth:0,beliefs:0,tokens_used:0,sessions:0});
    vi.restoreAllMocks();
  });

  it('logs ai_unavailable when the diary model call fails',async()=>{
    vi.spyOn(console,'log').mockImplementation(()=>{});
    const err=vi.spyOn(console,'error').mockImplementation(()=>{});
    const mind=await makeMind();
    // seed one belief through a session + move
    const session=await (await mind.fetch(new Request('https://mind.internal/v1/session',{method:'POST',headers:{'x-issuance-key':'0123456789abcdef0123456789abcdef'}}))).json() as any;
    await mind.fetch(new Request('https://mind.internal/v1/beliefs',{method:'POST',headers:{'content-type':'application/json','x-session-id':session.token,'idempotency-key':'abcdef0123456789'},body:JSON.stringify({text:'Calm systems deserve quiet attention.'})}));
    const diary=await mind.fetch(new Request('https://mind.internal/v1/diary',{method:'POST',headers:{'x-internal-scheduled':'1'}}));
    expect(diary.status).toBe(502);
    expect(err.mock.calls.some(c=>String(c[0]).includes('ai_unavailable'))).toBe(true);
    vi.restoreAllMocks();
  });
});
