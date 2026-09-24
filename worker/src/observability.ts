export type Outcome='ok'|'degraded'|'error';
export type Operation='http'|'readiness'|'cron'|'webhook'|'checkout'|'credits'|'durable_object';

export interface EventFields {
  operation:Operation;
  outcome:Outcome;
  correlationId:string;
  status?:number;
  route?:string;
  method?:string;
  durationMs?:number;
  reason?:string;
  gauges?:Record<string,number>;
}

const MAX_GAUGES=8;
const safeToken=(value:string,max=64)=>/^[A-Za-z0-9_./:-]+$/.test(value)&&value.length<=max?value:'redacted';
const safeGauges=(gauges:Record<string,number>):Record<string,number>=>{
  const out:Record<string,number>={};
  for(const [key,value] of Object.entries(gauges).slice(0,MAX_GAUGES)){
    if(!/^[a-z][a-z_]{1,31}$/.test(key)||!Number.isFinite(value))continue;
    out[key]=Math.round(value);
  }
  return out;
};

export const correlationId=(request?:Request):string=>{
  const supplied=request?.headers.get('x-correlation-id')||'';
  return /^[A-Za-z0-9_-]{8,64}$/.test(supplied)?supplied:crypto.randomUUID();
};

/** Route templates keep belief and session identifiers out of logs. */
export const routeTemplate=(path:string):string=>{
  if(/^\/v1\/beliefs\/[^/]+\/protect$/.test(path))return '/v1/beliefs/:id/protect';
  return safeToken(path,64);
};

/** Allowlisted, privacy-safe operational telemetry. Never pass request bodies or identifiers here. */
export const logEvent=(event:EventFields):void=>{
  const record={
    timestamp:new Date().toISOString(),
    service:'doxomachy-worker',
    event:'operation',
    operation:event.operation,
    outcome:event.outcome,
    correlation_id:safeToken(event.correlationId),
    ...(event.status===undefined?{}:{status:event.status}),
    ...(event.route?{route:safeToken(event.route)}:{}),
    ...(event.method?{method:safeToken(event.method,12)}:{}),
    ...(event.durationMs===undefined?{}:{duration_ms:Math.max(0,Math.round(event.durationMs))}),
    ...(event.reason?{reason:safeToken(event.reason)}:{}),
    ...(event.gauges?{gauges:safeGauges(event.gauges)}:{}),
  };
  const line=JSON.stringify(record);
  if(event.outcome==='error')console.error(line);
  else if(event.outcome==='degraded')console.warn(line);
  else console.log(line);
};

export const withCorrelation=(response:Response,id:string):Response=>{
  // A WebSocket upgrade (101) cannot be re-wrapped: new Response() rejects
  // status 101 and would drop the socket, turning every realtime connect into
  // a 500. Pass it through untouched.
  if(response.status===101||(response as Response&{webSocket?:unknown}).webSocket)return response;
  const headers=new Headers(response.headers);headers.set('x-correlation-id',id);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
};
