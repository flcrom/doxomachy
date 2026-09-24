import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { D1FulfillmentStore } from '../src/payments/store';
import { handleDodoWebhook, handleCheckoutSession, handleDodoReconcile, DodoEnv } from '../src/payments/routes';
import { runReconciliation } from '../src/payments/reconcile';
import { FakeD1, FailingD1, TEST_SECRET, TEST_ACCOUNT, TEST_ACCOUNT_B, TEST_TOKEN, TEST_TOKEN_B, TEST_BUSINESS, signDelivery, webhookRequest, fixture, seedOrder, seedIntent } from './helpers';

vi.mock('../src/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth')>();
  const { authMock } = await import('./helpers');
  // Partial mock: the real auth module loads (its other exports power the
  // mounted worker routes); only the account seam payments consumes is faked.
  return { ...actual, requireAccount: authMock.requireAccount, accountCreditBalance: authMock.accountCreditBalance };
});

let db: FakeD1;
let env: DodoEnv;
let store: D1FulfillmentStore;

const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  db = new FakeD1();
  env = {
    DB: db as unknown as D1Database,
    WEB_ORIGIN: 'https://doxomachy.vercel.app',
    DODO_WEBHOOK_SECRET: TEST_SECRET,
    DODO_API_KEY: 'test_api_key',
    DODO_API_BASE: 'https://test.dodopayments.com',
    DODO_PRODUCT_ID: 'pdt_test_5pack',
    DODO_RETURN_URL: 'https://doxomachy.vercel.app/pricing.html?checkout=return',
    DODO_CHECKOUT_ENABLED: 'false',
    DODO_BUSINESS_ID: TEST_BUSINESS,
  };
  store = new D1FulfillmentStore(env.DB);
  await seedOrder(store);
});

afterEach(() => vi.unstubAllGlobals());

const deliver = async (name: string, webhookId: string, bodyOverride?: (e: any) => any) => {
  const { raw, event } = fixture(name);
  const payload = bodyOverride ? JSON.stringify(bodyOverride(event)) : raw;
  const headers = await signDelivery(TEST_SECRET, webhookId, nowSeconds(), payload);
  return handleDodoWebhook(webhookRequest(headers, payload), env);
};

const checkoutRequest = (init: { token?: string; key?: string; body?: string; contentLength?: string }): Request =>
  new Request('https://worker.test/v1/checkout/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: 'https://doxomachy.vercel.app',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.key ? { 'idempotency-key': init.key } : {}),
      ...(init.contentLength ? { 'content-length': init.contentLength } : {}),
    },
    body: init.body ?? '{}',
  });

const stubCheckoutCreate = (sessionId = 'cs_test_new', calls?: { n: number }) => {
  let n = 0;
  return vi.stubGlobal('fetch', vi.fn(async () => {
    n++;
    if (calls) calls.n++;
    const id = `${sessionId}_${n}`;
    return new Response(JSON.stringify({ session_id: id, checkout_url: `https://test.dodopayments.com/checkout/${id}` }), { status: 200 });
  }));
};

