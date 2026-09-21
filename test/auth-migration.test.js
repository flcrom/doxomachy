// Real-SQLite checks for the auth migration and its production SQL shapes.
// Runs against node:sqlite (apply --experimental-sqlite). The statement
// strings below must stay byte-identical to worker/src/auth.ts; the drift
// guard at the bottom enforces that.
const test=require('node:test');const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');
const m1=fs.readFileSync(path.join(root,'worker/migrations/0001.sql'),'utf8');
const m2=fs.readFileSync(path.join(root,'worker/migrations/0002.sql'),'utf8');
const rollback=fs.readFileSync(path.join(root,'docs/runbooks/0002-auth-rollback.sql'),'utf8');

const SQL={
 verifyConsume:'UPDATE magic_links SET consumed_at = ?, consume_key = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?',
 verifySession:'INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at, revoked_at) SELECT ?, account_id, ?, ?, NULL FROM magic_links WHERE consume_key = ?',
 creditSpendGuarded:'UPDATE credits SET balance = balance - 1, updated_at = ? WHERE subject = ? AND balance >= 1 AND EXISTS (SELECT 1 FROM paid_spends WHERE key = ? AND resolver = ?)',
 creditDeleteZero:'DELETE FROM credits WHERE subject = ? AND balance <= 0',
 deleteAccount:'DELETE FROM accounts WHERE id = ?',
 rateHit:'UPDATE auth_rate_limits SET count = count + 1 WHERE key = ? AND count < ?',
 prune3:"DELETE FROM paid_spends WHERE status <> 'pending' AND ? - created_at >= ?",
 paidSpendInsert:"INSERT OR IGNORE INTO paid_spends (key, account_id, status, created_at, resolved_at, resolver) SELECT ?, ?, 'pending', ?, NULL, ? WHERE (SELECT balance FROM credits WHERE subject = ?) >= 1",
 paidSpendClaim:"UPDATE paid_spends SET status = ?, resolved_at = ?, resolver = ? WHERE key = ? AND status = 'pending'",
 paidSpendRefundGuarded:'UPDATE credits SET balance = balance + 1, updated_at = ? WHERE subject = ? AND EXISTS (SELECT 1 FROM paid_spends WHERE key = ? AND resolver = ?)',
 accountRekey:'UPDATE accounts SET email_hmac = ?, pepper_id = ? WHERE email_hmac = ?'
};

function freshDb(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');db.exec(m1);db.exec(m2);return db}
function seedAccount(db,id='acc1'){db.prepare('INSERT INTO accounts (id,email_hmac,pepper_id,created_at) VALUES (?,?,?,?)').run(id,'h1','pepper1',100)}
function seedLink(db,hash,acc='acc1',expires=1_000_000){db.prepare('INSERT INTO magic_links (token_hash,account_id,email_hmac,expires_at,consumed_at,consume_key,created_at) VALUES (?,?,?,?,NULL,NULL,?)').run(hash,acc,'h1',expires,100)}
function verifyBatch(db,hash,now,consumeKey,sessionHash){
 db.exec('BEGIN');
 try{
  const c=db.prepare(SQL.verifyConsume).run(now,consumeKey,hash,now);
  const ins=db.prepare(SQL.verifySession).run(sessionHash,now,now+2_592_000_000,consumeKey);
  db.exec('COMMIT');
  return {consumed:c.changes,inserted:ins.changes};
 }catch(e){db.exec('ROLLBACK');throw e}
}
const liveSessions=db=>db.prepare('SELECT * FROM account_sessions WHERE revoked_at IS NULL').all();

test('migrations apply twice idempotently and create expected indexes',()=>{
 const db=freshDb();db.exec(m2); // IF NOT EXISTS re-apply
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r=>r.name);
 for(const idx of ['magic_links_email','magic_links_expiry','account_sessions_account','account_sessions_expiry','auth_rate_limits_window','paid_spends_created','paid_spends_pending','paid_spends_stale'])
  assert.ok(names.includes(idx),`missing index ${idx}`);
});

test('schema carries pepper bookkeeping and no login-revocation columns',()=>{
 const db=freshDb();
 const accounts=db.prepare("PRAGMA table_info(accounts)").all().map(r=>r.name);
 assert.ok(accounts.includes('pepper_id'));
 assert.ok(!accounts.includes('session_epoch'),'session_epoch must be gone: login never revokes');
 const sessions=db.prepare("PRAGMA table_info(account_sessions)").all().map(r=>r.name);
 assert.ok(!sessions.includes('epoch'),'session epoch column must be gone');
 const spends=db.prepare("PRAGMA table_info(paid_spends)").all().map(r=>r.name);
 for(const c of ['status','resolved_at'])assert.ok(spends.includes(c),`paid_spends.${c}`);
});

