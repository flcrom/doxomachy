/**
 * HTTP surface for the Dodo Payments integration (rev 3).
 *
 *   POST /webhooks/dodo             Dodo -> us. Server-to-server; authenticated
 *                                   by Standard Webhooks signature. Durable
 *                                   leased inbox: only COMPLETED deliveries are
 *                                   acked; complete/fail are conditional on the
 *                                   claim token; only a MINIMIZED verified
 *                                   payload is retained, cleared on completion.
 *   POST /v1/checkout/session       Browser -> us. Requires Origin ===
 *                                   WEB_ORIGIN (enforced at mount) AND an
 *                                   authenticated account session resolved by
 *                                   the AUTH LANE's requireAccount (worker/src/
 *                                   auth.ts). Persists an idempotent intent
 *                                   before any upstream call. Hard-gated behind
 *                                   DODO_CHECKOUT_ENABLED.
 *   POST /v1/admin/dodo/reconcile   Ops -> us. Bearer DODO_ADMIN_KEY; 404 when
 *                                   the key is not configured.
 *
 * The account-bound /v1/credits balance route is OWNED BY THE AUTH LANE
 * (credits.subject = account UUID; it reads/spends, this lane only grants).
 */

import { extractWebhookHeaders, verifyWebhook, WebhookConfigError } from './standard-webhooks';
import { D1FulfillmentStore, CheckoutIntent } from './store';
import { fulfillDodoEvent, CREDITS_PER_PURCHASE, PRODUCT_PRICE_MINOR, PRODUCT_CURRENCY, DodoWebhookEvent, ProductCatalog, ExpectedContext, LockUnavailable } from './fulfillment';
import { createCheckoutSession, DodoApiError } from './dodo-client';
import { runReconciliation } from './reconcile';
import { requireAccount, type AuthEnv } from '../auth';

export interface DodoEnv extends AuthEnv {
  DODO_API_KEY?: string; // secret: wrangler secret put DODO_API_KEY (TEST-mode key)
  DODO_WEBHOOK_SECRET?: string; // secret: wrangler secret put DODO_WEBHOOK_SECRET (whsec_...)
  DODO_API_BASE?: string; // var: https://test.dodopayments.com while in test mode
  DODO_PRODUCT_ID?: string; // var: TEST-mode product id for the $5 five-move pack
  DODO_RETURN_URL?: string; // var: where the buyer lands after checkout
  DODO_CHECKOUT_ENABLED?: string; // var: 'true' enables session creation; anything else keeps it off
  DODO_BUSINESS_ID?: string; // var: when set, webhooks/grants for any other business are rejected/quarantined
  DODO_ADMIN_KEY?: string; // secret: enables the reconciliation endpoint
}

export const WEBHOOK_MAX_BODY_BYTES = 32768; // Dodo payloads exceed the 2KB browser cap
export const CHECKOUT_MAX_BODY_BYTES = 2048;
const INBOX_STALE_MS = 60_000; // a claimed delivery older than this is stealable (crashed attempt)
const STALE_PENDING_MS = 600_000; // a pending intent this old is escalated to needs_reconciliation (NEVER retried upstream)
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;

const json = (value: unknown, status = 200, origin?: string): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });

/** Server-side product catalog; webhook/client data is never trusted for credit counts. */
const catalog = (env: DodoEnv): ProductCatalog => (productId: string) =>
  env.DODO_PRODUCT_ID && productId === env.DODO_PRODUCT_ID ? CREDITS_PER_PURCHASE : null;

/** The business/product/currency/amount a settled payment must match before any grant. */
const expected = (env: DodoEnv): ExpectedContext => ({
  businessId: env.DODO_BUSINESS_ID || undefined,
  productId: env.DODO_PRODUCT_ID || undefined,
  currency: PRODUCT_CURRENCY,
  amountMinor: PRODUCT_PRICE_MINOR,
});

/**
 * Read a request body enforcing an ACTUAL-BYTE cap (chunked/unknown-length
 * bodies included). Content-Length alone is not a limit: it can be absent or
 * wrong, so we count every chunk and abort the stream at the cap.
 */
export const readBodyWithCap = async (
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false; reason: 'too_large' }> => {
  if (!request.body) return { ok: true, body: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(merged) };
};