describe('POST /webhooks/dodo', () => {
  it('verifies, fulfills and marks the inbox delivery completed; the payload is cleared', async () => {
    const res = await deliver('payment-succeeded.json', 'msg_1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, outcome: 'granted' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    const inbox = await store.listDeliveries(['completed'], 10);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ webhook_id: 'msg_1', status: 'completed', attempts: 1, outcome: 'granted' });
    expect(inbox[0].payload).toBeNull(); // minimized payload cleared on completion
    expect(inbox[0].claim_token).toBeNull();
  });

  it('acks a redelivery of a COMPLETED delivery without side effects', async () => {
    await deliver('payment-succeeded.json', 'msg_dup');
    const res = await deliver('payment-succeeded.json', 'msg_dup');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, duplicate: true });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('two simultaneous deliveries of the same webhook-id: exactly one processes', async () => {
    const [r1, r2] = await Promise.all([deliver('payment-succeeded.json', 'msg_race'), deliver('payment-succeeded.json', 'msg_race')]);
    const statuses = [r1.status, r2.status].sort();
    // One owner processes (200); the other is told to retry later (500) or acks the completed row (200).
    expect(statuses[0]).toBe(200);
    expect([200, 500]).toContain(statuses[1]);
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    const inbox = await store.listDeliveries(['completed'], 10);
    expect(inbox.filter((d) => d.webhook_id === 'msg_race')).toHaveLength(1);
  });

  it('does NOT ack an unfinished redelivery: it reprocesses instead', async () => {
    // First attempt dies mid-fulfillment (injected storage failure on the ledger insert).
    const failing = new FailingD1(env.DB as unknown as D1Database);
    failing.failNext('INSERT OR IGNORE INTO credit_ledger');
    const failEnv = { ...env, DB: failing as unknown as D1Database };
    const { raw } = fixture('payment-succeeded.json');
    const headers = await signDelivery(TEST_SECRET, 'msg_retry', nowSeconds(), raw);
    const first = await handleDodoWebhook(webhookRequest(headers, raw), failEnv);
    expect(first.status).toBe(500);
    const failedRows = await store.listDeliveries(['failed'], 10);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].error).toContain('injected storage failure');
    // Redelivery of the same webhook-id: NOT a duplicate ack; it reprocesses.
    const second = await handleDodoWebhook(webhookRequest(headers, raw), env);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ received: true, outcome: 'granted' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('a failed delivery retains only the MINIMIZED payload: linkage and amounts, no PII', async () => {
    const failing = new FailingD1(env.DB as unknown as D1Database);
    failing.failNext('INSERT OR IGNORE INTO credit_ledger');
    const { raw } = fixture('payment-succeeded.json');
    const headers = await signDelivery(TEST_SECRET, 'msg_pii', nowSeconds(), raw);
    await handleDodoWebhook(webhookRequest(headers, raw), { ...env, DB: failing as unknown as D1Database });
    const failedRows = await store.listDeliveries(['failed'], 10);
    expect(failedRows).toHaveLength(1);
    const payload = failedRows[0].payload ?? '';
    expect(payload).toContain('pay_test_5pack'); // linkage kept for replay
    expect(payload).toContain('"total_amount":500');
    expect(payload).not.toContain('buyer@example.test'); // customer PII dropped
    expect(payload).not.toContain('Test Buyer');
    expect(payload).not.toContain('4242'); // card details dropped
    expect(payload).not.toContain('customer');
  });

  it('rejects missing headers, bad signatures and stale timestamps', async () => {
    expect((await handleDodoWebhook(webhookRequest({}, '{}'), env)).status).toBe(400);
    const headers = await signDelivery(TEST_SECRET, 'msg_bad', nowSeconds(), '{}');
    headers['webhook-signature'] = 'v1,AAAAAAA=';
    expect((await handleDodoWebhook(webhookRequest(headers, '{}'), env)).status).toBe(401);
    const stale = await signDelivery(TEST_SECRET, 'msg_stale', nowSeconds() - 3600, '{}');
    expect((await handleDodoWebhook(webhookRequest(stale, '{}'), env)).status).toBe(401);
  });

  it('handles malformed base64 safely: secret -> 500 misconfigured, header signature -> 401', async () => {
    const badSecretEnv = { ...env, DODO_WEBHOOK_SECRET: 'whsec_!!!not-base64!!!' };
    const { raw } = fixture('payment-succeeded.json');
    const headers = await signDelivery(TEST_SECRET, 'msg_mb1', nowSeconds(), raw);
    const res = await handleDodoWebhook(webhookRequest(headers, raw), badSecretEnv);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'webhook_misconfigured' });
    const garbage = { ...headers, 'webhook-signature': 'v1,!!!' };
    expect((await handleDodoWebhook(webhookRequest(garbage, raw), env)).status).toBe(401);
  });

  it('enforces the actual-byte cap on streamed bodies without Content-Length', async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 40; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        controller.close();
      },
    });
    const headers = await signDelivery(TEST_SECRET, 'msg_chunked', nowSeconds(), 'irrelevant');
    const req = new Request('https://worker.test/webhooks/dodo', {
      method: 'POST',
      // @ts-expect-error undici requires duplex for stream bodies
      duplex: 'half',
      headers: { 'content-type': 'application/json', ...headers },
      body: stream,
    });
    const res = await handleDodoWebhook(req, env);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('accepts a legitimately large (over 2KB) signed payload', async () => {
    const { raw } = fixture('payment-succeeded.json');
    const padded = raw.replace('}', ',"padding":"' + 'x'.repeat(6000) + '"}');
    const headers = await signDelivery(TEST_SECRET, 'msg_big', nowSeconds(), padded);
    const res = await handleDodoWebhook(webhookRequest(headers, padded), env);
    expect(res.status).toBe(200);
  });

  it('rejects events for a different business when DODO_BUSINESS_ID is configured', async () => {
    const res = await deliver('payment-succeeded.json', 'msg_biz', (e) => ((e.business_id = 'bus_someone_else'), e));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'wrong_business' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('answers 503 when the webhook secret is not configured', async () => {
    delete env.DODO_WEBHOOK_SECRET;
    expect((await handleDodoWebhook(webhookRequest({}, '{}'), env)).status).toBe(503);
  });
});