test('foreign keys reject orphan sessions, links and paid spends',()=>{
 const db=freshDb();
 assert.throws(()=>db.prepare('INSERT INTO account_sessions (token_hash,account_id,created_at,expires_at,revoked_at) VALUES (?,?,1,2,NULL)').run('s','ghost'));
 assert.throws(()=>db.prepare('INSERT INTO magic_links (token_hash,account_id,email_hmac,expires_at,consumed_at,consume_key,created_at) VALUES (?,?,?,1,NULL,NULL,1)').run('l','ghost','h'));
 db.prepare("INSERT INTO credits (subject,balance,updated_at) VALUES ('ghost',1,0)").run();
 assert.throws(()=>db.prepare(SQL.paidSpendInsert).run('k','ghost',1,'r','ghost'));
});

test('verify batch: one-time consume and fail-closed boundary',()=>{
 const db=freshDb();seedAccount(db);seedLink(db,'h');
 const r=verifyBatch(db,'h',500,'ck1','s1');
 assert.equal(r.consumed,1);assert.equal(r.inserted,1);
 const replay=verifyBatch(db,'h',600,'ck2','s2');
 assert.equal(replay.consumed,0);assert.equal(replay.inserted,0);
 assert.equal(liveSessions(db).length,1);
 const atBoundary=db.prepare(SQL.verifyConsume).run(1_000_000,'ck3','h2',1_000_000);
 assert.equal(atBoundary.changes,0); // expires_at > now, strict
});

test('concurrent sign-ins on one account keep every session live',()=>{
 const db=freshDb();seedAccount(db);seedLink(db,'h1');seedLink(db,'h2');
 verifyBatch(db,'h1',500,'c1','sA');verifyBatch(db,'h2',600,'c2','sB');
 assert.equal(liveSessions(db).length,2); // no epoch, no revocation on login
 // only explicit sign-out-all revokes
 db.prepare('UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL').run(700,'acc1');
 assert.equal(liveSessions(db).length,0);
});

test('spend marker and decrement are guarded and atomic at the boundary',()=>{
 for(const balance of [0,1]){
  const db=freshDb();seedAccount(db);
  db.prepare("INSERT INTO credits (subject,balance,updated_at) VALUES ('acc1',?,0)").run(balance);
  const ins=db.prepare(SQL.paidSpendInsert).run('k1','acc1',1,'r1','acc1');
  const dec=db.prepare(SQL.creditSpendGuarded).run(1,'acc1','k1','r1');
  if(balance===0){
   assert.equal(ins.changes,0,'no marker when the balance cannot cover it');
   assert.equal(dec.changes,0);
   assert.equal(db.prepare('SELECT count(*) c FROM paid_spends').get().c,0,'no pending marker may survive without a decrement');
  }else{
   assert.equal(ins.changes,1);assert.equal(dec.changes,1);
   assert.equal(db.prepare('SELECT balance FROM credits WHERE subject=?').get('acc1').balance,0);
   // replay with a foreign resolver can neither insert nor decrement again
   assert.equal(db.prepare(SQL.paidSpendInsert).run('k1','acc1',2,'r2','acc1').changes,0);
   assert.equal(db.prepare(SQL.creditSpendGuarded).run(2,'acc1','k1','r2').changes,0);
  }
 }
});

test('pending spend lifecycle: insert, then a single conditional claim wins',()=>{
 const db=freshDb();seedAccount(db);
 db.prepare("INSERT INTO credits (subject,balance,updated_at) VALUES ('acc1',2,0)").run();
 assert.equal(db.prepare(SQL.paidSpendInsert).run('k1','acc1',1,'r0','acc1').changes,1);
 assert.equal(db.prepare(SQL.paidSpendInsert).run('k1','acc1',2,'r0','acc1').changes,0); // idempotent
 assert.equal(db.prepare(SQL.paidSpendClaim).run('spent',3,'r1','k1').changes,1);
 assert.equal(db.prepare(SQL.paidSpendClaim).run('refunded',4,'r2','k1').changes,0,'second claim must lose');
 const row=db.prepare('SELECT status,resolver FROM paid_spends WHERE key=?').get('k1');
 assert.equal(row.status,'spent');assert.equal(row.resolver,'r1');
});

