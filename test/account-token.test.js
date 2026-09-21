// Behavioral checks for account-token.js (the 30-day persistent sign-in).
// The script is evaluated in a fresh context per "browser launch" over a
// shared localStorage stub, which simulates a full browser restart.
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const src=fs.readFileSync(path.join(__dirname,'..','account-token.js'),'utf8');

function launch(store,now){
 const localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
 const ctx=vm.createContext({localStorage,Date:{...Date,now:()=>now}});
 vm.runInContext(src,ctx);
 return {save:ctx.saveAccountToken,load:ctx.loadAccountToken,clear:ctx.clearAccountToken};
}

test('sign-in persists across a full browser restart',()=>{
 const store=new Map(),t0=1_800_000_000_000;
 const first=launch(store,t0);
 first.save('tok-abc',2_592_000); // 30 days
 const restarted=launch(store,t0+86_400_000); // next day, new browser session
 assert.equal(restarted.load(),'tok-abc');
});

test('an expired token is rejected and cleared',()=>{
 const store=new Map(),t0=1_800_000_000_000;
 launch(store,t0).save('tok-abc',2_592_000);
 const later=launch(store,t0+2_592_000_000+1); // 30 days + 1ms
 assert.equal(later.load(),'');
 assert.equal(store.size,0);
});

test('clearing removes both keys; missing storage never throws',()=>{
 const store=new Map(),t0=1_800_000_000_000;
 const s=launch(store,t0);
 s.save('tok-abc',100);s.clear();
 assert.equal(s.load(),'');assert.equal(store.size,0);
 const bare=vm.createContext({localStorage:{getItem(){throw new Error('denied')},setItem(){throw new Error('denied')},removeItem(){throw new Error('denied')}},Date});
 vm.runInContext(src,bare);
 assert.equal(bare.loadAccountToken(),'');
 bare.saveAccountToken('x',1); // must not throw
});
