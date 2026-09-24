// Optional public profile: display name (live), image and link (hidden until
// each is manually reviewed from a signed review email).
import { AuthEnv, requireAccount } from './auth';
import { logEvent } from './observability';

export interface ProfileEnv extends AuthEnv { REVIEW_TO?: string; API_ORIGIN?: string }
type Json = (value: unknown, status?: number, origin?: string) => Response;

export const NAME_RE = /^[A-Za-z0-9-]{1,24}$/;
export const IMAGE_MAX_BYTES = 96 * 1024;
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const REVIEW_TTL_MS = 30 * 86_400_000;
const enc = new TextEncoder();

export const profileSql = {
  select: 'SELECT public_id, display_name, image, image_pending, link, link_pending FROM account_profiles WHERE account_id = ?',
  ensure: 'INSERT OR IGNORE INTO account_profiles (account_id, public_id, updated_at) VALUES (?, ?, ?)',
  setName: 'UPDATE account_profiles SET display_name = ?, updated_at = ? WHERE account_id = ?',
  setImagePending: 'UPDATE account_profiles SET image_pending = ?, updated_at = ? WHERE account_id = ?',
  setLinkPending: 'UPDATE account_profiles SET link_pending = ?, updated_at = ? WHERE account_id = ?',
  clearImage: 'UPDATE account_profiles SET image = NULL, image_pending = NULL, updated_at = ? WHERE account_id = ?',
  clearLink: 'UPDATE account_profiles SET link = NULL, link_pending = NULL, updated_at = ? WHERE account_id = ?',
  approveImage: 'UPDATE account_profiles SET image = image_pending, image_pending = NULL, updated_at = ? WHERE account_id = ? AND image_pending = ?',
  approveLink: 'UPDATE account_profiles SET link = link_pending, link_pending = NULL, updated_at = ? WHERE account_id = ? AND link_pending = ?',
  rejectImage: 'UPDATE account_profiles SET image_pending = NULL, updated_at = ? WHERE account_id = ? AND image_pending = ?',
  rejectLink: 'UPDATE account_profiles SET link_pending = NULL, updated_at = ? WHERE account_id = ? AND link_pending = ?',
  pendingValue: 'SELECT image_pending, link_pending FROM account_profiles WHERE account_id = ?',
  publicByIds: 'SELECT public_id, display_name, CASE WHEN image IS NULL THEN 0 ELSE 1 END AS has_image, link FROM account_profiles WHERE public_id IN (SELECT value FROM json_each(?))',
  publicImage: 'SELECT image FROM account_profiles WHERE public_id = ?',
  deleteForAccount: 'DELETE FROM account_profiles WHERE account_id = ?'
} as const;

type Row = { public_id: string; display_name: string | null; image: string | null; image_pending: string | null; link: string | null; link_pending: string | null };

export function validLink(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch { return null; }
}
export function validImage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(IMAGE_RE);
  if (!m) return null;
  const bytes = Math.floor(m[2].length * 3 / 4) - (m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0);
  return bytes > 0 && bytes <= IMAGE_MAX_BYTES ? raw : null;
}