test('a retry after pruning can never charge a second credit for a cached move',()=>{
 const db=freshDb();seedAccount(db);
 db.prepare("INSERT INTO credits (subject,balance,updated_at) VALUES ('acc1',1,0)").run();
 db.prepare(SQL.paidSpendInsert).run('k1','acc1',1,'r0','acc1');
 db.prepare(SQL.creditSpendGuarded).run(1,'acc1','k1','r0'); // balance now 0, move applied
 db.prepare(SQL.paidSpendClaim).run('spent',2,'do','k1');
 const TTL=30*86_400_000; // must stay ahead of the 7-day DO idempotency retention
 // 25h later, daily pruning runs: the resolved marker MUST survive
 db.prepare(SQL.prune3).run(1+25*3_600_000,TTL);
 assert.equal(db.prepare('SELECT count(*) c FROM paid_spends WHERE key=?').get('k1').c,1,'resolved marker pruned while the DO could still hold the key');
 // the retry hits the surviving marker: no new insert, no second decrement
 assert.equal(db.prepare(SQL.paidSpendInsert).run('k1','acc1',3,'r9','acc1').changes,0);
 assert.equal(db.prepare(SQL.creditSpendGuarded).run(3,'acc1','k1','r9').changes,0);
 assert.equal(db.prepare('SELECT balance FROM credits WHERE subject=?').get('acc1').balance,0);
 // past 30 days the marker is gone, but the DO's 7-day record is long gone
 // too, so a reused key is a genuinely new purchase
 db.prepare(SQL.prune3).run(1+31*86_400_000,TTL);
 assert.equal(db.prepare('SELECT count(*) c FROM paid_spends WHERE key=?').get('k1').c,0);
});

test('concurrent reconcilers cannot double-credit a refund, in either commit order',()=>{
 for(const first of ['r1','r2']){
  const db=freshDb();seedAccount(db);
  db.prepare("INSERT INTO credits (subject,balance,updated_at) VALUES ('acc1',1,0)").run();
  db.prepare(SQL.paidSpendInsert).run('k1','acc1',1,'r0','acc1');
  db.prepare(SQL.creditSpendGuarded).run(1,'acc1','k1','r0'); // model the atomic batch's decrement
  const second=first==='r1'?'r2':'r1';
  // Both reconcilers run the same claim+refund transaction; only the first
  // claim wins, and only the winner's nonce satisfies the refund guard.
  assert.equal(db.prepare(SQL.paidSpendClaim).run('refunded',3,first,'k1').changes,1);
  assert.equal(db.prepare(SQL.paidSpendClaim).run('refunded',4,second,'k1').changes,0);
  assert.equal(db.prepare(SQL.paidSpendRefundGuarded).run(3,'acc1','k1',first).changes,1);
  assert.equal(db.prepare(SQL.paidSpendRefundGuarded).run(4,'acc1','k1',second).changes,0);
  assert.equal(db.prepare('SELECT balance FROM credits WHERE subject=?').get('acc1').balance,1);
 }
});

test('a settle claim that wins blocks a later refund claim from crediting',()=>{
 const db=freshDb();seedAccount(db);
 db.prepare("INSERT INTO credits (subject,balance,updated_at) VALUES ('acc1',1,0)").run();
 db.prepare(SQL.paidSpendInsert).run('k1','acc1',1,'r0','acc1');
 db.prepare(SQL.creditSpendGuarded).run(1,'acc1','k1','r0'); // model the atomic batch's decrement
 assert.equal(db.prepare(SQL.paidSpendClaim).run('spent',3,'do','k1').changes,1);
 assert.equal(db.prepare(SQL.paidSpendClaim).run('refunded',4,'reconciler','k1').changes,0);
 assert.equal(db.prepare(SQL.paidSpendRefundGuarded).run(4,'acc1','k1','reconciler').changes,0);
 assert.equal(db.prepare('SELECT balance FROM credits WHERE subject=?').get('acc1').balance,0);
});

