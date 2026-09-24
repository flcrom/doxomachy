// Accessibility checks for the static frontend: skip links, composer keyboard
// contract, freshness live region, mobile reading order and 44px targets.
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const pages=['index.html','account.html','callback.html','pricing.html','privacy.html','refunds.html','terms.html'];
function loadA11y(){const c={};vm.createContext(c);vm.runInContext(read('a11y.js'),c);return c.DoxomachyA11y}

test('every public page starts with a skip link to a focusable main target',()=>{
 for(const page of pages){
  const html=read(page),body=html.slice(html.indexOf('<body>')+6).trimStart();
  assert.ok(body.startsWith('<a class="skip-link" href="#main-content">Skip to main content</a>'),`${page} must open with the skip link`);
  assert.match(html,/<main id="main-content" class="shell" tabindex="-1">/,`${page} needs a focusable main target`);
  assert.equal((html.match(/id="main-content"/g)||[]).length,1,`${page} must have one main-content target`);
 }
});

test('composer keys: Enter submits, Shift+Enter and IME Enter never submit, line breaks are flattened',()=>{
 const A=loadA11y();
 assert.equal(A.submitsOnKey({key:'Enter'}),true);
 assert.equal(A.submitsOnKey({key:'Enter',shiftKey:true}),false);
 assert.equal(A.submitsOnKey({key:'Enter',altKey:true}),false);
 assert.equal(A.submitsOnKey({key:'Enter',isComposing:true}),false);
 assert.equal(A.submitsOnKey({key:'Enter',keyCode:229}),false);
 assert.equal(A.submitsOnKey({key:'a'}),false);
 assert.equal(A.blocksNewline({key:'Enter',shiftKey:true}),true,'beliefs are one line; the worker strips control characters');
 assert.equal(A.blocksNewline({key:'Enter',isComposing:true}),false);
 assert.equal(A.singleLine('one\ntwo\r\nthree\rfour'),'one two three four');
});

test('freshness label reports real ages and the live region only speaks on mode changes',()=>{
 const A=loadA11y(),now=1_000_000_000;
 assert.equal(A.statusLabel('live',now-5000,now),'Live now');
 assert.equal(A.statusLabel('starting',0,now),'Connecting…');
 assert.equal(A.statusLabel('read-only',0,now),'Read-only · freshness unknown');
 assert.equal(A.statusLabel('read-only',now-4000,now),'Read-only · 4s old');
 assert.equal(A.statusLabel('stale',now-125000,now),'Stale · 2m old');
 assert.equal(A.statusLabel('stale',now-2*3600000,now),'Stale · 2h old');
 assert.equal(A.announcementKey('read-only',now-3000),A.announcementKey('read-only',now-8000),'ticking seconds must not re-announce');
 assert.notEqual(A.announcementKey('read-only',now),A.announcementKey('stale',now));
 assert.equal(A.announcementKey('unavailable',0),'unknown');
 assert.equal(A.announcement('starting',0,now),'');
 assert.match(A.announcement('live',now,now),/Live memory connected/);
 assert.match(A.announcement('stale',now-61000,now),/stale\. Last update 1 minute ago\. Moves are locked/);
 assert.match(A.announcement('read-only',now-1000,now),/from a few seconds ago/);
 assert.match(A.announcement('read-only',now-7000,now),/from 7 seconds ago/);
 assert.match(A.announcement('stale',now-3600000,now),/1 hour ago/);
});

test('index wires the composer disclosure, error alert and freshness live region',()=>{
 const html=read('index.html'),js=read('app.js');
 assert.match(html,/id="openComposer"[^>]*aria-controls="composer"[^>]*aria-expanded="false"/);
 const describedby=html.match(/<textarea id="beliefText"[^>]*aria-describedby="([^"]+)"/);
 assert.ok(describedby,'textarea needs a description');
 for(const id of describedby[1].split(' '))assert.ok(html.includes(`id="${id}"`),`described-by target #${id} missing`);
 assert.match(html,/id="composerError"[^>]*role="alert"/);
 assert.match(html,/id="freshnessLive" class="sr-only" role="status" aria-live="polite" aria-atomic="true"/);
 assert.ok(!/id="updatedAt"[^>]*aria-live/.test(html),'the per-second label must not be a live region');
 assert.ok(!/id="charCount"[^>]*aria-live/.test(html),'character count must not announce every keystroke');
 assert.match(html,/id="memory-title" tabindex="-1"/);
 assert.ok(html.indexOf('<script src="a11y.js"></script>')>-1&&html.indexOf('<script src="a11y.js"></script>')<html.indexOf('<script src="app.js"></script>'),'a11y.js must load before app.js');
 assert.match(js,/beliefForm\.requestSubmit\(\)/);
 assert.match(js,/e\.key==='Escape'/);
 assert.match(js,/setAttribute\('aria-expanded','true'\)/);
 assert.match(js,/function hideComposer[^\n]*focusAfterComposer\(\)/);
 assert.match(js,/function composerError[^\n]*beliefText\.focus\(\)/);
 assert.match(js,/restoreListFocus\(list,focusId\)/,'re-rendering the ledger must not drop keyboard focus');
 assert.ok(!js.includes("$('#updatedAt').textContent=statusLabel()}},1000)"),'timer must go through updateFreshness');
});

test('small-screen CSS keeps DOM reading order, 44px targets and visible focus',()=>{
 const css=read('styles.css');
 assert.ok(!/\.status\{order:-1\}/.test(css),'status rail must not jump ahead of the ledger on mobile');
 for(const sel of ['.text-button,.shield-button','.wordmark,.footer a,.rule-note a,.fine a','.check','.alias input']){
  const rules=[...css.matchAll(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{([^}]*)\\}','g'))].map(m=>m[1]);
  assert.ok(rules.some(r=>/min-height:44px/.test(r)),`${sel} must be at least 44px tall`);
 }
 assert.match(css,/\.text-button,\.shield-button\{[^}]*min-width:44px/);
 assert.match(css,/\.wordmark,\.footer a,\.rule-note a,\.fine a\{[^}]*min-width:44px/);
 assert.match(css,/\.primary\{min-height:48px/);
 assert.match(css,/\.skip-link:focus\{transform:none;outline:3px solid var\(--ink\)/);
 assert.match(css,/button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible[^{]*\{outline:3px solid var\(--ink\)/);
 assert.ok(!/gradient|backdrop-filter|box-shadow:0/.test(css),'keep the flat black-and-white style');
});
