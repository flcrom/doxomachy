(function(root){
 function submitsOnKey(e){return !!e&&e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.isComposing&&e.keyCode!==229}
 function blocksNewline(e){return !!e&&e.key==='Enter'&&!e.isComposing&&e.keyCode!==229}
 function singleLine(text){return String(text).replace(/\r\n|[\r\n]/g,' ')}
 function seconds(ms){return Math.floor(Math.max(0,Number(ms)||0)/1000)}
 function shortAge(ms){const s=seconds(ms);return s<60?`${s}s`:s<3600?`${Math.floor(s/60)}m`:`${Math.floor(s/3600)}h`}
 function plural(n,unit){return `${n} ${unit}${n===1?'':'s'}`}
 function spokenAge(ms){const s=seconds(ms);return s<5?'a few seconds':s<60?plural(s,'second'):s<3600?plural(Math.floor(s/60),'minute'):plural(Math.floor(s/3600),'hour')}
 function statusLabel(mode,generatedAt,now=Date.now()){if(mode==='live')return 'Live now';if(mode==='starting')return 'Connecting…';if(!generatedAt)return 'Read-only · freshness unknown';return `${mode==='stale'?'Stale':'Read-only'} · ${shortAge(now-generatedAt)} old`}
 function announcementKey(mode,generatedAt){if(mode==='live'||mode==='starting')return mode;return generatedAt?(mode==='stale'?'stale':'read-only'):'unknown'}
 function announcement(mode,generatedAt,now=Date.now()){const key=announcementKey(mode,generatedAt);if(key==='starting')return '';if(key==='live')return 'Live memory connected. Moves are open.';if(key==='unknown')return 'Live memory is unavailable. Moves are locked.';const age=spokenAge(now-generatedAt);return key==='stale'?`Memory is stale. Last update ${age} ago. Moves are locked.`:`Showing saved memory from ${age} ago. Moves are locked until live service returns.`}
 root.DoxomachyA11y={submitsOnKey,blocksNewline,singleLine,shortAge,spokenAge,statusLabel,announcementKey,announcement};
})(typeof globalThis==='object'?globalThis:this);
