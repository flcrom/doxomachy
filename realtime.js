(function(root){
  'use strict';
  function jitterDelay(attempt,random){
    const cap=Math.min(30000,1000*Math.pow(2,Math.min(attempt,5)));
    return Math.floor(cap*(0.5+0.5*random()));
  }
  function create(options){
    const WebSocketImpl=options.WebSocket||root.WebSocket;
    const timers=options.timers||root;
    const random=options.random||Math.random;
    let socket=null,stopped=false,retryTimer=null,pollTimer=null,polling=false,attempt=0,lastVersion=-1;
    function apply(payload,source){
      if(!payload||!Number.isSafeInteger(payload.version)||payload.version<0||payload.version<=lastVersion)return false;
      if(!Array.isArray(payload.beliefs)||!Number.isFinite(payload.cycle))return false;
      lastVersion=payload.version;options.onSnapshot(payload,source);return true;
    }
    async function poll(){
      if(stopped||polling||pollTimer)return;polling=true;
      try{apply(await options.fetchSnapshot(),'poll')}catch(e){options.onError&&options.onError(e)}finally{polling=false}
      if(!stopped){const connected=socket&&socket.readyState===WebSocketImpl.OPEN;pollTimer=timers.setTimeout(()=>{pollTimer=null;poll()},connected?(options.verifyMs||60000):(options.pollMs||20000))}
    }
    function scheduleReconnect(){
      if(stopped||retryTimer)return;
      const delay=jitterDelay(attempt++,random);
      retryTimer=timers.setTimeout(()=>{retryTimer=null;connect()},delay);
    }
    function connect(){
      if(stopped)return;
      try{socket=new WebSocketImpl(options.url)}catch(e){options.onError&&options.onError(e);scheduleReconnect();poll();return}
      socket.onopen=()=>{attempt=0;if(pollTimer){timers.clearTimeout(pollTimer);pollTimer=null}options.onStatus&&options.onStatus('connected');pollTimer=timers.setTimeout(()=>{pollTimer=null;poll()},options.verifyMs||60000)};
      socket.onmessage=event=>{if(event.data==='pong')return;try{apply(JSON.parse(event.data),'realtime')}catch(e){options.onError&&options.onError(e)}};
      socket.onerror=()=>{};
      socket.onclose=()=>{socket=null;options.onStatus&&options.onStatus('reconnecting');poll();scheduleReconnect()};
    }
    function stop(){stopped=true;if(retryTimer)timers.clearTimeout(retryTimer);if(pollTimer)timers.clearTimeout(pollTimer);if(socket)socket.close(1000,'page closed')}
    return {start:connect,stop,apply,getVersion:()=>lastVersion};
  }
  root.DoxomachyRealtime={create,jitterDelay};
})(typeof globalThis==='object'?globalThis:this);