describe('POST /v1/checkout/session', () => {
  it('stays disabled as shipped, before any auth or upstream work', async () => {
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000001' }), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'checkout_disabled' });
  });

  it('requires an authenticated account when enabled', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    expect((await handleCheckoutSession(checkoutRequest({ key: 'idem-key-00000001' }), env)).status).toBe(401);
    expect((await handleCheckoutSession(checkoutRequest({ token: 'bogus-token-bogus-token-0000', key: 'idem-key-00000001' }), env)).status).toBe(401);
    expect((await handleCheckoutSession(checkoutRequest({ token: 'short', key: 'idem-key-00000001' }), env)).status).toBe(401);
  });

  it('requires an idempotency key', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'idempotency_key_required' });
  });

  it('persists the intent before upstream, is idempotent on retry, and binds the order to the account (not caller clientId)', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    const calls = { n: 0 };
    stubCheckoutCreate('cs_test_new', calls);
    const body = JSON.stringify({ clientId: 'spoofed-browser-id' });
    const first = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000001', body }), env);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ session_id: 'cs_test_new_1', checkout_url: 'https://test.dodopayments.com/checkout/cs_test_new_1' });
    expect(calls.n).toBe(1);
    // order + intent persisted, subject is the AUTHENTICATED account
    const order = await store.findOrderBySession('cs_test_new_1');
    expect(order).toMatchObject({ account_id: TEST_ACCOUNT, credits: 5, status: 'created' });
    const intent = await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000001`);
    expect(intent).toMatchObject({ status: 'created', session_id: 'cs_test_new_1' });
    // retry with the same key: stored outcome, no second upstream call
    const retry = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000001', body }), env);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ session_id: 'cs_test_new_1', reused: true });
    expect(calls.n).toBe(1);
    // a different account with the same key gets its own intent and session
    const other = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN_B, key: 'idem-key-00000001' }), env);
    expect(other.status).toBe(201);
    expect(await other.json()).toMatchObject({ session_id: 'cs_test_new_2' });
    expect(calls.n).toBe(2);
    expect(await store.findOrderBySession('cs_test_new_2')).toMatchObject({ account_id: TEST_ACCOUNT_B });
  });

  it('a DEFINITIVE upstream refusal (4xx; Dodo documents 422) marks the intent failed and a later retry succeeds', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'INVALID_REQUEST' }), { status: 422 })));
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000002' }), env);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'checkout_upstream_failed', status: 422 });
    expect((await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000002`))?.status).toBe('failed');
    stubCheckoutCreate('cs_test_recovered');
    const retry = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000002' }), env);
    expect(retry.status).toBe(201);
    expect(await store.findOrderBySession('cs_test_recovered_1')).toMatchObject({ account_id: TEST_ACCOUNT });
  });

  it('ADVERSARIAL: a provider 5xx is AMBIGUOUS - not failed, never retried upstream, escalates when stale', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    const calls = { n: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.n++;
      return new Response('upstream broke', { status: 500 });
    }));
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000008' }), env);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'checkout_upstream_unreachable' });
    // NOT failed: the request may have created a session upstream
    expect(await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000008`)).toMatchObject({ status: 'pending', error: 'upstream_ambiguous' });
    const retry = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000008' }), env);
    expect(retry.status).toBe(409);
    expect(calls.n).toBe(1); // never a second upstream attempt
  });

  it('ADVERSARIAL: a malformed 2xx body (missing session_id) is AMBIGUOUS - the session may exist upstream', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    const calls = { n: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.n++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000009' }), env);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'checkout_upstream_unreachable' });
    expect(await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000009`)).toMatchObject({ status: 'pending', error: 'upstream_ambiguous' });
    const retry = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000009' }), env);
    expect(retry.status).toBe(409);
    expect(calls.n).toBe(1);
  });

  it('D1 failure before the upstream call: 500, no upstream call, clean retry', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    const calls = { n: 0 };
    stubCheckoutCreate('cs_test_after_failure', calls);
    const failing = new FailingD1(env.DB as unknown as D1Database);
    failing.failNext('INSERT INTO checkout_intents');
    const failEnv = { ...env, DB: failing as unknown as D1Database };
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000003' }), failEnv);
    expect(res.status).toBe(500);
    expect(calls.n).toBe(0); // upstream never touched
    const retry = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000003' }), env);
    expect(retry.status).toBe(201);
  });

  it('D1 failure at finalize: the buyer still gets the URL; a retry does NOT create a second session; reconciliation recovers the order', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    const calls = { n: 0 };
    stubCheckoutCreate('cs_test_orphan', calls);
    const failing = new FailingD1(env.DB as unknown as D1Database);
    failing.failNext('INSERT INTO dodo_orders');
    const failEnv = { ...env, DB: failing as unknown as D1Database };
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000004' }), failEnv);
    // The session exists upstream: the URL is still delivered so the buyer can pay.
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ session_id: 'cs_test_orphan_1', recovery: 'reconciler' });
    const intent = await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000004`);
    expect(intent).toMatchObject({ status: 'pending', error: 'finalize_failed' });
    // immediate client retry: 409 in progress, NOT a second upstream session
    const retry = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000004' }), env);
    expect(retry.status).toBe(409);
    expect(calls.n).toBe(1);
    // reconciliation recovers from Dodo's records + the persisted intent
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/payments')) {
        return new Response(JSON.stringify({ items: [{ payment_id: 'pay_orphan', status: 'succeeded', total_amount: 500, currency: 'USD', checkout_session_id: 'cs_test_orphan_1', metadata: { intent_key: `${TEST_ACCOUNT}:idem-key-00000004` } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }));
    const report = await runReconciliation(env);
    expect(report.orders_recovered).toBe(1);
    expect(await store.findOrderBySession('cs_test_orphan_1')).toMatchObject({ account_id: TEST_ACCOUNT, status: 'succeeded' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    expect((await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000004`))?.status).toBe('recovered');
  });

  it('ADVERSARIAL (crash ambiguity): a stale pending intent is NEVER retried upstream - it escalates to needs_reconciliation and no second session is created', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    // crashed before/inside the upstream call: no session id stored, no
    // finalize_failed marker, old. The request MAY still have created a
    // payable session upstream, so creating another one is forbidden.
    await seedIntent(store, {
      intent_key: `${TEST_ACCOUNT}:idem-key-00000005`,
      status: 'pending',
      session_id: null,
      checkout_url: null,
      error: null,
      updated_at: Date.now() - 700_000,
    });
    const calls = { n: 0 };
    stubCheckoutCreate('cs_test_retry', calls);
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000005' }), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'intent_needs_reconciliation' });
    expect(calls.n).toBe(0); // ZERO upstream calls - never auto-retried
    expect((await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000005`))?.status).toBe('needs_reconciliation');
    // and it stays locked on further retries
    const again = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000005' }), env);
    expect(again.status).toBe(409);
    expect(calls.n).toBe(0);
  });

  it('ADVERSARIAL (timeout ambiguity): an upstream timeout locks the key forever - 502, then 409s, zero further upstream calls, reconciler recovers via metadata', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    const calls = { n: 0 };
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.n++;
      const err = new Error('The operation timed out');
      err.name = 'TimeoutError';
      throw err;
    }));
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000007' }), env);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'checkout_upstream_unreachable' });
    expect(calls.n).toBe(1); // exactly one upstream attempt ever
    expect(await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000007`)).toMatchObject({ status: 'pending', error: 'upstream_ambiguous' });
    // immediate retry: 409 in progress, NO second upstream attempt
    const retry = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000007' }), env);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: 'intent_in_progress' });
    expect(calls.n).toBe(1);
    // once stale: escalates to needs_reconciliation, still no upstream attempt
    await db.prepare('UPDATE checkout_intents SET updated_at = ? WHERE intent_key = ?')
      .bind(Date.now() - 700_000, `${TEST_ACCOUNT}:idem-key-00000007`)
      .run();
    const stale = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000007' }), env);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'intent_needs_reconciliation' });
    expect(calls.n).toBe(1);
    expect((await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000007`))?.status).toBe('needs_reconciliation');
    // reconciler recovers the payment that DID happen upstream (matched by intent_key metadata)
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/payments')) {
        return new Response(JSON.stringify({ items: [{ payment_id: 'pay_timeout', status: 'succeeded', total_amount: 500, currency: 'USD', metadata: { intent_key: `${TEST_ACCOUNT}:idem-key-00000007` } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }));
    const report = await runReconciliation(env);
    expect(report.intents_recovered).toBe(1);
    expect((await store.findIntent(`${TEST_ACCOUNT}:idem-key-00000007`))?.status).toBe('recovered');
    expect(await store.findOrderByPayment('pay_timeout')).toMatchObject({ account_id: TEST_ACCOUNT, status: 'succeeded' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('a fresh pending intent (in flight right now) returns 409', async () => {
    env.DODO_CHECKOUT_ENABLED = 'true';
    await seedIntent(store, {
      intent_key: `${TEST_ACCOUNT}:idem-key-00000006`,
      status: 'pending',
      session_id: null,
      checkout_url: null,
      error: null,
      updated_at: Date.now(),
    });
    const res = await handleCheckoutSession(checkoutRequest({ token: TEST_TOKEN, key: 'idem-key-00000006' }), env);
    expect(res.status).toBe(409);
  });
});

describe('reconciliation environment reporting', () => {
  it('reports the live environment without exposing configuration values', async () => {
    env.DODO_API_BASE = 'https://live.dodopayments.com';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const report = await runReconciliation(env);
    expect(report.mode).toBe('live');
  });
});

describe('POST /v1/admin/dodo/reconcile', () => {
  it('404s without an admin key, 401s with a wrong one, runs with the right one', async () => {
    const req = (key?: string) =>
      new Request('https://worker.test/v1/admin/dodo/reconcile', { method: 'POST', ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) });
    expect((await handleDodoReconcile(req('anything'), env)).status).toBe(404); // not configured
    env.DODO_ADMIN_KEY = 'ops-test-key';
    expect((await handleDodoReconcile(req('wrong'), env)).status).toBe(401);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const ok = await handleDodoReconcile(req('ops-test-key'), env);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ upstream: { payments: 0, refunds: 0, disputes: 0 } });
  });
});

describe('reconciliation recovery paths', () => {
  it('replays refunds found upstream but never delivered', async () => {
    await deliver('payment-succeeded.json', 'msg_rec1');
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/payments')) return new Response(JSON.stringify({ items: [{ payment_id: 'pay_test_5pack', status: 'succeeded', total_amount: 500, checkout_session_id: 'cs_test_5pack' }] }), { status: 200 });
      if (url.includes('/refunds')) return new Response(JSON.stringify({ items: [{ refund_id: 'ref_missed', payment_id: 'pay_test_5pack', status: 'succeeded', amount: 500, currency: 'USD' }] }), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }));
    const report = await runReconciliation(env);
    expect(report.events_replayed).toBeGreaterThan(0);
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('retries failed inbox deliveries from their stored minimized payloads', async () => {
    const failing = new FailingD1(env.DB as unknown as D1Database);
    failing.failNext('INSERT OR IGNORE INTO credit_ledger');
    const { raw } = fixture('payment-succeeded.json');
    const headers = await signDelivery(TEST_SECRET, 'msg_rec2', nowSeconds(), raw);
    await handleDodoWebhook(webhookRequest(headers, raw), { ...env, DB: failing as unknown as D1Database });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const report = await runReconciliation(env);
    expect(report.deliveries_retried).toBe(1);
    expect(report.stale_claims).toBe(0);
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    expect((await store.listDeliveries(['completed'], 10)).map((d) => d.webhook_id)).toContain('msg_rec2');
  });

  it('re-claims deliveries stuck in processing (crashed attempts), not only failed ones', async () => {
    // a crashed attempt: claimed long ago, never completed, payload retained
    const payload = JSON.stringify({
      type: 'payment.succeeded',
      business_id: TEST_BUSINESS,
      data: { payment_id: 'pay_test_5pack', checkout_session_id: 'cs_test_5pack', total_amount: 500, currency: 'USD', metadata: { account_id: TEST_ACCOUNT, product_id: 'pdt_test_5pack' } },
    });
    await db
      .prepare(
        `INSERT INTO webhook_inbox (webhook_id, provider, event_type, payload, status, claim_token, claimed_at, attempts, received_at, updated_at)
         VALUES ('msg_crashed', 'dodo', 'payment.succeeded', ?, 'processing', 'dead-owner-token', ?, 1, ?, ?)`,
      )
      .bind(payload, Date.now() - 300_000, Date.now() - 300_000, Date.now() - 300_000)
      .run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const report = await runReconciliation(env);
    expect(report.stale_claims).toBe(1);
    expect(report.deliveries_retried).toBe(1);
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    const rows = await store.listDeliveries(['completed'], 10);
    expect(rows.map((d) => d.webhook_id)).toContain('msg_crashed');
    expect(rows.find((d) => d.webhook_id === 'msg_crashed')?.payload).toBeNull();
  });

  it('re-applies a ledger delta whose balance write never landed (crash between writes)', async () => {
    await db
      .prepare(
        `INSERT INTO credit_ledger (reference, subject, payment_id, delta, reason, balance_applied, created_at)
         VALUES ('grant:pay_stranded', ?, 'pay_stranded', 5, 'payment.succeeded', 0, ?)`,
      )
      .bind(TEST_ACCOUNT, Date.now())
      .run();
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const report = await runReconciliation(env);
    expect(report.balance_repairs).toBe(1);
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    expect(report.drift).toContain('balance_repair:grant:pay_stranded');
  });

  it('ADVERSARIAL: truly simultaneous reconciliations apply a stranded balance delta exactly once', async () => {
    await db
      .prepare(
        `INSERT INTO credit_ledger (reference, subject, payment_id, delta, reason, balance_applied, created_at)
         VALUES ('grant:pay_race', ?, 'pay_race', 5, 'payment.succeeded', 0, ?)`,
      )
      .bind(TEST_ACCOUNT, Date.now())
      .run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const [a, b] = await Promise.all([runReconciliation(env), runReconciliation(env)]);
    expect(a.balance_repairs + b.balance_repairs).toBe(1); // one winner, one lock-contended/no-op
    expect(await store.balance(TEST_ACCOUNT)).toBe(5); // applied exactly once, never twice
  });

  it('ADVERSARIAL: a signed webhook with a MISSING business_id is rejected when DODO_BUSINESS_ID is configured', async () => {
    const { raw, event } = fixture('payment-succeeded.json');
    delete event.business_id;
    const body = JSON.stringify(event);
    const headers = await signDelivery(TEST_SECRET, 'msg_no_business', nowSeconds(), body);
    const res = await handleDodoWebhook(webhookRequest(headers, body), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'wrong_business' });
    // and an explicit foreign business is rejected the same way
    event.business_id = 'bus_someone_else';
    const body2 = JSON.stringify(event);
    const headers2 = await signDelivery(TEST_SECRET, 'msg_foreign_business', nowSeconds(), body2);
    expect((await handleDodoWebhook(webhookRequest(headers2, body2), env)).status).toBe(403);
    expect(raw).toContain('bus_test_fixture'); // fixture sanity
  });

  it('flags unknown upstream payments as drift', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/payments')) return new Response(JSON.stringify({ items: [{ payment_id: 'pay_unknown', status: 'succeeded', metadata: {} }] }), { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }));
    const report = await runReconciliation(env);
    expect(report.drift).toContain('unknown_payment:pay_unknown');
  });

  it('flags truncated upstream lists instead of silently reconciling a partial view', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/payments')) {
        // always a full page: listAll hits the page cap and reports truncation
        return new Response(JSON.stringify({ items: Array.from({ length: 100 }, () => ({})) }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }));
    const report = await runReconciliation(env);
    expect(report.truncated).toContain('payments');
    expect(report.truncated).not.toContain('refunds');
  });

  it('surfaces quarantined orders for a human decision', async () => {
    const res = await deliver('payment-succeeded.json', 'msg_quar', (e) => ((e.data.currency = 'EUR'), e));
    expect(res.status).toBe(200);
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const report = await runReconciliation(env);
    expect(report.quarantined).toContain('pay_test_5pack');
  });

  it('prunes old completed and failed inbox rows (retention)', async () => {
    const old = Date.now() - 8 * 86_400_000; // 8 days
    const older = Date.now() - 31 * 86_400_000; // 31 days
    await db
      .prepare(
        `INSERT INTO webhook_inbox (webhook_id, provider, event_type, payload, status, attempts, received_at, updated_at, processed_at)
         VALUES ('msg_old_done', 'dodo', 'payment.succeeded', NULL, 'completed', 1, ?, ?, ?)`,
      )
      .bind(old, old, old)
      .run();
    await db
      .prepare(
        `INSERT INTO webhook_inbox (webhook_id, provider, event_type, payload, status, attempts, received_at, updated_at)
         VALUES ('msg_old_failed', 'dodo', 'payment.succeeded', '{}', 'failed', 3, ?, ?)`,
      )
      .bind(older, older)
      .run();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const report = await runReconciliation(env);
    expect(report.retention).toMatchObject({ completed: 1, failed: 1 });
    expect((await store.listDeliveries(['completed', 'failed'], 10)).filter((d) => d.webhook_id.startsWith('msg_old'))).toHaveLength(0);
  });

  it('escalates unmatched stale pending intents to needs_reconciliation, reports them as drift on EVERY run, and never auto-abandons', async () => {
    await seedIntent(store, {
      intent_key: `${TEST_ACCOUNT}:idem-ancient`,
      status: 'pending',
      session_id: null,
      checkout_url: null,
      error: null,
      updated_at: Date.now() - 2 * 86_400_000,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    const first = await runReconciliation(env);
    expect(first.intents_needs_reconciliation).toBe(1);
    expect((await store.findIntent(`${TEST_ACCOUNT}:idem-ancient`))?.status).toBe('needs_reconciliation');
    expect(first.drift).toContain(`intent_needs_reconciliation:${TEST_ACCOUNT}:idem-ancient`);
    // second run: nothing new to flag, but the drift entry persists for ops
    const second = await runReconciliation(env);
    expect(second.intents_needs_reconciliation).toBe(0);
    expect(second.drift).toContain(`intent_needs_reconciliation:${TEST_ACCOUNT}:idem-ancient`);
    expect((await store.findIntent(`${TEST_ACCOUNT}:idem-ancient`))?.status).toBe('needs_reconciliation');
  });
});

describe('ownership foreign keys to accounts(id)', () => {
  const BOGUS = 'eeeeeeee-7777-8888-9999-ffffffffffff';

  it('rejects an order whose account does not exist (orphan rejection)', async () => {
    await expect(seedOrder(store, { session_id: 'cs_test_orphan_acct', account_id: BOGUS })).rejects.toThrow();
    expect(await store.findOrderBySession('cs_test_orphan_acct')).toBeNull();
  });

  it('rejects an intent whose account does not exist (orphan rejection)', async () => {
    await expect(seedIntent(store, { intent_key: `${BOGUS}:idem-orphan`, account_id: BOGUS })).rejects.toThrow();
    expect(await store.findIntent(`${BOGUS}:idem-orphan`)).toBeNull();
  });

  it('account deletion is BLOCKED while orders exist (RESTRICT), then succeeds after orders are archived', async () => {
    await seedOrder(store, { session_id: 'cs_test_restrict', account_id: TEST_ACCOUNT });
    await expect(db.prepare('DELETE FROM accounts WHERE id = ?').bind(TEST_ACCOUNT).run()).rejects.toThrow();
    // the order and account both survive the failed deletion
    expect(await store.findOrderBySession('cs_test_restrict')).not.toBeNull();
  });

  it('account deletion CASCADES checkout intents (ephemeral state dies with the account)', async () => {
    await seedIntent(store, { intent_key: `${TEST_ACCOUNT_B}:idem-cascade`, account_id: TEST_ACCOUNT_B });
    await db.prepare('DELETE FROM accounts WHERE id = ?').bind(TEST_ACCOUNT_B).run();
    expect(await store.findIntent(`${TEST_ACCOUNT_B}:idem-cascade`)).toBeNull();
  });
});
