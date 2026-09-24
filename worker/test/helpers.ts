/**
 * Test harness for the Dodo Payments integration (rev 4).
 *
 * FakeD1 runs the REAL D1FulfillmentStore SQL (and the real 0001 + auth 0002
 * + 0002_dodo_payments + 0003_dodo_disputes migrations) against node:sqlite, which is the same
 * SQLite dialect D1 uses. PRAGMA foreign_keys is ON so the ownership FKs to
 * accounts(id) are exercised exactly as D1 enforces them; the two TEST_ACCOUNT
 * rows are pre-seeded in accounts.
 * FailingD1 wraps it to inject one-shot storage failures (checkout D1 failure
 * and inbox retry tests).
 *
 * Account auth is the AUTH LANE's seam (requireAccount in worker/src/auth.ts).
 * Route tests mock that module boundary with authMock below; payments tests
 * never create account_sessions rows (that table is owned by the auth lane's
 * own migration).
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSignature } from '../src/payments/standard-webhooks';
import type { DodoOrder, CheckoutIntent } from '../src/payments/store';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

export const TEST_SECRET_KEY_B64 = 'dGVzdC1zaWduaW5nLWtleS1mb3ItZG94b21hY2h5'; // base64 test key bytes
export const TEST_SECRET = `whsec_${TEST_SECRET_KEY_B64}`;
export const TEST_ACCOUNT = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
export const TEST_ACCOUNT_B = 'cccccccc-4444-5555-6666-dddddddddddd';
export const TEST_TOKEN = 'test-valid-token-0000000000000001';
export const TEST_TOKEN_B = 'test-valid-token-0000000000000002';
export const TEST_BUSINESS = 'bus_test_fixture';
export const NOW_SECONDS = 1_758_240_000; // fixed clock for signature tests

/**
 * Mock of the auth lane's exported seam for route tests. Use with:
 *   vi.mock('../src/auth', async () => ({ ...(await import('./helpers')).authMock }));
 */
export const authMock = {
  requireAccount: async (request: Request): Promise<{ accountId: string } | null> => {
    const header = request.headers.get('authorization') || '';
    if (header === `Bearer ${TEST_TOKEN}`) return { accountId: TEST_ACCOUNT };
    if (header === `Bearer ${TEST_TOKEN_B}`) return { accountId: TEST_ACCOUNT_B };
    return null;
  },
  accountCreditBalance: async (env: { DB: D1Database }, accountId: string): Promise<number> => {
    const row = await env.DB.prepare('SELECT balance FROM credits WHERE subject = ?').bind(accountId).first<{ balance: number }>();
    return row?.balance ?? 0;
  },
};

interface BoundStatement {
  run: () => Promise<{ meta: { changes: number } }>;
  first: () => Promise<Record<string, unknown> | null>;
  all: () => Promise<{ results: Record<string, unknown>[] }>;
}

/** Minimal D1Database-compatible shim backed by node:sqlite. */
export class FakeD1 {
  private db = new DatabaseSync(':memory:');

