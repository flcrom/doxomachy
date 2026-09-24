import {describe,expect,it,vi,afterEach} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleProfile,validLink,validImage,reviewToken,readReviewToken,NAME_RE,publicIdentity} from '../src/profile';
import {sha256Hex} from '../src/auth';

const DIR=join(dirname(fileURLToPath(import.meta.url)),'..','migrations');
function setup(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 for(const f of readdirSync(DIR).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(join(DIR,f),'utf8'));
 const stmt=(sql:string,p:any[]=[])=>({run:async()=>({meta:{changes:Number(db.prepare(sql).run(...p).changes)}}),first:async()=>db.prepare(sql).get(...p)??null,all:async()=>({results:db.prepare(sql).all(...p)})});
 const DB:any={prepare:(sql:string)=>({bind:(...p:any[])=>stmt(sql,p),...stmt(sql)})};
 return {db,env:{DB,AUTH_EMAIL_PEPPER:'pep',RESEND_API_KEY:'re',AUTH_FROM:'D <login@doxomachy.flcrom.dev>',REVIEW_TO:'review@flcrom.dev',WEB_ORIGIN:'https://doxomachy.flcrom.dev'} as any};
}
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
const TOKEN='A'.repeat(43);
async function signedIn(db:DatabaseSync){db.prepare("INSERT INTO accounts (id,email_hmac,created_at) VALUES ('a1','h',1)").run();db.prepare('INSERT INTO account_sessions (token_hash,account_id,created_at,expires_at) VALUES (?,?,?,?)').run(await sha256Hex(TOKEN),'a1',1,9e15)}
const put=(body:unknown)=>new Request('https://api.x/v1/profile',{method:'PUT',headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body)});
const PNG='data:image/png;base64,'+btoa('x'.repeat(300));
afterEach(()=>vi.unstubAllGlobals());

describe('profile validation',()=>{
 it('names: letters, numbers, dashes only',()=>{for(const ok of ['sam','Sam-99','a-b-c'])expect(NAME_RE.test(ok)).toBe(true);for(const bad of ['sam.com','a:b','a/b','a b','x'.repeat(25),'','ünï'])expect(NAME_RE.test(bad)).toBe(false)});
 it('links must be https with a real host',()=>{expect(validLink('https://example.com/x')).toBe('https://example.com/x');for(const bad of ['http://e.com','javascript:alert(1)','https://localhost','https://u:p@e.com','ftp://e.com'])expect(validLink(bad)).toBeNull()});
 it('images: small jpeg/png/webp data URLs only',()=>{expect(validImage(PNG)).toBe(PNG);expect(validImage('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();expect(validImage('data:image/png;base64,'+'A'.repeat(140000))).toBeNull()});
 it('review tokens are signed, bound to the value, and expire',async()=>{
  const env={AUTH_EMAIL_PEPPER:'pep'} as any;const t=await reviewToken(env,'a1','link','https://e.com/',1000);
  expect(await readReviewToken(env,t,2000)).toMatchObject({a:'a1',f:'link'});
  expect(await readReviewToken(env,t.slice(0,-2)+'xx',2000)).toBeNull();
  expect(await readReviewToken({AUTH_EMAIL_PEPPER:'other'} as any,t,2000)).toBeNull();
  expect(await readReviewToken(env,t,1000+31*86_400_000)).toBeNull();
 });
});

describe('profile flow (real SQLite)',()=>{
 it('name is live at once; image and link stay hidden until approved by email',async()=>{
  const {db,env}=setup();await signedIn(db);
  const mails:any[]=[];vi.stubGlobal('fetch',async(_u:any,i:any)=>{mails.push(JSON.parse(i.body));return new Response('{}',{status:200})});
  const r=await handleProfile(put({name:'sam-1',link:'https://sam.example/',image:PNG}),env,undefined,json);
  expect(r!.status).toBe(200);const own:any=await r!.json();
  expect(own).toMatchObject({name:'sam-1',link:null,link_pending:'https://sam.example/',image:null,image_pending:true});
  expect(await publicIdentity(env,'a1')).toMatchObject({name:'sam-1'});
  expect(mails).toHaveLength(2);expect(mails.every(m=>m.to[0]==='review@flcrom.dev')).toBe(true);expect(mails[0].attachments[0].filename).toBe('profile.png');
  const pub=async()=>(await (await handleProfile(new Request(`https://api.x/v1/profiles?ids=${own.public_id}`),env,undefined,json))!.json() as any).profiles[own.public_id];
  expect(await pub()).toEqual({name:'sam-1',image:null,link:null});
  const linkUrl=new URL(mails.find(m=>m.subject.includes('link')).text.match(/Review: (\S+)/)[1]);const t=linkUrl.searchParams.get('t')!;
  // GET only shows the page (mail scanners prefetch); nothing changes
  const page=await handleProfile(new Request(linkUrl.toString()),env,undefined,json);expect(await page!.text()).toContain('Approve');
  expect((await pub()).link).toBeNull();
  const form=new FormData();form.set('t',t);form.set('d','approve');
  const done=await handleProfile(new Request('https://api.x/v1/review',{method:'POST',body:form}),env,undefined,json);
  expect(await done!.text()).toContain('Approved');
  expect((await pub()).link).toBe('https://sam.example/');
  // the same link cannot be used again
  const again=await handleProfile(new Request('https://api.x/v1/review',{method:'POST',body:form}),env,undefined,json);expect(await again!.text()).toContain('Already decided');
  // reject the image: stays hidden
  const imgT=new URL(mails.find(m=>m.subject.includes('image')).text.match(/Review: (\S+)/)[1]).searchParams.get('t')!;
  const rf=new FormData();rf.set('t',imgT);rf.set('d','reject');await handleProfile(new Request('https://api.x/v1/review',{method:'POST',body:rf}),env,undefined,json);
  expect((await pub()).image).toBeNull();
 });
 it('a changed value makes the old review link stale',async()=>{
  const {db,env}=setup();await signedIn(db);
  const mails:any[]=[];vi.stubGlobal('fetch',async(_u:any,i:any)=>{mails.push(JSON.parse(i.body));return new Response('{}')});
  await handleProfile(put({link:'https://one.example/'}),env,undefined,json);
  await handleProfile(put({link:'https://two.example/'}),env,undefined,json);
  const t=new URL(mails[0].text.match(/Review: (\S+)/)[1]).searchParams.get('t')!;
  const f=new FormData();f.set('t',t);f.set('d','approve');
  expect(await (await handleProfile(new Request('https://api.x/v1/review',{method:'POST',body:f}),env,undefined,json))!.text()).toContain('Already decided');
  // re-saving the same pending link does not send another review email
  await handleProfile(put({name:'x',link:'https://two.example/'}),env,undefined,json);
  expect(mails).toHaveLength(2);
 });
 it('rejects bad names, links and images',async()=>{
  const {db,env}=setup();await signedIn(db);vi.stubGlobal('fetch',async()=>new Response('{}'));
  expect((await handleProfile(put({name:'site.com'}),env,undefined,json))!.status).toBe(400);
  expect((await handleProfile(put({link:'http://x.com'}),env,undefined,json))!.status).toBe(400);
  expect((await handleProfile(put({image:'data:text/html;base64,AAAA'}),env,undefined,json))!.status).toBe(400);
  expect((await handleProfile(new Request('https://api.x/v1/profile',{method:'PUT',body:'{}'}),env,undefined,json))!.status).toBe(401);
 });
});
