const test=require('node:test');const assert=require('node:assert/strict');
const tokens=t=>Math.max(1,Math.ceil(t.trim().length/4));
const weight=m=>m.shields*1000+m.created/1e10;
test('token estimate is deterministic and nonzero',()=>{assert.equal(tokens('12345678'),2);assert.equal(tokens(''),1)});
test('more shields always beat age',()=>{assert.ok(weight({shields:2,created:0})>weight({shields:1,created:Date.now()}))});
test('weakest belief evicts first',()=>{const memories=[{id:'old',shields:1,created:1},{id:'new',shields:1,created:2},{id:'safe',shields:2,created:0}];assert.equal([...memories].sort((a,b)=>weight(a)-weight(b))[0].id,'old')});
test('input policy rejects web links',()=>{const blocked=t=>/https?:\/\/|www\./i.test(t);assert.equal(blocked('visit https://example.com'),true);assert.equal(blocked('software should be clear'),false)});
