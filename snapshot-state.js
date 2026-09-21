(function(root){
 const MAX_FUTURE_MS=60000;
 function valid(d,now=Date.now()){return !!d&&Number.isSafeInteger(d.version)&&d.version>=0&&Array.isArray(d.beliefs)&&Number.isFinite(d.cycle)&&Number.isSafeInteger(d.generatedAt)&&d.generatedAt>0&&d.generatedAt<=now+MAX_FUTURE_MS}
 function freshness(d,now=Date.now(),maxAge=10000){if(!valid(d,now))return 'invalid';return now-d.generatedAt>maxAge?'stale':'read-only'}
 function shouldPersist(incoming,acceptedVersion,now=Date.now()){return valid(incoming,now)&&incoming.version>=acceptedVersion}
 root.DoxomachySnapshotState={valid,freshness,shouldPersist};
})(typeof globalThis==='object'?globalThis:this);
