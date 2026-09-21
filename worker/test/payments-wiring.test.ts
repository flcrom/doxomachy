/**
 * Wiring tests: the Dodo Payments routes as actually mounted in worker.fetch
 * (src/index.ts), not just the handlers in isolation. Covers route placement
 * relative to the origin check and body-size limits, required Origin/auth on
 * browser routes, response-header hygiene on the server-to-server webhook,
 * and the shipped-disabled checkout gate.
 *
 * The account-bound /v1/credits route is owned by the AUTH LANE, so it is not
 * mounted by this patch; balances here are asserted at the store level.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { worker } from '../src/index';
import { D1FulfillmentStore } from '../src/payments/store';
import { FakeD1, TEST_SECRET, TEST_ACCOUNT, TEST_TOKEN, TEST_BUSINESS, signDelivery, fixture, seedOrder } from './helpers';

vi.mock('../src/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth')>();
  const { authMock } = await import('./helpers');
  // Partial mock: the real auth module loads (its other exports power the
  // mounted worker routes); only the account seam payments consumes is faked.
  return { ...actual, requireAccount: authMock.requireAccount, accountCreditBalance: authMock.accountCreditBalance };
});

const ORIGIN = 'https://doxomachy.vercel.app';

let db: FakeD1;
let env: any;

const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  db = new FakeD1();
  env = {
    WEB_ORIGIN: ORIGIN,
    DB: db as unknown as D1Database,
    MIND: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response('{}') }) },
    DODO_WEBHOOK_SECRET: TEST_SECRET,
    DODO_API_KEY: 'test_api_key',
    DODO_API_BASE: 'https://test.dodopayments.com',
    DODO_PRODUCT_ID: 'pdt_test_5pack',
    DODO_RETURN_URL: `${ORIGIN}/pricing.html?checkout=return`,
    DODO_CHECKOUT_ENABLED: 'false',
    DODO_BUSINESS_ID: TEST_BUSINESS,
  };
});

const post = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://worker.test${path}`, { method: 'POST', ...init }), env);

describe('POST /webhooks/dodo (mounted)', () => {
  it('fulfills a signed payment.succeeded end to end; the owning account balance reflects the grant', async () => {
    const store = new D1FulfillmentStore(env.DB);
    await seedOrder(store);
    const { raw } = fixture('payment-succeeded.json');
    const headers = await signDelivery(TEST_SECRET, 'msg_wire_1', nowSeconds(), raw);
    const res = await post('/webhooks/dodo', { headers: { 'content-type': 'application/json', ...headers }, body: raw });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, outcome: 'granted' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('rejects unsigned, badly-signed and unconfigured deliveries', async () => {
    expect((await post('/webhooks/dodo', { headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    const headers = await signDelivery(TEST_SECRET, 'msg_wire_bad', nowSeconds(), '{}');
    headers['webhook-signature'] = 'v1,AAAAAAA=';
    expect((await post('/webhooks/dodo', { headers: { 'content-type': 'application/json', ...headers }, body: '{}' })).status).toBe(401);
    delete env.DODO_WEBHOOK_SECRET;
    expect((await post('/webhooks/dodo', { headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(503);
  });

  it('enforces the actual-byte cap on oversized chunked bodies without Content-Length', async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 40; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        controller.close();
      },
    });
    const headers = await signDelivery(TEST_SECRET, 'msg_wire_chunked', nowSeconds(), 'irrelevant');
    const res = await post('/webhooks/dodo', {
      // @ts-expect-error undici requires duplex for stream bodies
      duplex: 'half',
      headers: { 'content-type': 'application/json', ...headers },
      body: stream,
    });
    expect(res.status).toBe(413);
  });

  it('still accepts a signed payload well over the 2KB browser cap', async () => {
    const store = new D1FulfillmentStore(env.DB);
    await seedOrder(store);
    const { raw } = fixture('payment-succeeded.json');
    const padded = raw.replace('}', ',"padding":"' + 'x'.repeat(6000) + '"}');
    const headers = await signDelivery(TEST_SECRET, 'msg_wire_big', nowSeconds(), padded);
    expect((await post('/webhooks/dodo', { headers: { 'content-type': 'application/json', ...headers }, body: padded })).status).toBe(200);
  });

  it('does not leak CORS headers on the server-to-server route', async () => {
    const res = await post('/webhooks/dodo', { headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('browser payment routes (mounted)', () => {
  it('keeps checkout creation disabled as shipped', async () => {
    const res = await post('/v1/checkout/session', {
      headers: { Origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}`, 'idempotency-key': 'idem-key-00000001' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'checkout_disabled' });
  });

  it('rejects missing and wrong Origin on browser payment routes', async () => {
    // no Origin header at all
    const noOrigin = await post('/v1/checkout/session', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}`, 'idempotency-key': 'idem-key-00000001' },
      body: '{}',
    });
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toMatchObject({ error: 'origin_not_allowed' });
    // wrong Origin
    const wrong = await post('/v1/checkout/session', {
      headers: { Origin: 'https://evil.example', 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}`, 'idempotency-key': 'idem-key-00000001' },
      body: '{}',
    });
    expect(wrong.status).toBe(403);
  });
});

describe('ops reconciliation route (mounted)', () => {
  it('404s when no admin key is configured', async () => {
    const res = await post('/v1/admin/dodo/reconcile', { headers: { authorization: 'Bearer whatever' } });
    expect(res.status).toBe(404);
  });
});