/**
 * The only payload we retain: linkage ids, amounts and statuses needed to
 * replay the event through fulfillment. Customer PII, card details, addresses
 * and anything else Dodo sends are dropped BEFORE storage.
 */
const DATA_KEYS = [
  'payment_id', 'checkout_session_id', 'refund_id', 'dispute_id', 'status',
  'dispute_status', 'dispute_stage', 'total_amount', 'amount', 'currency',
  'is_partial', 'reason', 'product_id', 'settled_at', 'created_at',
] as const;
const METADATA_KEYS = ['account_id', 'intent_key', 'product_id', 'checkout_session_id'] as const;

const pickScalars = (source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return out;
};

export const minimizeEvent = (event: DodoWebhookEvent): string => {
  const data = event.data ?? {};
  const meta = data.metadata && typeof data.metadata === 'object' ? pickScalars(data.metadata as Record<string, unknown>, METADATA_KEYS) : {};
  const minimized: Record<string, unknown> = {
    type: event.type,
    business_id: typeof event.business_id === 'string' ? event.business_id : null,
    data: { ...pickScalars(data, DATA_KEYS), ...(Object.keys(meta).length ? { metadata: meta } : {}) },
  };
  return JSON.stringify(minimized);
};

/** Dodo -> Worker. Verify, durably claim, fulfill; only completed deliveries are acked. */
export const handleDodoWebhook = async (request: Request, env: DodoEnv): Promise<Response> => {
  if (!env.DODO_WEBHOOK_SECRET) return json({ error: 'webhook_not_configured' }, 503);

  // Verify against the exact raw bytes; re-stringifying parsed JSON can break the signature.
  const read = await readBodyWithCap(request, WEBHOOK_MAX_BODY_BYTES);
  if (!read.ok) return json({ error: 'payload_too_large' }, 413);
  const rawBody = read.body;

  const headers = extractWebhookHeaders(request.headers);
  if (!headers) return json({ error: 'missing_webhook_headers' }, 400);

  try {
    const verdict = await verifyWebhook(env.DODO_WEBHOOK_SECRET, headers, rawBody);
    if (!verdict.ok) return json({ error: verdict.reason }, 401);
  } catch (err) {
    if (err instanceof WebhookConfigError) return json({ error: 'webhook_misconfigured' }, 500);
    throw err;
  }

  let event: DodoWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!event || typeof event.type !== 'string') return json({ error: 'invalid_event' }, 400);

  // Provider/business context: this endpoint serves Dodo only, and (when
  // configured) only our own business. Signature already proves the secret;
  // this catches misrouted endpoints and cross-business deliveries.
  if (env.DODO_BUSINESS_ID && event.business_id !== env.DODO_BUSINESS_ID) {
    // Exact match required when configured: a MISSING business id must not
    // pass, only events provably for our own business are processed.
    return json({ error: 'wrong_business' }, 403);
  }

  const store = new D1FulfillmentStore(env.DB);
  const now = Date.now();
  const claim = await store.claimDelivery(headers.id, 'dodo', event.type, minimizeEvent(event), now, INBOX_STALE_MS);
  if (!claim.deliver) {
    // claimDelivery false is honored in EVERY branch: nothing is reprocessed
    // or acked unless this attempt owns the claim.
    if (claim.reason === 'completed') return json({ received: true, duplicate: true });
    return json({ error: 'delivery_in_progress' }, 500); // live owner is working; Dodo retries later
  }

  try {
    const outcome = await fulfillDodoEvent(store, event, { catalog: catalog(env), expected: expected(env) });
    // Conditional on our token: if the lease was stolen mid-flight, the new
    // owner completes the row; we still ack because the work will finish.
    await store.completeDelivery(headers.id, claim.token, outcome.action, Date.now());
    return json({ received: true, outcome: outcome.action });
  } catch (err) {
    // Transient failure (including a contended payment lock): record it for
    // the reconciliation job and ask Dodo to retry.
    const message = err instanceof LockUnavailable ? err.message : err instanceof Error ? err.message.slice(0, 300) : 'unknown';
    await store.failDelivery(headers.id, claim.token, message, Date.now()).catch(() => undefined);
    return json({ error: 'processing_failed' }, 500);
  }
};

