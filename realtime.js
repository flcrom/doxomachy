(function(root){
  'use strict';
  function jitterDelay(attempt,random){const cap=Math.min(30000,1000*Math.pow(2,Math.min(attempt,5)));return Math.floor(cap*(0.5+0.5*random()))}
  function jitter(base,spread,random){return Math.floor(base+spread*random())}
  function diaryStamp(d){return d&&Number(d.created_at)||0}
  function create(options){
    const WebSocketImpl=options.WebSocket||root.WebSocket,timers=options.timers||root,random=options.random||Math.random;
    let socket=null,stopped=false,retryTimer=null,pollTimer=null,heartbeatTimer=null,polling=false,attempt=0,lastVersion=-1,lastDiary=0;
    function apply(payload,source){
      if(!payload||!Number.isSafeInteger(payload.version)||payload.version<0||!Array.isArray(payload.beliefs)||!Number.isFinite(payload.cycle))return false;
      const newer=payload.version>lastVersion,diaryNewer=payload.version===lastVersion&&diaryStamp(payload.diary)>lastDiary;
      if(!newer&&!diaryNewer)return false;
      lastVersion=payload.version;lastDiary=Math.max(lastDiary,diaryStamp(payload.diary));attempt=0;options.onSnapshot(payload,source);return true;
    }
    function scheduleHeartbeat(){if(stopped||heartbeatTimer)return;heartbeatTimer=timers.setTimeout(()=>{heartbeatTimer=null;if(socket&&socket.readyState===WebSocketImpl.OPEN){try{socket.send('ping')}catch{}scheduleHeartbeat()}},jitter(options.heartbeatMinMs||120000,options.heartbeatJitterMs||120000,random))}
    async function poll(){
      if(stopped||polling||pollTimer||(socket&&socket.readyState===WebSocketImpl.OPEN))return;polling=true;
      try{apply(await options.fetchSnapshot(),'poll')}catch(e){options.onError&&options.onError(e)}finally{polling=false}
      if(!stopped&&(!socket||socket.readyState!==WebSocketImpl.OPEN))pollTimer=timers.setTimeout(()=>{pollTimer=null;poll()},jitter(options.pollMinMs||20000,options.pollJitterMs||20000,random));
    }
    function scheduleReconnect(){if(stopped||retryTimer)return;retryTimer=timers.setTimeout(()=>{retryTimer=null;connect()},jitterDelay(attempt++,random))}
    function connect(){
      if(stopped)return;
      try{socket=new WebSocketImpl(options.url)}catch(e){options.onError&&options.onError(e);scheduleReconnect();poll();return}
      socket.onopen=()=>{options.onStatus&&options.onStatus('connected');scheduleHeartbeat()};
      socket.onmessage=event=>{try{apply(JSON.parse(event.data),'realtime')}catch(e){options.onError&&options.onError(e)}};
      socket.onerror=()=>{};
      socket.onclose=()=>{socket=null;if(heartbeatTimer){timers.clearTimeout(heartbeatTimer);heartbeatTimer=null}options.onStatus&&options.onStatus('reconnecting');poll();scheduleReconnect()};
    }
    function stop(){stopped=true;for(const id of [retryTimer,pollTimer,heartbeatTimer])if(id)timers.clearTimeout(id);if(socket)socket.close(1000,'page closed')}
    return {start:connect,stop,apply,getVersion:()=>lastVersion,getAttempt:()=>attempt};
  }
  root.DoxomachyRealtime={create,jitterDelay,jitter};
})(typeof globalThis==='object'?globalThis:this);
