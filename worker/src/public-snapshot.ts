export type PublicSnapshot={type:'snapshot';version:number;beliefs:unknown[];cycle:number;diary:unknown;generatedAt:number};
type SnapshotEnv={PUBLIC_SNAPSHOT?:R2Bucket};
const KEY='public-mind.json';
export function makePublicSnapshot(value:{version?:number;beliefs:unknown[];cycle:number;diary?:unknown},generatedAt=Date.now()):PublicSnapshot{
 return {type:'snapshot',version:value.version||0,beliefs:value.beliefs,cycle:value.cycle,diary:value.diary??null,generatedAt};
}
export async function publishIfNewer(env:SnapshotEnv,snapshot:PublicSnapshot):Promise<'published'|'current'|'disabled'|'failed'> {
 if(!env.PUBLIC_SNAPSHOT)return 'disabled';
 try{const prior=await env.PUBLIC_SNAPSHOT.head(KEY);const priorVersion=Number(prior?.customMetadata?.version??-1);if(Number.isSafeInteger(priorVersion)&&priorVersion>=snapshot.version)return 'current';await env.PUBLIC_SNAPSHOT.put(KEY,JSON.stringify(snapshot),{httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'public, s-maxage=2, stale-while-revalidate=30, stale-if-error=86400'},customMetadata:{version:String(snapshot.version),generatedAt:String(snapshot.generatedAt)}});return 'published'}catch{return 'failed'}
}
export async function snapshotLag(env:SnapshotEnv,wantedVersion:number){if(!env.PUBLIC_SNAPSHOT)return {enabled:false,publishedVersion:null,lag:null};try{const head=await env.PUBLIC_SNAPSHOT.head(KEY),publishedVersion=Number(head?.customMetadata?.version??-1);return {enabled:true,publishedVersion:Number.isSafeInteger(publishedVersion)?publishedVersion:null,lag:Number.isSafeInteger(publishedVersion)?Math.max(0,wantedVersion-publishedVersion):null}}catch{return {enabled:true,publishedVersion:null,lag:null}}}