  constructor() {
    this.db.exec('PRAGMA foreign_keys = ON');
    const migrationsDir = join(TEST_DIR, '..', 'migrations');
    for (const file of ['0001.sql', '0002.sql', '0002_dodo_payments.sql', '0003_dodo_disputes.sql', '0004_diary_sources.sql']) {
      this.db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    }
    // The two fixture accounts used across the suite (FK targets).
    seedAccountRaw(this.db, TEST_ACCOUNT);
    seedAccountRaw(this.db, TEST_ACCOUNT_B);
  }

  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    const makeBound = (params: unknown[]): BoundStatement => ({
      run: async () => {
        const res = stmt.run(...(params as never[]));
        return { meta: { changes: Number(res.changes) } };
      },
      first: async () => ((stmt.get(...(params as never[])) as Record<string, unknown> | undefined) ?? null),
      all: async () => ({ results: stmt.all(...(params as never[])) as Record<string, unknown>[] }),
    });
    return {
      bind: (...params: unknown[]): BoundStatement => makeBound(params),
      run: () => makeBound([]).run(),
      first: () => makeBound([]).first(),
      all: () => makeBound([]).all(),
    };
  }

  async batch(statements: BoundStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Wraps a D1Database and fails the next `count` calls to prepare() whose SQL
 * contains `match` (then passes through). Used to exercise storage-failure
 * paths without changing the code under test.
 */
export class FailingD1 {
  private failures: { match: string; remaining: number }[] = [];
  constructor(private inner: D1Database) {}
  failNext(match: string, count = 1) {
    this.failures.push({ match, remaining: count });
  }
  prepare(sql: string) {
    for (const f of this.failures) {
      if (f.remaining > 0 && sql.includes(f.match)) {
        f.remaining--;
        throw new Error('injected storage failure');
      }
    }
    return this.inner.prepare(sql);
  }
  batch(stmts: D1PreparedStatement[]) {
    return this.inner.batch(stmts);
  }
}

const seedAccountRaw = (db: DatabaseSync, accountId: string): void => {
  db.prepare('INSERT INTO accounts (id, email_hmac, created_at) VALUES (?, ?, ?)').run(accountId, `hmac-${accountId}`, 1_758_000_000_000);
};

/** Seed an extra account row (FK target) for tests that need a third account. */
export const seedAccount = async (db: D1Database, accountId: string): Promise<void> => {
  await db.prepare('INSERT INTO accounts (id, email_hmac, created_at) VALUES (?, ?, ?)').bind(accountId, `hmac-${accountId}`, 1_758_000_000_000).run();
};

/** Sign a raw body the way Dodo's delivery infrastructure does. */
export const signDelivery = async (
  secret: string,
  id: string,
  timestampSeconds: number,
  rawBody: string,
): Promise<Record<string, string>> => ({
  'webhook-id': id,
  'webhook-timestamp': String(timestampSeconds),
  'webhook-signature': `v1,${await computeSignature(secret, id, String(timestampSeconds), rawBody)}`,
});

export const webhookRequest = (headers: Record<string, string>, rawBody: string): Request =>
  new Request('https://worker.test/webhooks/dodo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });

export const fixture = (name: string): { raw: string; event: any } => {
  const raw = readFileSync(join(TEST_DIR, 'fixtures', name), 'utf8');
  return { raw, event: JSON.parse(raw) };
};

export const seedOrder = async (
  store: { createOrder: (o: DodoOrder) => Promise<void> },
  overrides: Partial<DodoOrder> = {},
): Promise<DodoOrder> => {
  const order: DodoOrder = {
    session_id: 'cs_test_5pack',
    account_id: TEST_ACCOUNT,
    payment_id: null,
    business_id: TEST_BUSINESS,
    status: 'created',
    product_id: 'pdt_test_5pack',
    credits: 5,
    total_amount: null,
    currency: null,
    quarantine_reason: null,
    created_at: 1_758_000_000_000,
    updated_at: 1_758_000_000_000,
    ...overrides,
  };
  await store.createOrder(order);
  return order;
};

export const seedIntent = async (
  store: { createIntent: (i: CheckoutIntent) => Promise<void> },
  overrides: Partial<CheckoutIntent> = {},
): Promise<CheckoutIntent> => {
  const intent: CheckoutIntent = {
    intent_key: `${TEST_ACCOUNT}:idem-fixture-0001`,
    account_id: TEST_ACCOUNT,
    status: 'created',
    session_id: 'cs_test_5pack',
    checkout_url: 'https://test.dodopayments.com/checkout/cs_test_5pack',
    payment_id: null,
    product_id: 'pdt_test_5pack',
    credits: 5,
    error: null,
    created_at: 1_758_000_000_000,
    updated_at: 1_758_000_000_000,
    ...overrides,
  };
  await store.createIntent(intent);
  return intent;
};