/** Browser -> Worker. Create a test-mode checkout session for the five-move pack. */
export const handleCheckoutSession = async (request: Request, env: DodoEnv): Promise<Response> => {
  // Hard gate. Paid checkout is deliberately disabled until the owner approves
  // seller identity, payout, refund terms and the exact USD offer.
  if (env.DODO_CHECKOUT_ENABLED !== 'true') {
    return json({ error: 'checkout_disabled', message: 'Free launch mode. Paid moves are not active.' }, 403, env.WEB_ORIGIN);
  }
  if (!env.DODO_API_KEY || !env.DODO_API_BASE || !env.DODO_PRODUCT_ID) {
    return json({ error: 'checkout_not_configured' }, 503, env.WEB_ORIGIN);
  }

  // Authenticated account identity via the AUTH LANE's resolver. Caller-
  // supplied clientIds are ignored; the account UUID is the only subject.
  const account = await requireAccount(request, env);
  if (!account) return json({ error: 'account_required' }, 401, env.WEB_ORIGIN);
  const accountId = account.accountId;

  const read = await readBodyWithCap(request, CHECKOUT_MAX_BODY_BYTES);
  if (!read.ok) return json({ error: 'payload_too_large' }, 413, env.WEB_ORIGIN);

  const idempotencyKey = request.headers.get('idempotency-key') || '';
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) return json({ error: 'idempotency_key_required' }, 400, env.WEB_ORIGIN);

  const store = new D1FulfillmentStore(env.DB);
  const intentKey = `${accountId}:${idempotencyKey}`;
  const now = Date.now();

  // Idempotent intent, persisted BEFORE any upstream call: a retry with the
  // same key replays the stored outcome instead of creating a second session.
  let intent = await store.findIntent(intentKey);
  if (intent?.status === 'created' && intent.session_id) {
    return json({ session_id: intent.session_id, checkout_url: intent.checkout_url, reused: true }, 200, env.WEB_ORIGIN);
  }
  if (intent?.status === 'pending' || intent?.status === 'needs_reconciliation') {
    // NEVER auto-retry a stale pending intent by creating another upstream
    // session: the original request may actually have succeeded upstream
    // while our fetch timed out or the worker crashed, and Dodo documents no
    // checkout idempotency key and no session-lookup API to disambiguate
    // with. A second session would be a second payable page for one key.
    // Instead: 409 while fresh, escalate to needs_reconciliation once stale,
    // and let the reconciler / a human resolve it.
    if (intent.status === 'pending' && intent.error !== 'finalize_failed' && now - intent.updated_at >= STALE_PENDING_MS) {
      await store.updateIntent(intentKey, { status: 'needs_reconciliation', error: intent.error ?? 'stale_pending', updated_at: now }).catch(() => undefined);
      return json(
        { error: 'intent_needs_reconciliation', message: 'This checkout could not be confirmed and is locked for manual reconciliation. Use a new idempotency key only after support clears this one.' },
        409,
        env.WEB_ORIGIN,
      );
    }
    if (intent.status === 'needs_reconciliation') {
      return json(
        { error: 'intent_needs_reconciliation', message: 'This checkout is locked for manual reconciliation.' },
        409,
        env.WEB_ORIGIN,
      );
    }
    // Fresh pending: either in flight right now, or finalized upstream but not
    // locally (finalize_failed): the session exists and its URL was delivered,
    // so a second session must NOT be created. The reconciler recovers it.
    return json({ error: 'intent_in_progress', message: 'A checkout is already being prepared for this key. Retry shortly.' }, 409, env.WEB_ORIGIN);
  }
  if (!intent) {
    const fresh: CheckoutIntent = {
      intent_key: intentKey,
      account_id: accountId,
      status: 'pending',
      session_id: null,
      checkout_url: null,
      payment_id: null,
      product_id: env.DODO_PRODUCT_ID,
      credits: CREDITS_PER_PURCHASE,
      error: null,
      created_at: now,
      updated_at: now,
    };
    try {
      await store.createIntent(fresh);
    } catch {
      return json({ error: 'checkout_intent_failed' }, 500, env.WEB_ORIGIN); // nothing upstream yet; client retries
    }
    intent = fresh;
  }

  let session;
  try {
    session = await createCheckoutSession(env.DODO_API_BASE, env.DODO_API_KEY, {
      product_cart: [{ product_id: env.DODO_PRODUCT_ID, quantity: 1 }],
      return_url: env.DODO_RETURN_URL,
      // metadata carries ONLY linkage (never amounts): the entitlement subject
      // and the intent, so webhooks and reconciliation can re-attach. Dodo
      // documents no checkout idempotency key, so this correlation plus the
      // persisted intent is the recovery path.
      metadata: { account_id: accountId, intent_key: intentKey, product_id: env.DODO_PRODUCT_ID },
    });
  } catch (err) {
    if (err instanceof DodoApiError && !err.ambiguous) {
      // DEFINITIVE pre-creation refusal (HTTP 4xx; Dodo documents 422 on
      // POST /checkouts as "Invalid Request Object or Parameters"): no
      // session exists, the intent can be retried safely with a fixed request.
      await store.updateIntent(intentKey, { status: 'failed', error: `upstream_${err.status}`, updated_at: Date.now() }).catch(() => undefined);
      return json({ error: 'checkout_upstream_failed', status: err.status }, 502, env.WEB_ORIGIN);
    }
    // AMBIGUOUS: 5xx, proxy/gateway error pages, unparseable or malformed
    // 2xx bodies, timeouts, network failures. The request may have created a
    // payable session upstream. Mark the intent ambiguous and keep it
    // 'pending': the next caller gets 409 and, once stale, the intent is
    // escalated to needs_reconciliation. It is never retried upstream.
    await store.updateIntent(intentKey, { error: 'upstream_ambiguous', updated_at: Date.now() }).catch(() => undefined);
    return json(
      { error: 'checkout_upstream_unreachable', message: 'The checkout provider did not confirm the session. This key is locked; do not retry immediately.' },
      502,
      env.WEB_ORIGIN,
    );
  }

  // Finalize: flip the intent (conditional on still-pending) and create the
  // order row. If the FIRST post-upstream D1 write fails, the session still
  // exists and its URL is still returned to the buyer: the intent stays
  // pending with finalize_failed, webhook metadata (intent_key/account_id)
  // recovers the order on payment, and the reconciler sweeps the orphan.
  const done = Date.now();
  try {
    const flipped = await store.finalizeIntent(intentKey, session.session_id, session.checkout_url, done);
    if (!flipped) {
      const current = await store.findIntent(intentKey);
      if (current?.status === 'created' && current.session_id) {
        return json({ session_id: current.session_id, checkout_url: current.checkout_url, reused: true }, 200, env.WEB_ORIGIN);
      }
      throw new Error('intent_finalize_race');
    }
    await store.createOrder({
      session_id: session.session_id,
      account_id: accountId,
      payment_id: null,
      business_id: env.DODO_BUSINESS_ID ?? null,
      status: 'created',
      product_id: env.DODO_PRODUCT_ID,
      credits: CREDITS_PER_PURCHASE,
      total_amount: null,
      currency: null,
      quarantine_reason: null,
      created_at: done,
      updated_at: done,
    });
  } catch {
    await store.updateIntent(intentKey, { status: 'pending', error: 'finalize_failed', updated_at: Date.now() }).catch(() => undefined);
    return json(
      { session_id: session.session_id, checkout_url: session.checkout_url, recovery: 'reconciler' },
      201,
      env.WEB_ORIGIN,
    );
  }

  return json({ session_id: session.session_id, checkout_url: session.checkout_url }, 201, env.WEB_ORIGIN);
};

/** Constant-time compare for the ops key (length-leak acceptable; keys are fixed-size). */
const keyMatches = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Ops -> Worker. Run reconciliation against Dodo's own records. */
export const handleDodoReconcile = async (request: Request, env: DodoEnv): Promise<Response> => {
  if (!env.DODO_ADMIN_KEY) return json({ error: 'not_found' }, 404);
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!token || !keyMatches(token, env.DODO_ADMIN_KEY)) return json({ error: 'unauthorized' }, 401);
  try {
    const report = await runReconciliation(env);
    return json(report, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : 'unknown';
    return json({ error: 'reconciliation_failed', message }, 500);
  }
};
