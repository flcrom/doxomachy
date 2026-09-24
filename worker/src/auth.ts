import { logEvent } from './observability';
// Email magic-link authentication for Doxomachy.
// Privacy posture: D1 stores no plaintext email. Lookup keys are
// HMAC-SHA256(secret pepper, normalized email). Bearer tokens (magic links
// and account sessions) are stored only as SHA-256 hashes.
//
// Concurrency posture: verification is one D1 batch (a single transaction).
// The consume writes a per-request consume_key, so a losing concurrent
// verifier changes nothing and a partial failure rolls the whole batch back
// (no burned links). Signing in never revokes other sessions: every device
// keeps its own 30-day session. The only bulk revocation is the explicit
// sign-out-all call, which revokes every live session of the account.

export const AUTH_LINK_TTL_MS = 15 * 60_000;          // proposed default: 15-minute links (owner answer pending)
export const AUTH_SESSION_TTL_MS = 30 * 86_400_000;   // proposed default: 30-day sessions (owner answer pending)
export const AUTH_RATE_LIMIT_EMAIL = 5;               // per-hour cap per email address
export const AUTH_RATE_LIMIT_IP = 60;                 // per-hour backstop per source IP; generous so NAT/campus networks are not locked out
export const AUTH_RATE_WINDOW_MS = 3_600_000;
// Resolved spend markers must outlive the Durable Object's idempotency
// retention (7 days) with a wide cushion: if D1 forgets a resolved key
// first, a retry of that key inserts a fresh marker, decrements a second
// credit, and the DO answers with its cached success - charging for no move.
export const PAID_SPEND_TTL_MS = 30 * 86_400_000;     // resolved idempotency marker retention
export const PAID_SPEND_RECONCILE_MS = 60_000;        // a pending spend older than this is reconciled against the Durable Object
export const PAID_SPEND_RECONCILE_BATCH = 25;          // cap per cleanup pass
// Hard bound on reconciliation: the Durable Object keeps idempotency
// records for 7 days, so a pending spend older than this can no longer be
// verified and is settled spent rather than refunded blind.
export const PAID_SPEND_RECONCILE_MAX_MS = 6 * 86_400_000;

export interface AuthEnv {
  DB: D1Database;
  WEB_ORIGIN: string;
  WEB_ORIGIN_EXTRA?: string;   // comma-separated extra allowed origins during domain cutover
  RESEND_API_KEY?: string;
  AUTH_EMAIL_PEPPER?: string;
  AUTH_EMAIL_PEPPER_PREVIOUS?: string; // rotation key ring: comma-separated older peppers, oldest resolution order. Each still resolves its accounts, which lazily re-key to the current pepper on next sign-in. Never remove an entry while accounts.pepper_id rows lag the current fingerprint (see runbook); dormant paid accounts may need it indefinitely.
  AUTH_FROM?: string;
}