const b64u = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
async function hmac(env: ProfileEnv, data: string): Promise<string> {
  // Review links are signed with a key derived from the auth pepper secret.
  const key = await crypto.subtle.importKey('raw', enc.encode('doxomachy-review:' + (env.AUTH_EMAIL_PEPPER || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function sha(s: string) { return b64u(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

export async function reviewToken(env: ProfileEnv, accountId: string, field: 'image' | 'link', value: string, now: number): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify({ a: accountId, f: field, h: await sha(value), e: now + REVIEW_TTL_MS })));
  return `${body}.${await hmac(env, body)}`;
}
export async function readReviewToken(env: ProfileEnv, token: string, now: number): Promise<{ a: string; f: 'image' | 'link'; h: string } | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig || !env.AUTH_EMAIL_PEPPER) return null;
  const expect = await hmac(env, body);
  if (expect.length !== sig.length) return null;
  let diff = 0; for (let i = 0; i < sig.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  try {
    const d = JSON.parse(fromB64u(body));
    if (typeof d.a !== 'string' || (d.f !== 'image' && d.f !== 'link') || typeof d.h !== 'string' || !(d.e > now)) return null;
    return d;
  } catch { return null; }
}

async function ensureProfile(env: ProfileEnv, accountId: string): Promise<Row> {
  await env.DB.prepare(profileSql.ensure).bind(accountId, crypto.randomUUID().replaceAll('-', ''), Date.now()).run();
  return await env.DB.prepare(profileSql.select).bind(accountId).first() as Row;
}
const ownView = (r: Row) => ({ public_id: r.public_id, name: r.display_name, image: r.image, image_pending: !!r.image_pending, link: r.link, link_pending: r.link_pending });

/** The public identity to attach to a non-anonymous belief, or null. */
export async function publicIdentity(env: ProfileEnv, accountId: string): Promise<{ publicId: string; name: string } | null> {
  const r = await env.DB.prepare(profileSql.select).bind(accountId).first() as Row | null;
  return r && r.display_name ? { publicId: r.public_id, name: r.display_name } : null;
}

async function sendReview(env: ProfileEnv, accountId: string, field: 'image' | 'link', value: string, name: string | null): Promise<boolean> {
  if (!env.REVIEW_TO || !env.RESEND_API_KEY || !env.AUTH_FROM) return false;
  const token = await reviewToken(env, accountId, field, value, Date.now());
  const base = env.API_ORIGIN || 'https://api.doxomachy.flcrom.dev';
  const url = `${base}/v1/review?t=${encodeURIComponent(token)}`;
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const who = name ? `"${name}"` : 'an account with no name';
  const subject = field === 'image' ? `Doxomachy: review a profile image (${name || 'no name'})` : `Doxomachy: review a profile link (${name || 'no name'})`;
  const preview = field === 'link' ? `<p style="font-size:18px"><code>${esc(value)}</code></p><p>Do not open it unless you want to; approving makes it public on this account's beliefs.</p>` : `<p>The image is attached.</p>`;
  const html = `<p>${esc(who)} wants to show this ${field} on their beliefs:</p>${preview}<p><a href="${esc(url)}">Review: approve or reject</a></p><p>It stays hidden until you approve it. The link expires in 30 days.</p>`;
  const text = `${who} wants to show this ${field} on their beliefs:\n\n${field === 'link' ? value : '(image attached)'}\n\nReview: ${url}\n\nIt stays hidden until you approve it.`;
  const payload: any = { from: env.AUTH_FROM, to: [env.REVIEW_TO], subject, text, html };
  if (field === 'image') {
    const m = value.match(IMAGE_RE)!;
    payload.attachments = [{ filename: `profile.${m[1] === 'jpeg' ? 'jpg' : m[1]}`, content: m[2] }];
  }
  try {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    logEvent({ operation: 'http', outcome: res.ok ? 'ok' : 'degraded', correlationId: crypto.randomUUID(), reason: res.ok ? 'review_email_sent' : 'review_email_failed' });
    return res.ok;
  } catch { return false; }
}

const page = (title: string, body: string) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.4 Arial,sans-serif;max-width:560px;margin:40px auto;padding:0 16px">${body}</body>`, {
  status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }
});

