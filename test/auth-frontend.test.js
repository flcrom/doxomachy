// Static checks for the account/callback pages and their wiring against the
// worker contract. Catches CSP-breaking inline code, missing element ids,
// and token-format drift between callback.js and the worker.
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

test('auth pages use external scripts only, no inline styles or handlers',()=>{
 for(const page of ['account.html','callback.html','index.html']){
  const html=read(page);
  assert.ok(!/style=/.test(html),`${page} has inline style`);
  assert.ok(!/<style/i.test(html),`${page} has a style block`);
  assert.ok(!/\son[a-z]+=/i.test(html),`${page} has an inline handler`);
  for(const m of html.matchAll(/<script[^>]*src="([^"]+)"/g))assert.ok(!/^https?:/.test(m[1]),`${page} loads remote script ${m[1]}`);
 }
});

test('every element id referenced by account.js and callback.js exists in its page',()=>{
 for(const [js,html] of [['account.js','account.html'],['callback.js','callback.html'],['app.js','index.html']]){
  const scripts=read(js),page=read(html);
  const ids=new Set([...scripts.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m=>m[1]));
  for(const id of ids)assert.ok(page.includes(`id="${id}"`),`${js} references #${id} missing from ${html}`);
 }
});

test('callback token regex matches the worker token format',()=>{
 assert.ok(read('callback.js').includes('[A-Za-z0-9_-]{43}'));
 assert.ok(read('worker/src/auth.ts').includes('/^[A-Za-z0-9_-]{43}$/'));
});

test('callback.js strips the fragment before any network call',()=>{
 const js=read('callback.js');
 assert.ok(js.indexOf('history.replaceState')<js.indexOf("fetch("), 'fragment must be stripped before verify call');
});

test('vercel.json pins CSP, nosniff and frame denial for static hosting',()=>{
 const v=JSON.parse(read('vercel.json'));
 const all=v.headers.flatMap(h=>h.headers.map(x=>`${x.key}:${x.value}`)).join('\n');
 assert.match(all,/content-security-policy:.*script-src 'self'/);
 assert.match(all,/content-security-policy:.*connect-src 'self' https:\/\/doxomachy\.matlabdec12\.workers\.dev/);
 assert.match(all,/content-security-policy:.*frame-ancestors 'none'/);
 assert.match(all,/x-content-type-options:nosniff/);
});

test('styles.css defines the auth classes account.html uses',()=>{
 const css=read('styles.css'),html=read('account.html');
 for(const cls of [...html.matchAll(/class="([^"]+)"/g)].flatMap(m=>m[1].split(' ')).filter(c=>c.startsWith('auth-')))
  assert.ok(css.includes('.'+cls),`styles.css missing .${cls}`);
});

test('account bearer persists in localStorage via account-token.js on every page',()=>{
 for(const page of ['index.html','account.html','callback.html']){
  const html=read(page);
  const tokenTag=html.indexOf('<script src="account-token.js"></script>');
  assert.ok(tokenTag>-1,`${page} must load account-token.js`);
  for(const consumer of ['app.js','account.js','callback.js'])
   if(html.includes(`<script src="${consumer}"></script>`))
    assert.ok(html.indexOf(`<script src="${consumer}"></script>`)>tokenTag,`${page} must load account-token.js before ${consumer}`);
 }
 assert.ok(read('callback.js').includes('saveAccountToken(d.session,d.expiresIn)'));
 for(const js of ['app.js','account.js','callback.js'])
  assert.ok(!read(js).includes("sessionStorage.getItem('doxomachy-account')"),`${js} still uses sessionStorage for the account bearer`);
 assert.ok(read('account-token.js').includes('localStorage.setItem'));
 assert.ok(read('account-token.js').includes('ACCOUNT_TOKEN_EXP_KEY'),'expiry must be tracked beside the token');
});

test('sign-in copy never claims other devices are signed out',()=>{
 const html=read('account.html');
 assert.ok(html.includes('Each device stays signed in for 30 days until you sign out.'));
 assert.ok(!html.includes('signs out the old ones'));
 assert.ok(!read('callback.js').includes('Other devices were signed out'));
});

test('the hidden attribute always hides, so anonymous users never see Paid moves 0',()=>{
 assert.ok(read('styles.css').includes('[hidden]{display:none!important}'));
 assert.ok(read('app.js').includes('row.hidden=true'));
});

test('paid moves cannot double-submit while in flight',()=>{
 const app=read('app.js');
 assert.ok(app.includes('let paidBusy=false;'),'paidMove re-entry guard missing');
 assert.ok(app.includes('if(paidBusy)return false'),'paidMove re-entry guard missing');
 assert.ok(app.includes('finally{paidBusy=false}'),'paidMove guard never resets');
 assert.ok(app.includes('sb.disabled=true'),'paid submit button is not disabled in flight');
});