export const authSql = {
  prune: [
    'DELETE FROM magic_links WHERE expires_at <= ?',
    'DELETE FROM account_sessions WHERE expires_at <= ?',
    'DELETE FROM auth_rate_limits WHERE ? - window_start >= ?',
    "DELETE FROM paid_spends WHERE status <> 'pending' AND ? - created_at >= ?"
  ],
  rateEnsure: 'INSERT OR IGNORE INTO auth_rate_limits (key, count, window_start) VALUES (?, 0, ?)',
  rateReset: 'UPDATE auth_rate_limits SET count = 0, window_start = ? WHERE key = ? AND ? - window_start >= ?',
  rateHit: 'UPDATE auth_rate_limits SET count = count + 1 WHERE key = ? AND count < ?',
  rateRefund: 'UPDATE auth_rate_limits SET count = count - 1 WHERE key = ? AND count > 0',
  accountUpsert: 'INSERT OR IGNORE INTO accounts (id, email_hmac, pepper_id, created_at) VALUES (?, ?, ?, ?)',
  accountSelect: 'SELECT id FROM accounts WHERE email_hmac = ?',
  accountRekey: 'UPDATE accounts SET email_hmac = ?, pepper_id = ? WHERE email_hmac = ?',
  linkInsert: 'INSERT INTO magic_links (token_hash, account_id, email_hmac, expires_at, consumed_at, consume_key, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
  linkDeleteUnused: 'DELETE FROM magic_links WHERE token_hash = ? AND consumed_at IS NULL',
  verifyConsume: 'UPDATE magic_links SET consumed_at = ?, consume_key = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?',
  verifySession: 'INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at, revoked_at) SELECT ?, account_id, ?, ?, NULL FROM magic_links WHERE consume_key = ?',
  linkAccount: 'SELECT account_id FROM magic_links WHERE token_hash = ?',
  sessionSelect: 'SELECT account_id, expires_at FROM account_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
  sessionRevokeOne: 'UPDATE account_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
  sessionRevokeAccount: 'UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL',
  creditsSelect: 'SELECT balance FROM credits WHERE subject = ?',
  creditSpendGuarded: 'UPDATE credits SET balance = balance - 1, updated_at = ? WHERE subject = ? AND balance >= 1 AND EXISTS (SELECT 1 FROM paid_spends WHERE key = ? AND resolver = ?)',
  creditRefund: 'UPDATE credits SET balance = balance + 1, updated_at = ? WHERE subject = ?',
  creditDeleteZero: 'DELETE FROM credits WHERE subject = ? AND balance <= 0',
  paidSpendInsert: "INSERT OR IGNORE INTO paid_spends (key, account_id, status, created_at, resolved_at, resolver) SELECT ?, ?, 'pending', ?, NULL, ? WHERE (SELECT balance FROM credits WHERE subject = ?) >= 1",
  paidSpendStatus: 'SELECT status FROM paid_spends WHERE key = ?',
  paidSpendClaim: "UPDATE paid_spends SET status = ?, resolved_at = ?, resolver = ? WHERE key = ? AND status = 'pending'",
  paidSpendRefundGuarded: 'UPDATE credits SET balance = balance + 1, updated_at = ? WHERE subject = ? AND EXISTS (SELECT 1 FROM paid_spends WHERE key = ? AND resolver = ?)',
  paidSpendPendingAccounts: "SELECT DISTINCT account_id FROM paid_spends WHERE status = 'pending' AND created_at < ? LIMIT 25",
  paidSpendPending: "SELECT key, created_at FROM paid_spends WHERE account_id = ? AND status = 'pending' AND created_at < ? LIMIT 10",
  deleteAccountSessions: 'DELETE FROM account_sessions WHERE account_id = ?',
  deleteAccountLinks: 'DELETE FROM magic_links WHERE account_id = ?',
  deleteAccountSpends: 'DELETE FROM paid_spends WHERE account_id = ?',
  deleteAccountRates: 'DELETE FROM auth_rate_limits WHERE key = ?',
  deleteAccount: 'DELETE FROM accounts WHERE id = ?',
  accountHmac: 'SELECT email_hmac FROM accounts WHERE id = ?'
} as const;

const encoder = new TextEncoder();

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const email = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return '';
  // Pragmatic shape check; the magic link itself is the real ownership proof.
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ? email : '';
}

export function isValidTokenFormat(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function emailHmac(pepper: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(email));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Short fingerprint of a pepper, stored on each account row. Rotation is
// safe to finish only when every row carries the current fingerprint:
// SELECT count(*) FROM accounts WHERE pepper_id != '<fingerprint>' must be 0
// before AUTH_EMAIL_PEPPER_PREVIOUS is removed, otherwise dormant accounts
// (including any holding paid credits) would be orphaned.
export async function pepperId(pepper: string): Promise<string> {
  return (await sha256Hex('doxomachy-pepper:' + pepper)).slice(0, 8);
}

// Only absolute HTTPS origins are ever trusted; anything else is dropped,
// which fails closed for CORS and for magic-link base URL construction.
export function validOrigin(value: string | undefined): value is string {
  return typeof value === 'string' && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(value);
}

export function allowedOrigins(env: AuthEnv): string[] {
  const list = [env.WEB_ORIGIN, ...(env.WEB_ORIGIN_EXTRA || '').split(',')].map(s => (s || '').trim());
  return list.filter(validOrigin);
}

// Returns the canonical configured origin matching the request Origin, or
// undefined when the request origin is absent/not allowlisted.
export function resolveOrigin(env: AuthEnv, origin: string): string | undefined {
  if (!origin) return undefined;
  return allowedOrigins(env).find(o => o === origin);
}

export function authConfigured(env: AuthEnv): boolean {
  return Boolean(env.DB && env.RESEND_API_KEY && env.AUTH_EMAIL_PEPPER && env.AUTH_FROM && validOrigin(env.WEB_ORIGIN));
}

async function prune(env: AuthEnv, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(authSql.prune[0]).bind(now),
    env.DB.prepare(authSql.prune[1]).bind(now),
    env.DB.prepare(authSql.prune[2]).bind(now, AUTH_RATE_WINDOW_MS),
    env.DB.prepare(authSql.prune[3]).bind(now, PAID_SPEND_TTL_MS)
  ]);
}