export async function handleProfile(request: Request, env: ProfileEnv, origin: string | undefined, json: Json): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const now = Date.now();

  if (path === '/v1/profile' && (request.method === 'GET' || request.method === 'PUT')) {
    const account = await requireAccount(request, env);
    if (!account) return json({ error: 'unauthorized' }, 401, origin);
    let row = await ensureProfile(env, account.accountId);
    if (request.method === 'GET') return json(ownView(row), 200, origin);
    let body: any;
    try { body = JSON.parse(await request.text()); } catch { return json({ error: 'invalid_json' }, 400, origin); }
    if ('name' in body) {
      const name = body.name === null || body.name === '' ? null : typeof body.name === 'string' && NAME_RE.test(body.name) ? body.name : undefined;
      if (name === undefined) return json({ error: 'invalid_name' }, 400, origin);
      await env.DB.prepare(profileSql.setName).bind(name, now, account.accountId).run();
    }
    const review: Array<['image' | 'link', string]> = [];
    if ('image' in body) {
      if (body.image === null || body.image === '') await env.DB.prepare(profileSql.clearImage).bind(now, account.accountId).run();
      else { const img = validImage(body.image); if (!img) return json({ error: 'invalid_image' }, 400, origin); await env.DB.prepare(profileSql.setImagePending).bind(img, now, account.accountId).run(); review.push(['image', img]); }
    }
    if ('link' in body) {
      if (body.link === null || body.link === '') await env.DB.prepare(profileSql.clearLink).bind(now, account.accountId).run();
      else { const link = validLink(body.link); if (!link) return json({ error: 'invalid_link' }, 400, origin); if (link !== row.link && link !== row.link_pending) { await env.DB.prepare(profileSql.setLinkPending).bind(link, now, account.accountId).run(); review.push(['link', link]); } }
    }
    row = await env.DB.prepare(profileSql.select).bind(account.accountId).first() as Row;
    for (const [field, value] of review) await sendReview(env, account.accountId, field, value, row.display_name);
    return json(ownView(row), 200, origin);
  }

  if (path === '/v1/profiles' && request.method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(x => /^[0-9a-f]{32}$/.test(x)).slice(0, 100);
    if (!ids.length) return json({ profiles: {} }, 200, origin);
    const rows = (await env.DB.prepare(profileSql.publicByIds).bind(JSON.stringify(ids)).all()).results as any[];
    const profiles: Record<string, unknown> = {};
    for (const r of rows) profiles[r.public_id] = { name: r.display_name, image: r.has_image ? `/v1/profile-image/${r.public_id}` : null, link: r.link };
    const res = json({ profiles }, 200, origin);
    res.headers.set('cache-control', 'public, max-age=30');
    return res;
  }

  const img = path.match(/^\/v1\/profile-image\/([0-9a-f]{32})$/);
  if (img && request.method === 'GET') {
    const r = await env.DB.prepare(profileSql.publicImage).bind(img[1]).first() as { image: string | null } | null;
    const m = r?.image?.match(IMAGE_RE);
    if (!m) return json({ error: 'not_found' }, 404, origin);
    const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    return new Response(bin, { status: 200, headers: { 'content-type': `image/${m[1]}`, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", ...(origin ? { 'access-control-allow-origin': origin } : {}) } });
  }

  if (path === '/v1/review' && (request.method === 'GET' || request.method === 'POST')) {
    // GET only shows the decision page (mail scanners prefetch links); the
    // change happens on the POST from that page.
    let token = url.searchParams.get('t') || '', decision = '';
    if (request.method === 'POST') { const f = await request.formData().catch(() => null); token = String(f?.get('t') || ''); decision = String(f?.get('d') || ''); }
    const t = await readReviewToken(env, token, now);
    if (!t) return page('Review', '<p>This review link is invalid or expired.</p>');
    const pending = await env.DB.prepare(profileSql.pendingValue).bind(t.a).first() as { image_pending: string | null; link_pending: string | null } | null;
    const value = t.f === 'image' ? pending?.image_pending : pending?.link_pending;
    if (!value || await sha(value) !== t.h) return page('Review', '<p>Already decided, or the account changed it since. Nothing to do.</p>');
    if (request.method === 'GET') {
      const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
      const show = t.f === 'image' ? `<p><img alt="Pending profile image" src="${esc(value)}" style="max-width:256px;border:1px solid #000"></p>` : `<p><code style="font-size:18px">${esc(value)}</code></p>`;
      const form = (d: string, label: string) => `<form method="post" style="display:inline"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="d" value="${d}"><button style="font-size:18px;padding:10px 22px;margin-right:12px">${label}</button></form>`;
      return page('Review', `<h1>Profile ${t.f}</h1>${show}${form('approve', 'Approve')}${form('reject', 'Reject')}`);
    }
    if (decision !== 'approve' && decision !== 'reject') return page('Review', '<p>Pick approve or reject.</p>');
    const sql = t.f === 'image' ? (decision === 'approve' ? profileSql.approveImage : profileSql.rejectImage) : (decision === 'approve' ? profileSql.approveLink : profileSql.rejectLink);
    await env.DB.prepare(sql).bind(now, t.a, value).run();
    logEvent({ operation: 'http', outcome: 'ok', correlationId: crypto.randomUUID(), reason: `review_${t.f}_${decision}` });
    return page('Review', `<p>${decision === 'approve' ? 'Approved. It is now public.' : 'Rejected. It stays hidden.'}</p>`);
  }
  return null;
}