test('deletion trigger aborts the account delete on a raced balance and rolls the whole batch back',()=>{
 const db=freshDb();seedAccount(db);seedLink(db,'h');
 db.prepare("INSERT INTO account_sessions (token_hash,account_id,created_at,expires_at,revoked_at) VALUES ('s1','acc1',100,999999,NULL)").run();
 db.prepare("INSERT INTO credits (subject,balance,updated_at) VALUES ('acc1',1,0)").run();
 db.prepare(SQL.paidSpendInsert).run('k1','acc1',1,'r0','acc1');
 db.prepare(SQL.creditSpendGuarded).run(1,'acc1','k1','r0'); // model the atomic batch's decrement
 db.prepare(SQL.paidSpendClaim).run('spent',3,'do','k1');
 // A grant commits between the worker's pre-check and its batch. D1 batches
 // are serialized, so in production the grant is either fully before (this
 // case) or fully after the batch; the trigger covers the before case.
 db.prepare('UPDATE credits SET balance = 5 WHERE subject = ?').run('acc1');
 db.exec('BEGIN');
 db.prepare('DELETE FROM account_sessions WHERE account_id = ?').run('acc1');
 db.prepare('DELETE FROM magic_links WHERE account_id = ?').run('acc1');
 db.prepare('DELETE FROM paid_spends WHERE account_id = ?').run('acc1');
 db.prepare(SQL.creditDeleteZero).run('acc1'); // changes 0: balance is now positive
 assert.throws(()=>db.prepare(SQL.deleteAccount).run('acc1'),/credits_remaining/);
 db.exec('ROLLBACK');
 assert.equal(db.prepare('SELECT count(*) c FROM accounts').get().c,1);
 assert.equal(db.prepare('SELECT count(*) c FROM account_sessions').get().c,1);
 assert.equal(db.prepare('SELECT count(*) c FROM magic_links').get().c,1);
 assert.equal(db.prepare('SELECT count(*) c FROM paid_spends').get().c,1);
 assert.ok(db.prepare('SELECT balance FROM credits WHERE subject=?').get('acc1'),'credits row must survive the aborted deletion');
});

test('deletion removes a zero-balance account and its rows in one batch',()=>{
 const db=freshDb();seedAccount(db);seedLink(db,'h');
 db.prepare("INSERT INTO credits (subject,balance,updated_at) VALUES ('acc1',1,0)").run();
 db.prepare(SQL.paidSpendInsert).run('k1','acc1',1,'r0','acc1');
 db.prepare(SQL.creditSpendGuarded).run(1,'acc1','k1','r0'); // model the atomic batch's decrement
 db.exec('BEGIN');
 db.prepare('DELETE FROM account_sessions WHERE account_id = ?').run('acc1');
 db.prepare('DELETE FROM magic_links WHERE account_id = ?').run('acc1');
 db.prepare('DELETE FROM paid_spends WHERE account_id = ?').run('acc1');
 db.prepare(SQL.creditDeleteZero).run('acc1');
 db.prepare(SQL.deleteAccount).run('acc1');
 db.exec('COMMIT');
 assert.equal(db.prepare('SELECT count(*) c FROM accounts').get().c,0);
 assert.equal(db.prepare('SELECT count(*) c FROM credits WHERE subject=?').get('acc1').c,0,'zero-balance row must be removed with the account');
});

test('pepper re-key moves the lookup key and its fingerprint together',()=>{
 const db=freshDb();seedAccount(db);
 db.prepare(SQL.accountRekey).run('h2','pepper2','h1');
 const row=db.prepare('SELECT email_hmac,pepper_id FROM accounts WHERE id=?').get('acc1');
 assert.equal(row.email_hmac,'h2');assert.equal(row.pepper_id,'pepper2');
 // runbook gate: rows lagging the current fingerprint keep PREVIOUS alive
 assert.equal(db.prepare("SELECT count(*) c FROM accounts WHERE pepper_id != ?").get('pepper2').c,0);
});

test('conditional rate-limit increment caps at the limit',()=>{
 const db=freshDb();
 db.prepare("INSERT INTO auth_rate_limits (key,count,window_start) VALUES ('ip:1',4,0)").run();
 assert.equal(db.prepare(SQL.rateHit).run('ip:1',5).changes,1);
 assert.equal(db.prepare(SQL.rateHit).run('ip:1',5).changes,0);
 assert.equal(db.prepare(SQL.rateHit).run('ip:1',60).changes,1); // higher IP backstop still passes the same row
});

test('migration installs the deletion guard trigger',()=>{
 const db=freshDb();
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r=>r.name);
 assert.ok(names.includes('accounts_delete_credit_guard'),'missing deletion guard trigger');
});

test('rollback removes every 0002 table',()=>{
 const db=freshDb();db.exec(rollback);
 const triggers=db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r=>r.name);
 assert.ok(!triggers.includes('accounts_delete_credit_guard'),'trigger survived rollback');
 const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
 for(const t of ['accounts','magic_links','account_sessions','auth_rate_limits','paid_spends'])
  assert.ok(!names.includes(t),`${t} survived rollback`);
 assert.ok(names.includes('credits')); // 0001 tables untouched
});

test('drift guard: production auth.ts carries these exact statements',()=>{
 const src=fs.readFileSync(path.join(root,'worker/src/auth.ts'),'utf8');
 for(const [name,sql] of Object.entries(SQL))assert.ok(src.includes(`'${sql}'`)||src.includes(`"${sql}"`),`${name} drifted from auth.ts`);
});