// One atomic conditional increment per check. Ordered two-bucket semantics:
// the email bucket is charged first; when the IP bucket is full the email
// charge is rolled back so neither bucket is burned by the other's rejection.
async function rateLimitOk(env: AuthEnv, emailKey: string, ipKey: string | null, now: number): Promise<boolean> {
  const hit = async (key: string, limit: number) => {
    await env.DB.prepare(authSql.rateEnsure).bind(key, now).run();
    await env.DB.prepare(authSql.rateReset).bind(now, key, now, AUTH_RATE_WINDOW_MS).run();
    return ((await env.DB.prepare(authSql.rateHit).bind(key, limit).run()).meta?.changes || 0) === 1;
  };
  if (!(await hit(emailKey, AUTH_RATE_LIMIT_EMAIL))) return false;
  // A missing CF-Connecting-IP skips the IP bucket instead of pouring every
  // such request into one shared ip:unknown bucket that would lock them all
  // out. At the Cloudflare edge the header is always present; the per-email
  // cap still bounds each address when it is not.
  if (!ipKey) return true;
  if (await hit(ipKey, AUTH_RATE_LIMIT_IP)) return true;
  await env.DB.prepare(authSql.rateRefund).bind(emailKey).run();
  return false;
}

function cleanIp(raw: string | null): string {
  return (raw || '').replace(/[^0-9a-fA-F.:]/g, '').slice(0, 45);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export async function sendMagicLinkEmail(env: AuthEnv, to: string, link: string): Promise<boolean> {
  const safeLink = escapeHtml(link);
  const text = `Use this link to sign in to Doxomachy within 15 minutes:\n\n${link}\n\nIf you did not ask for it, ignore this email.`;
  const html = `<p>Use this link to sign in to Doxomachy within 15 minutes:</p><p><a href="${safeLink}">${safeLink}</a></p><p>If you did not ask for it, ignore this email.</p>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.AUTH_FROM, to: [to], subject: 'Your Doxomachy sign-in link', text, html })
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function creditBalance(env: AuthEnv, accountId: string): Promise<number> {
  const row = await env.DB.prepare(authSql.creditsSelect).bind(accountId).first() as { balance: number } | null;
  return row?.balance ?? 0;
}

// Resolves the peppered lookup key for an email, honoring a previous pepper
// during rotation and lazily re-keying matching rows to the current pepper.
async function lookupHmac(env: AuthEnv, email: string): Promise<{ current: string; pepper: string }> {
  const current = await emailHmac(env.AUTH_EMAIL_PEPPER!, email);
  const id = await pepperId(env.AUTH_EMAIL_PEPPER!);
  const row = await env.DB.prepare(authSql.accountSelect).bind(current).first();
  if (row) return { current, pepper: id };
  for (const older of (env.AUTH_EMAIL_PEPPER_PREVIOUS || '').split(',').map(p => p.trim()).filter(Boolean)) {
    const previous = await emailHmac(older, email);
    const old = await env.DB.prepare(authSql.accountSelect).bind(previous).first();
    if (old) {
      await env.DB.prepare(authSql.accountRekey).bind(current, id, previous).run();
      return { current, pepper: id };
    }
  }
  return { current, pepper: id };
}

export async function requireAccount(request: Request, env: AuthEnv): Promise<{ accountId: string } | null> {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (!isValidTokenFormat(token)) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(authSql.sessionSelect).bind(hash, Date.now()).first() as { account_id: string } | null;
  return row ? { accountId: row.account_id } : null;
}

// --- Paid gameplay spend (worker-side; account UUID is derived from the
// session bearer only, never from any client-supplied subject) ---
//
// Crash semantics: a spend is recorded as 'pending' before the Durable
// Object call. If the worker dies between the D1 decrement and the DO
// completion, the pending row is reconciled later (next credits read or
// paid move for the same account) by asking the DO whether its idempotency
// table holds the move: applied -> 'spent', not applied -> refund + 'refunded'.
// A 'refunded' key is consumed: reusing it is rejected so a refunded credit
// can never be replayed into a second move.

export type SpendResult = { ok: true; replay: boolean } | { ok: false; status: number; error: string };

// The marker insert and the credit decrement are one atomic D1 batch: the
// insert only happens when the balance covers it, and the decrement only
// happens for the caller's own freshly inserted marker (resolver nonce). No
// crash window can leave a pending marker without a decrement - such a
// marker would later mint an unearned refund - or a decrement without a
// marker. A replayed key inserts nothing and its foreign resolver cannot
// satisfy the decrement guard, so replays never double-charge.
export async function spendAccountCredit(env: AuthEnv, accountId: string, idemKey: string, now: number, cid?: string): Promise<SpendResult> {
  const marker = `paid:${accountId}:${idemKey}`;
  const resolver = crypto.randomUUID();
  const [inserted] = await env.DB.batch([
    env.DB.prepare(authSql.paidSpendInsert).bind(marker, accountId, now, resolver, accountId),
    env.DB.prepare(authSql.creditSpendGuarded).bind(now, accountId, marker, resolver)
  ]);
  if ((inserted.meta?.changes || 0) === 0) {
    const existing = await env.DB.prepare(authSql.paidSpendStatus).bind(marker).first() as { status: string } | null;
    if (!existing) return { ok: false, status: 402, error: 'no_moves' };
    if (existing.status === 'refunded') return { ok: false, status: 409, error: 'idempotency_consumed' };
    return { ok: true, replay: true };
  }
  logEvent({ operation: 'credits', outcome: 'ok', correlationId: cid || crypto.randomUUID(), reason: 'spend_pending' });
  return { ok: true, replay: false };
}

// Terminal transitions are conditional claims: only the pending->settled
// transition that wins (changes=1) carries the caller's resolver nonce, and
// the credit refund is guarded on that nonce in the same transaction. Two
// reconcilers (or a reconciler racing the original request) can therefore
// never double-credit a refund.
export async function settleAccountSpend(env: AuthEnv, accountId: string, idemKey: string, status: 'spent' | 'refunded', now: number, cid?: string): Promise<void> {
  const r = await env.DB.prepare(authSql.paidSpendClaim).bind(status, now, crypto.randomUUID(), `paid:${accountId}:${idemKey}`).run();
  logEvent({ operation: 'credits', outcome: (r.meta?.changes || 0) === 1 ? 'ok' : 'degraded', correlationId: cid || crypto.randomUUID(), reason: (r.meta?.changes || 0) === 1 ? `spend_${status}` : 'spend_claim_lost' });
}

export async function refundAccountCredit(env: AuthEnv, accountId: string, idemKey: string, now: number, cid?: string): Promise<void> {
  const resolver = crypto.randomUUID();
  const key = `paid:${accountId}:${idemKey}`;
  const [claim, refund] = await env.DB.batch([
    env.DB.prepare(authSql.paidSpendClaim).bind('refunded', now, resolver, key),
    env.DB.prepare(authSql.paidSpendRefundGuarded).bind(now, accountId, key, resolver)
  ]);
  logEvent({ operation: 'credits', outcome: 'ok', correlationId: cid || crypto.randomUUID(), reason: (claim.meta?.changes || 0) === 1 ? ((refund.meta?.changes || 0) === 1 ? 'refund_credited' : 'refund_claimed_uncredited') : 'refund_claim_lost' });
}

// Replays nothing: the DO idempotency check is read-only. Pending rows are
// capped per call so a pathological account cannot stall a request.
export async function reconcileAccountSpends(env: AuthEnv, accountId: string, isApplied: (key: string) => Promise<boolean>, now: number): Promise<void> {
  const rows = await env.DB.prepare(authSql.paidSpendPending).bind(accountId, now - PAID_SPEND_RECONCILE_MS).all();
  for (const row of (rows.results || []) as { key: string; created_at: number }[]) {
    const idemKey = row.key.slice(`paid:${accountId}:`.length);
    if (now - row.created_at > PAID_SPEND_RECONCILE_MAX_MS) {
      // Past the hard bound the DO has forgotten the idempotency record, so a
      // refund could double-dip a move that was in fact applied. Close as
      // spent instead of refunding blind.
      await settleAccountSpend(env, accountId, idemKey, 'spent', now);
      logEvent({ operation: 'credits', outcome: 'degraded', correlationId: crypto.randomUUID(), reason: 'reconcile_bound_hit' });
      continue;
    }
    if (await isApplied(row.key)) await settleAccountSpend(env, accountId, idemKey, 'spent', now);
    else await refundAccountCredit(env, accountId, idemKey, now);
  }
}

export async function accountCreditBalance(env: AuthEnv, accountId: string): Promise<number> {
  return creditBalance(env, accountId);
}

// Daily cron cleanup: expires old rows and reconciles stale pending spends
// even for users who never come back, so retention claims stay true.
export async function pruneAuthData(env: AuthEnv, now: number): Promise<void> {
  await prune(env, now);
}

export async function reconcileStaleSpends(env: AuthEnv, isApplied: (accountId: string, key: string) => Promise<boolean>, now: number): Promise<void> {
  const rows = await env.DB.prepare(authSql.paidSpendPendingAccounts).bind(now - PAID_SPEND_RECONCILE_MS).all();
  for (const row of (rows.results || []) as { account_id: string }[])
    await reconcileAccountSpends(env, row.account_id, key => isApplied(row.account_id, key), now);
}

type Json = (value: unknown, status?: number, origin?: string) => Response;

async function readJson(request: Request): Promise<any> {
  try { return await request.json(); } catch { return undefined; }
}

// Handles every /v1/auth/* route plus /v1/credits. Returns null when the
// path is not an auth path so the caller can continue routing. `reconcile`
// is provided by the caller (it owns Durable Object access) and replays
// crash-interrupted spends before credit reads.
export async function handleAuth(request: Request, env: AuthEnv, origin: string | undefined, json: Json, reconcile?: (accountId: string) => Promise<void>): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/v1/auth/') && path !== '/v1/credits') return null;
  const now = Date.now();

  if (path === '/v1/auth/magic-link' && request.method === 'POST') {
    const body = await readJson(request);
    const email = normalizeEmail(body?.email);
    if (!email) return json({ error: 'invalid_email' }, 400, origin);
    if (!authConfigured(env)) return json({ error: 'auth_not_configured' }, 503, origin);
    await prune(env, now);
    const { current: hmac, pepper } = await lookupHmac(env, email);
    const ip = cleanIp(request.headers.get('CF-Connecting-IP'));
    // No plaintext IPs at rest: the bucket key is a peppered HMAC.
    const ipKey = ip ? `ip:${await emailHmac(env.AUTH_EMAIL_PEPPER!, 'ip:' + ip)}` : null;
    if (await rateLimitOk(env, `email:${hmac}`, ipKey, now)) {
      await env.DB.prepare(authSql.accountUpsert).bind(crypto.randomUUID(), hmac, pepper, now).run();
      const account = await env.DB.prepare(authSql.accountSelect).bind(hmac).first() as { id: string } | null;
      if (account) {
        const token = randomToken();
        const hash = await sha256Hex(token);
        await env.DB.prepare(authSql.linkInsert).bind(hash, account.id, hmac, now + AUTH_LINK_TTL_MS, now).run();
        const sent = await sendMagicLinkEmail(env, email, `${env.WEB_ORIGIN}/callback.html#token=${token}`);
        // A challenge that can never reach the inbox must not remain verifiable.
        if (!sent) await env.DB.prepare(authSql.linkDeleteUnused).bind(hash).run();
      }
    }
    // Generic by design: the response must not reveal account existence,
    // rate-limit state, or delivery outcome.
    return json({ ok: true, message: 'If that address can sign in, a link is on its way.' }, 200, origin);
  }

  if (path === '/v1/auth/verify' && request.method === 'POST') {
    const body = await readJson(request);
    if (!isValidTokenFormat(body?.token)) return json({ error: 'link_invalid_or_expired' }, 401, origin);
    if (!authConfigured(env)) return json({ error: 'auth_not_configured' }, 503, origin);
    await prune(env, now);
    const hash = await sha256Hex(body.token);
    const consumeKey = crypto.randomUUID();
    const session = randomToken();
    const sessionHash = await sha256Hex(session);
    // One transaction: consume (fail-closed at the exact expiry boundary) and
    // session insert. Any failure rolls everything back; a losing concurrent
    // verifier changes nothing. No other session is touched: signing in on a
    // new device never signs out the old ones.
    const results = await env.DB.batch([
      env.DB.prepare(authSql.verifyConsume).bind(now, consumeKey, hash, now),
      env.DB.prepare(authSql.verifySession).bind(sessionHash, now, now + AUTH_SESSION_TTL_MS, consumeKey)
    ]);
    if ((results[0].meta?.changes || 0) !== 1 || (results[1].meta?.changes || 0) !== 1) {
      return json({ error: 'link_invalid_or_expired' }, 401, origin);
    }
    const link = await env.DB.prepare(authSql.linkAccount).bind(hash).first() as { account_id: string } | null;
    if (!link) return json({ error: 'link_invalid_or_expired' }, 401, origin);
    return json({ ok: true, session, expiresIn: AUTH_SESSION_TTL_MS / 1000, credits: await creditBalance(env, link.account_id) }, 200, origin);
  }

  if (path === '/v1/auth/session' && request.method === 'GET') {
    const account = await requireAccount(request, env);
    if (!account) return json({ error: 'unauthorized' }, 401, origin);
    if (reconcile) await reconcile(account.accountId);
    return json({ ok: true, credits: await creditBalance(env, account.accountId) }, 200, origin);
  }

  if (path === '/v1/auth/session' && request.method === 'DELETE') {
    const header = request.headers.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!isValidTokenFormat(token)) return json({ error: 'unauthorized' }, 401, origin);
    const hash = await sha256Hex(token);
    const valid = await env.DB.prepare(authSql.sessionSelect).bind(hash, now).first();
    if (!valid) return json({ error: 'unauthorized' }, 401, origin);
    await env.DB.prepare(authSql.sessionRevokeOne).bind(now, hash).run();
    return json({ ok: true }, 200, origin);
  }

  if (path === '/v1/auth/sessions' && request.method === 'DELETE') {
    const account = await requireAccount(request, env);
    if (!account) return json({ error: 'unauthorized' }, 401, origin);
    await env.DB.prepare(authSql.sessionRevokeAccount).bind(now, account.accountId).run();
    return json({ ok: true }, 200, origin);
  }

  if (path === '/v1/auth/account' && request.method === 'DELETE') {
    const account = await requireAccount(request, env);
    if (!account) return json({ error: 'unauthorized' }, 401, origin);
    // Money guard: an account holding paid moves cannot self-delete; refund first.
    const balance = await creditBalance(env, account.accountId);
    if (balance > 0) return json({ error: 'credits_remaining', credits: balance }, 409, origin);
    const row = await env.DB.prepare(authSql.accountHmac).bind(account.accountId).first() as { email_hmac: string } | null;
    // One transaction removes every auth row including a zero-balance
    // credits row. A BEFORE DELETE trigger on accounts (0002.sql) aborts the
    // whole batch when a credit grant raced the pre-check, so sessions,
    // links, spends, rate rows and credits all remain intact on conflict.
    try {
      await env.DB.batch([
        env.DB.prepare(authSql.deleteAccountSessions).bind(account.accountId),
        env.DB.prepare(authSql.deleteAccountLinks).bind(account.accountId),
        env.DB.prepare(authSql.deleteAccountSpends).bind(account.accountId),
        env.DB.prepare(authSql.deleteAccountRates).bind(`email:${row?.email_hmac || ''}`),
        env.DB.prepare(authSql.creditDeleteZero).bind(account.accountId),
        env.DB.prepare(authSql.deleteAccount).bind(account.accountId)
      ]);
    } catch {
      return json({ error: 'credits_remaining' }, 409, origin);
    }
    return json({ ok: true }, 200, origin);
  }

  if (path === '/v1/credits' && request.method === 'GET') {
    const account = await requireAccount(request, env);
    if (!account) return json({ error: 'unauthorized' }, 401, origin);
    if (reconcile) await reconcile(account.accountId);
    return json({ credits: await creditBalance(env, account.accountId) }, 200, origin);
  }

  return json({ error: 'not_found' }, 404, origin);
}
