/**
 * Storage abstraction for the Dodo Payments pipeline (rev 3).
 *
 * Backends:
 *   - D1FulfillmentStore: production adapter over the Cloudflare D1 binding.
 *   - (tests) a node:sqlite implementation in worker/test/helpers.ts.
 *
 * Schema: worker/migrations/0002_dodo_payments.sql. Invariants:
 *   - webhook_inbox: one row per webhook-id, claimed under an owner-token
 *     lease. claimDelivery inserts-as-claim or steals a failed/stale row;
 *     complete/fail are conditional on (webhook_id, claim_token), so a stale
 *     attempt can never overwrite a newer owner's outcome. The stored payload
 *     is the MINIMIZED verified event (linkage + amounts only, no customer
 *     PII) and is cleared on completion; the reconciler prunes old rows.
 *   - payment_locks: one row per payment serializes every entitlement
 *     transition (grant/refund/dispute), so concurrent deliveries compute
 *     their deltas against a stable ledger.
 *   - credit_ledger: unique reference per transition -> exactly-once. Deltas
 *     are computed in code INSIDE the per-payment lock from cumulative ledger
 *     sums ("revoke at most the outstanding grant", "a refund always beats a
 *     dispute win").
 *   - credits(subject, balance) from 0001 is shared with the auth lane, which
 *     mutates balance directly. Payments applies ADDITIVE deltas floored at
 *     zero (MAX(0, balance + delta)); it never writes an absolute balance
 *     recomputed from its own ledger, which would clobber auth-lane spends.
 *     balance_applied flags bridge a crash between the two writes; the
 *     reconciler re-applies pending deltas.
 */

export const UNMATCHED_SUBJECT = 'unmatched'; // ledger subject for suppression markers with no known order

export type OrderStatus =
  | 'created' | 'succeeded' | 'failed' | 'cancelled'
  | 'partially_refunded' | 'refunded' | 'disputed' | 'quarantined';

export interface DodoOrder {
  session_id: string; // Dodo checkout session id (primary key)
  account_id: string; // entitlement subject: authenticated account UUID
  payment_id: string | null;
  business_id: string | null;
  status: OrderStatus;
  product_id: string;
  credits: number; // moves to grant for this order (server-decided, never client input)
  total_amount: number | null; // smallest currency unit, from payment.succeeded
  currency: string | null;
  quarantine_reason: string | null;
  created_at: number;
  updated_at: number;
}

export type InboxStatus = 'processing' | 'completed' | 'failed';

export interface InboxRecord {
  webhook_id: string;
  provider: string;
  event_type: string;
  payload: string | null; // minimized verified event; NULL once completed
  status: InboxStatus;
  claim_token: string | null;
  claimed_at: number | null;
  attempts: number;
  outcome: string | null;
  error: string | null;
  received_at: number;
  updated_at: number;
  processed_at: number | null;
}

export type ClaimResult =
  | { deliver: true; token: string }
  | { deliver: false; reason: 'completed' | 'in_progress' };

export type IntentStatus = 'pending' | 'created' | 'failed' | 'recovered' | 'abandoned' | 'needs_reconciliation';

export interface CheckoutIntent {
  intent_key: string; // account_id || ':' || caller idempotency key
  account_id: string;
  status: IntentStatus;
  session_id: string | null;
  checkout_url: string | null;
  payment_id: string | null;
  product_id: string;
  credits: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface RefundRecord {
  refund_id: string;
  payment_id: string;
  amount_minor: number | null;
  currency: string | null;
  status: string;
  created_at: number;
}

export interface PaymentSums {
  granted: number; // SUM of positive deltas (grants + re-grants)
  revoked: number; // SUM of -negative deltas (all revokes)
  refund_revoked: number; // revoked under revoke:refund:<payment_id>:% references
  dispute_revoked: number; // revoked under revoke:dispute:<payment_id>
}

export interface PendingDelta {
  reference: string;
  subject: string;
  payment_id: string | null;
  delta: number;
}

/**
 * recordRefund result. Refund identity (payment_id, amount_minor, currency)
 * is IMMUTABLE once recorded: exact duplicates may only move status
 * monotonically (anything -> succeeded; never succeeded -> failed), and
 * conflicting duplicates are rejected as 'conflict' (never overwritten).
 */
export type RefundRecordResult = 'recorded' | 'duplicate' | 'status_updated' | 'conflict';

export interface DisputeRecord {
  dispute_id: string;
  payment_id: string;
  amount_minor: number | null;
  currency: string | null;
  status: string; // opened | challenged | accepted | won | lost | cancelled | expired
  created_at: number;
}

/**
 * recordDispute result. Dispute identity (payment_id, amount_minor, currency)
 * is IMMUTABLE once recorded, and status moves ONLY through the explicit
 * transition table below: won/lost/cancelled/expired are terminal, so a stale
 * event (e.g. dispute.opened delivered after dispute.won) is 'rejected' -
 * no state change, and fulfillment gives it no entitlement effect.
 */
export type DisputeRecordResult = 'recorded' | 'duplicate' | 'status_updated' | 'conflict' | 'rejected';

/** Explicit dispute status transition table. Any status absent from this map is TERMINAL. */
export const DISPUTE_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  opened: new Set(['challenged', 'accepted', 'won', 'lost', 'cancelled', 'expired']),
  challenged: new Set(['accepted', 'won', 'lost', 'cancelled', 'expired']),
  accepted: new Set(['lost', 'cancelled', 'expired']),
};

export interface FulfillmentStore {
  // --- webhook inbox (owner-token lease) ---
  /**
   * Insert-as-claim a verified delivery, or claim a failed/stale one.
   * Returns the claim token the caller must present to complete/fail.
   */
  claimDelivery(webhookId: string, provider: string, eventType: string, payload: string, now: number, staleMs: number): Promise<ClaimResult>;
  /** Conditional on (webhook_id, claim_token, processing): marks completed and CLEARS the stored payload. */
  completeDelivery(webhookId: string, token: string, outcome: string, now: number): Promise<boolean>;
  /** Conditional on (webhook_id, claim_token, processing): marks failed, keeps the payload for replay. */
  failDelivery(webhookId: string, token: string, error: string, now: number): Promise<boolean>;
  listDeliveries(statuses: InboxStatus[], limit: number): Promise<InboxRecord[]>;
  /** Retention: delete completed rows older than completedBefore and failed rows older than failedBefore. */
  pruneDeliveries(completedBefore: number, failedBefore: number): Promise<{ completed: number; failed: number }>;

  // --- per-payment lock ---
  acquirePaymentLock(paymentId: string, owner: string, now: number, staleMs: number): Promise<boolean>;
  releasePaymentLock(paymentId: string, owner: string): Promise<void>;

  // --- orders ---
  findOrderBySession(sessionId: string): Promise<DodoOrder | null>;
  findOrderByPayment(paymentId: string): Promise<DodoOrder | null>;
  listOrdersByStatus(status: OrderStatus, limit: number): Promise<DodoOrder[]>;
  createOrder(order: DodoOrder): Promise<void>;
  updateOrder(sessionId: string, patch: Partial<Pick<DodoOrder, 'payment_id' | 'business_id' | 'status' | 'total_amount' | 'currency' | 'quarantine_reason' | 'updated_at'>>): Promise<void>;

  // --- refunds ---
  /** Insert a refund record, or resolve a duplicate monotonically. Identity fields never rewrite. */
  recordRefund(refund: RefundRecord): Promise<RefundRecordResult>;
  /** Succeeded refunds for a payment in record order (grant-time settling). */
  succeededRefunds(paymentId: string): Promise<RefundRecord[]>;
  /**
   * Cumulative succeeded-refund total in the ORDER's currency. Rows in a
   * different (non-null) currency are EXCLUDED from the math (they are
   * flagged as conflicts at fulfillment time); rows missing currency or
   * amount make hasUnknown true (conservative: treated as full refunds).
   */
  refundedAmount(paymentId: string, orderCurrency: string): Promise<{ total: number; hasUnknown: boolean }>;

  // --- disputes ---
  recordDispute(dispute: DisputeRecord): Promise<DisputeRecordResult>;

  // --- ledger ---
  hasLedger(reference: string): Promise<boolean>;
  hasLedgerPrefix(prefix: string): Promise<boolean>;
  paymentSums(paymentId: string): Promise<PaymentSums>;
  /** Record a 0-delta marker (grant suppression / already-settled evidence). Exactly-once by reference. */
  applyMarker(reference: string, subject: string, paymentId: string | null, reason: string, at: number): Promise<'applied' | 'duplicate'>;
  /**
   * Apply one ledger delta and the matching ADDITIVE credits.balance mutation
   * (floored at zero). Exactly-once by reference. The balance write + its
   * balance_applied flag are one atomic batch; the reconciler re-applies any
   * delta whose flag is still 0 (crash between the two).
   */
  applyLedgerDelta(reference: string, subject: string, paymentId: string | null, delta: number, reason: string, at: number): Promise<'applied' | 'duplicate'>;
  /**
   * Like applyLedgerDelta, but first UPGRADES an existing 0-delta suppression
   * marker at the same reference into the real delta (used when a refund was
   * recorded before its grant landed). Exactly-once: only one caller flips
   * the marker or inserts the row.
   */
  applyDeltaOverMarker(reference: string, subject: string, paymentId: string | null, delta: number, reason: string, at: number): Promise<'applied' | 'duplicate'>;
  /** Ledger references with a prefix (drift scans: refund_conflict, refund_currency). */
  listLedgerReferences(prefix: string, limit: number): Promise<string[]>;
  pendingBalanceDeltas(limit: number): Promise<PendingDelta[]>;
  /**
   * Re-apply one unapplied balance delta. The CALLER must hold the
   * per-payment lock for the delta's payment (reconcile does): the lock
   * serializes concurrent reconcilers, and the balance write + applied flag
   * commit as one atomic batch, so a crash mid-batch rolls both back and the
   * delta stays reappliable. Same delta = same payment = same lock.
   */
  reapplyLedgerDelta(reference: string, at: number): Promise<boolean>;
  balance(subject: string): Promise<number>;

  // --- checkout intents ---
  findIntent(intentKey: string): Promise<CheckoutIntent | null>;
  listIntents(status: IntentStatus, updatedBefore: number, limit: number): Promise<CheckoutIntent[]>;
  createIntent(intent: CheckoutIntent): Promise<void>;
  updateIntent(intentKey: string, patch: Partial<Pick<CheckoutIntent, 'status' | 'session_id' | 'checkout_url' | 'payment_id' | 'error' | 'updated_at'>>): Promise<void>;
  /** Conditional finalize: only a still-pending intent flips. Returns false when another attempt won. */
  finalizeIntent(intentKey: string, sessionId: string, checkoutUrl: string | null, now: number): Promise<boolean>;
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => '\\' + c);

/** D1-backed implementation. All statements are parameterized. */
export class D1FulfillmentStore implements FulfillmentStore {
  constructor(private db: D1Database) {}

  // --- webhook inbox ---

  async claimDelivery(webhookId: string, provider: string, eventType: string, payload: string, now: number, staleMs: number): Promise<ClaimResult> {
    const token = crypto.randomUUID();
    const inserted = await this.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_inbox (webhook_id, provider, event_type, payload, status, claim_token, claimed_at, attempts, received_at, updated_at)
         VALUES (?, ?, ?, ?, 'processing', ?, ?, 1, ?, ?)`,
      )
      .bind(webhookId, provider, eventType, payload, token, now, now, now)
      .run();
    if ((inserted.meta?.changes ?? 0) === 1) return { deliver: true, token };

    const row = await this.db
      .prepare('SELECT status, claim_token, claimed_at FROM webhook_inbox WHERE webhook_id = ?')
      .bind(webhookId)
      .first<{ status: InboxStatus; claim_token: string | null; claimed_at: number | null }>();
    if (!row) return { deliver: false, reason: 'in_progress' }; // lost a bizarre race; ask for a retry
    if (row.status === 'completed') return { deliver: false, reason: 'completed' };
    const stale = row.status === 'processing' && (row.claimed_at ?? 0) >= now - staleMs;
    if (stale) return { deliver: false, reason: 'in_progress' }; // live owner still working

    // Failed row or expired lease: steal, conditional on the exact state read.
    const stolen = await this.db
      .prepare(
        `UPDATE webhook_inbox
         SET status = 'processing', claim_token = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ?, error = NULL
         WHERE webhook_id = ? AND status = ? AND claimed_at IS ? AND claim_token IS ?`,
      )
      .bind(token, now, now, webhookId, row.status, row.claimed_at, row.claim_token)
      .run();
    return (stolen.meta?.changes ?? 0) === 1 ? { deliver: true, token } : { deliver: false, reason: 'in_progress' };
  }

  async completeDelivery(webhookId: string, token: string, outcome: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE webhook_inbox
         SET status = 'completed', outcome = ?, processed_at = ?, updated_at = ?, error = NULL,
             payload = NULL, claim_token = NULL, claimed_at = NULL
         WHERE webhook_id = ? AND claim_token = ? AND status = 'processing'`,
      )
      .bind(outcome, now, now, webhookId, token)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async failDelivery(webhookId: string, token: string, error: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE webhook_inbox
         SET status = 'failed', error = ?, updated_at = ?, claim_token = NULL, claimed_at = NULL
         WHERE webhook_id = ? AND claim_token = ? AND status = 'processing'`,
      )
      .bind(error.slice(0, 500), now, webhookId, token)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async listDeliveries(statuses: InboxStatus[], limit: number): Promise<InboxRecord[]> {
    const marks = statuses.map(() => '?').join(',');
    const res = await this.db
      .prepare(`SELECT * FROM webhook_inbox WHERE status IN (${marks}) ORDER BY received_at ASC LIMIT ?`)
      .bind(...statuses, limit)
      .all<InboxRecord>();
    return res.results ?? [];
  }

  async pruneDeliveries(completedBefore: number, failedBefore: number): Promise<{ completed: number; failed: number }> {
    const completed = await this.db
      .prepare(`DELETE FROM webhook_inbox WHERE status = 'completed' AND processed_at IS NOT NULL AND processed_at < ?`)
      .bind(completedBefore)
      .run();
    const failed = await this.db
      .prepare(`DELETE FROM webhook_inbox WHERE status = 'failed' AND updated_at < ?`)
      .bind(failedBefore)
      .run();
    return { completed: completed.meta?.changes ?? 0, failed: failed.meta?.changes ?? 0 };
  }

  // --- per-payment lock ---

  async acquirePaymentLock(paymentId: string, owner: string, now: number, staleMs: number): Promise<boolean> {
    const inserted = await this.db
      .prepare('INSERT OR IGNORE INTO payment_locks (payment_id, owner, acquired_at) VALUES (?, ?, ?)')
      .bind(paymentId, owner, now)
      .run();
    if ((inserted.meta?.changes ?? 0) === 1) return true;
    const row = await this.db
      .prepare('SELECT owner, acquired_at FROM payment_locks WHERE payment_id = ?')
      .bind(paymentId)
      .first<{ owner: string; acquired_at: number }>();
    if (!row || now - row.acquired_at < staleMs) return false;
    // Expired lease: steal, conditional on the exact row read.
    const stolen = await this.db
      .prepare('UPDATE payment_locks SET owner = ?, acquired_at = ? WHERE payment_id = ? AND owner = ? AND acquired_at = ?')
      .bind(owner, now, paymentId, row.owner, row.acquired_at)
      .run();
    return (stolen.meta?.changes ?? 0) === 1;
  }

  async releasePaymentLock(paymentId: string, owner: string): Promise<void> {
    await this.db.prepare('DELETE FROM payment_locks WHERE payment_id = ? AND owner = ?').bind(paymentId, owner).run();
  }

  // --- orders ---

  async findOrderBySession(sessionId: string): Promise<DodoOrder | null> {
    return (await this.db.prepare('SELECT * FROM dodo_orders WHERE session_id = ?').bind(sessionId).first<DodoOrder>()) ?? null;
  }

  async findOrderByPayment(paymentId: string): Promise<DodoOrder | null> {
    return (await this.db.prepare('SELECT * FROM dodo_orders WHERE payment_id = ?').bind(paymentId).first<DodoOrder>()) ?? null;
  }

  async listOrdersByStatus(status: OrderStatus, limit: number): Promise<DodoOrder[]> {
    const res = await this.db
      .prepare('SELECT * FROM dodo_orders WHERE status = ? ORDER BY updated_at ASC LIMIT ?')
      .bind(status, limit)
      .all<DodoOrder>();
    return res.results ?? [];
  }

  async createOrder(order: DodoOrder): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dodo_orders (session_id, account_id, payment_id, business_id, status, product_id, credits, total_amount, currency, quarantine_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        order.session_id,
        order.account_id,
        order.payment_id,
        order.business_id,
        order.status,
        order.product_id,
        order.credits,
        order.total_amount,
        order.currency,
        order.quarantine_reason ?? null,
        order.created_at,
        order.updated_at,
      )
      .run();
  }

  async updateOrder(sessionId: string, patch: Partial<Pick<DodoOrder, 'payment_id' | 'business_id' | 'status' | 'total_amount' | 'currency' | 'quarantine_reason' | 'updated_at'>>): Promise<void> {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of ['payment_id', 'business_id', 'status', 'total_amount', 'currency', 'quarantine_reason', 'updated_at'] as const) {
      if (key in patch) {
        fields.push(`${key} = ?`);
        values.push(patch[key] ?? null);
      }
    }
    if (!fields.length) return;
    values.push(sessionId);
    await this.db.prepare(`UPDATE dodo_orders SET ${fields.join(', ')} WHERE session_id = ?`).bind(...values).run();
  }

  // --- refunds ---

  async recordRefund(refund: RefundRecord): Promise<RefundRecordResult> {
    const inserted = await this.db
      .prepare('INSERT OR IGNORE INTO dodo_refunds (refund_id, payment_id, amount_minor, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(refund.refund_id, refund.payment_id, refund.amount_minor, refund.currency, refund.status, refund.created_at)
      .run();
    if ((inserted.meta?.changes ?? 0) > 0) return 'recorded';
    const existing = await this.db.prepare('SELECT * FROM dodo_refunds WHERE refund_id = ?').bind(refund.refund_id).first<RefundRecord>();
    if (!existing) return 'conflict'; // insert lost a race but row vanished: treat as conflict, never overwrite blindly
    // Identity is immutable: any real difference is a conflict, never a rewrite.
    if (existing.payment_id !== refund.payment_id) return 'conflict';
    if (refund.amount_minor !== null && existing.amount_minor !== null && existing.amount_minor !== refund.amount_minor) return 'conflict';
    if (refund.currency && existing.currency && existing.currency !== refund.currency) return 'conflict';
    if (existing.status === 'succeeded') return 'duplicate'; // monotonic: never downgrade, never rewrite
    // Existing non-succeeded record: allow the monotonic upgrade and null-fill
    // refinement only (existing non-null values win).
    await this.db
      .prepare(`UPDATE dodo_refunds SET status = ?, amount_minor = COALESCE(amount_minor, ?), currency = COALESCE(currency, ?) WHERE refund_id = ? AND status <> 'succeeded'`)
      .bind(refund.status, refund.amount_minor, refund.currency, refund.refund_id)
      .run();
    return refund.status === 'succeeded' && existing.status !== 'succeeded' ? 'status_updated' : 'duplicate';
  }

  async succeededRefunds(paymentId: string): Promise<RefundRecord[]> {
    const res = await this.db
      .prepare("SELECT * FROM dodo_refunds WHERE payment_id = ? AND status = 'succeeded' ORDER BY created_at ASC, refund_id ASC")
      .bind(paymentId)
      .all<RefundRecord>();
    return res.results ?? [];
  }

  async recordDispute(dispute: DisputeRecord): Promise<DisputeRecordResult> {
    const inserted = await this.db
      .prepare('INSERT OR IGNORE INTO dodo_disputes (dispute_id, payment_id, amount_minor, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(dispute.dispute_id, dispute.payment_id, dispute.amount_minor, dispute.currency, dispute.status, dispute.created_at, dispute.created_at)
      .run();
    if ((inserted.meta?.changes ?? 0) > 0) return 'recorded';
    const existing = await this.db.prepare('SELECT * FROM dodo_disputes WHERE dispute_id = ?').bind(dispute.dispute_id).first<DisputeRecord>();
    if (!existing) return 'conflict'; // insert lost a race but row vanished: never overwrite blindly
    // Identity is immutable: any real difference is a conflict, never a rewrite.
    if (existing.payment_id !== dispute.payment_id) return 'conflict';
    if (dispute.amount_minor !== null && existing.amount_minor !== null && existing.amount_minor !== dispute.amount_minor) return 'conflict';
    if (dispute.currency && existing.currency && existing.currency !== dispute.currency) return 'conflict';
    if (existing.status === dispute.status) return 'duplicate';
    // Status is monotonic through the explicit transition table; a status
    // absent from DISPUTE_TRANSITIONS is terminal and rejects everything.
    if (!DISPUTE_TRANSITIONS[existing.status]?.has(dispute.status)) return 'rejected';
    await this.db
      .prepare('UPDATE dodo_disputes SET status = ?, amount_minor = COALESCE(amount_minor, ?), currency = COALESCE(currency, ?), updated_at = ? WHERE dispute_id = ?')
      .bind(dispute.status, dispute.amount_minor, dispute.currency, dispute.created_at, dispute.dispute_id)
      .run();
    return 'status_updated';
  }

  async refundedAmount(paymentId: string, orderCurrency: string): Promise<{ total: number; hasUnknown: boolean }> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN currency = ? THEN amount_minor ELSE 0 END), 0) AS total,
                COALESCE(SUM(CASE WHEN currency IS NULL OR amount_minor IS NULL THEN 1 ELSE 0 END), 0) AS unknown_count
         FROM dodo_refunds WHERE payment_id = ? AND status = 'succeeded'`,
      )
      .bind(orderCurrency, paymentId)
      .first<{ total: number; unknown_count: number }>();
    return { total: row?.total ?? 0, hasUnknown: (row?.unknown_count ?? 0) > 0 };
  }

  // --- ledger ---

  async hasLedger(reference: string): Promise<boolean> {
    return !!(await this.db.prepare('SELECT 1 AS x FROM credit_ledger WHERE reference = ? LIMIT 1').bind(reference).first());
  }

  async hasLedgerPrefix(prefix: string): Promise<boolean> {
    return !!(await this.db.prepare("SELECT 1 AS x FROM credit_ledger WHERE reference LIKE ? ESCAPE '\\' LIMIT 1").bind(escapeLike(prefix) + '%').first());
  }

  async paymentSums(paymentId: string): Promise<PaymentSums> {
    const row = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN delta > 0 THEN delta END), 0) AS granted,
           -COALESCE(SUM(CASE WHEN delta < 0 THEN delta END), 0) AS revoked,
           -COALESCE(SUM(CASE WHEN delta < 0 AND reference LIKE ? ESCAPE '\\' THEN delta END), 0) AS refund_revoked,
           -COALESCE(SUM(CASE WHEN delta < 0 AND reference = ? THEN delta END), 0) AS dispute_revoked
         FROM credit_ledger WHERE payment_id = ?`,
      )
      .bind(escapeLike(`revoke:refund:${paymentId}:`) + '%', `revoke:dispute:${paymentId}`, paymentId)
      .first<PaymentSums>();
    return row ?? { granted: 0, revoked: 0, refund_revoked: 0, dispute_revoked: 0 };
  }

  private balanceStatement(subject: string, delta: number, at: number): D1PreparedStatement {
    return delta > 0
      ? this.db
          .prepare(
            `INSERT INTO credits (subject, balance, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(subject) DO UPDATE SET balance = balance + ?, updated_at = ?`,
          )
          .bind(subject, delta, at, delta, at)
      : this.db
          .prepare('UPDATE credits SET balance = MAX(0, balance + ?), updated_at = ? WHERE subject = ?')
          .bind(delta, at, subject);
  }

  async applyMarker(reference: string, subject: string, paymentId: string | null, reason: string, at: number): Promise<'applied' | 'duplicate'> {
    const inserted = await this.db
      .prepare('INSERT OR IGNORE INTO credit_ledger (reference, subject, payment_id, delta, reason, balance_applied, created_at) VALUES (?, ?, ?, 0, ?, 1, ?)')
      .bind(reference, subject, paymentId, reason, at)
      .run();
    return (inserted.meta?.changes ?? 0) > 0 ? 'applied' : 'duplicate';
  }

  async applyLedgerDelta(reference: string, subject: string, paymentId: string | null, delta: number, reason: string, at: number): Promise<'applied' | 'duplicate'> {
    if (delta === 0 || subject === UNMATCHED_SUBJECT) return this.applyMarker(reference, subject, paymentId, reason, at);
    if (delta < 0) return this.applyLedgerDebit(reference, subject, paymentId, -delta, reason, at);
    const inserted = await this.db
      .prepare('INSERT OR IGNORE INTO credit_ledger (reference, subject, payment_id, delta, reason, balance_applied, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .bind(reference, subject, paymentId, delta, reason, at)
      .run();
    if ((inserted.meta?.changes ?? 0) === 0) return 'duplicate';
    // Ledger row landed; the balance mutation + applied flag are one atomic batch.
    await this.db.batch([
      this.balanceStatement(subject, delta, at),
      this.db.prepare('UPDATE credit_ledger SET balance_applied = 1 WHERE reference = ?').bind(reference),
    ]);
    return 'applied';
  }

  /**
   * DEBIT path. The ledger records BALANCE MOVEMENT, not entitlement
   * liability: fulfillment decides the REQUEST (liability), and this method
   * atomically records only the amount actually removed from the live shared
   * balance, -MIN(balance, request), in the same batch that applies it. A
   * buyer who already spent part of the grant can never have a dispute or
   * refund debit more than remains, and a later restore can only return what
   * was actually taken. One batch = the compute, the balance mutation and the
   * applied flag are atomic together (D1 batch / synchronous node:sqlite); the
   * guarded UPDATE no-ops on exact duplicates (balance_applied already 1).
   */
  private async applyLedgerDebit(reference: string, subject: string, paymentId: string | null, request: number, reason: string, at: number): Promise<'applied' | 'duplicate'> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO credit_ledger (reference, subject, payment_id, delta, reason, balance_applied, created_at)
           SELECT ?, ?, ?, -MIN(COALESCE((SELECT balance FROM credits WHERE subject = ?), 0), ?), ?, 0, ?`,
        )
        .bind(reference, subject, paymentId, subject, request, reason, at),
      this.db
        .prepare(
          `UPDATE credits SET balance = MAX(0, balance + (SELECT delta FROM credit_ledger WHERE reference = ?)), updated_at = ?
           WHERE subject = ? AND EXISTS (SELECT 1 FROM credit_ledger WHERE reference = ? AND balance_applied = 0)`,
        )
        .bind(reference, at, subject, reference),
      this.db.prepare('UPDATE credit_ledger SET balance_applied = 1 WHERE reference = ?').bind(reference),
    ]);
    return (results[0].meta?.changes ?? 0) > 0 ? 'applied' : 'duplicate';
  }

  async applyDeltaOverMarker(reference: string, subject: string, paymentId: string | null, delta: number, reason: string, at: number): Promise<'applied' | 'duplicate'> {
    if (delta === 0 || subject === UNMATCHED_SUBJECT) return this.applyMarker(reference, subject, paymentId, reason, at);
    if (delta < 0) return this.applyDebitOverMarker(reference, subject, paymentId, -delta, reason, at);
    const upgraded = await this.db
      .prepare('UPDATE credit_ledger SET subject = ?, delta = ?, reason = ?, balance_applied = 0 WHERE reference = ? AND delta = 0')
      .bind(subject, delta, reason, reference)
      .run();
    if ((upgraded.meta?.changes ?? 0) === 0) {
      const inserted = await this.db
        .prepare('INSERT OR IGNORE INTO credit_ledger (reference, subject, payment_id, delta, reason, balance_applied, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
        .bind(reference, subject, paymentId, delta, reason, at)
        .run();
      if ((inserted.meta?.changes ?? 0) === 0) return 'duplicate';
    }
    // Same atomic pair as applyLedgerDelta: balance mutation + applied flag.
    await this.db.batch([
      this.balanceStatement(subject, delta, at),
      this.db.prepare('UPDATE credit_ledger SET balance_applied = 1 WHERE reference = ?').bind(reference),
    ]);
    return 'applied';
  }

  /**
   * Marker-upgrade variant of applyLedgerDebit: a suppression marker recorded
   * before the grant (delta 0) is upgraded to the ACTUAL removable amount at
   * settle time, computed atomically against the post-grant live balance.
   */
  private async applyDebitOverMarker(reference: string, subject: string, paymentId: string | null, request: number, reason: string, at: number): Promise<'applied' | 'duplicate'> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE credit_ledger SET subject = ?, delta = -MIN(COALESCE((SELECT balance FROM credits WHERE subject = ?), 0), ?), reason = ?, balance_applied = 0
           WHERE reference = ? AND delta = 0`,
        )
        .bind(subject, subject, request, reason, reference),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO credit_ledger (reference, subject, payment_id, delta, reason, balance_applied, created_at)
           SELECT ?, ?, ?, -MIN(COALESCE((SELECT balance FROM credits WHERE subject = ?), 0), ?), ?, 0, ?`,
        )
        .bind(reference, subject, paymentId, subject, request, reason, at),
      this.db
        .prepare(
          `UPDATE credits SET balance = MAX(0, balance + (SELECT delta FROM credit_ledger WHERE reference = ?)), updated_at = ?
           WHERE subject = ? AND EXISTS (SELECT 1 FROM credit_ledger WHERE reference = ? AND balance_applied = 0)`,
        )
        .bind(reference, at, subject, reference),
      this.db.prepare('UPDATE credit_ledger SET balance_applied = 1 WHERE reference = ?').bind(reference),
    ]);
    const changed = (results[0].meta?.changes ?? 0) + (results[1].meta?.changes ?? 0);
    return changed > 0 ? 'applied' : 'duplicate';
  }

  async listLedgerReferences(prefix: string, limit: number): Promise<string[]> {
    const res = await this.db
      .prepare("SELECT reference FROM credit_ledger WHERE reference LIKE ? ESCAPE '\\' ORDER BY created_at ASC LIMIT ?")
      .bind(escapeLike(prefix) + '%', limit)
      .all<{ reference: string }>();
    return (res.results ?? []).map((r) => r.reference);
  }

  async pendingBalanceDeltas(limit: number): Promise<PendingDelta[]> {
    const res = await this.db
      .prepare("SELECT reference, subject, payment_id, delta FROM credit_ledger WHERE balance_applied = 0 AND delta <> 0 AND subject <> ? ORDER BY created_at ASC LIMIT ?")
      .bind(UNMATCHED_SUBJECT, limit)
      .all<PendingDelta>();
    return res.results ?? [];
  }

  async reapplyLedgerDelta(reference: string, at: number): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT subject, delta FROM credit_ledger WHERE reference = ? AND balance_applied = 0 AND delta <> 0')
      .bind(reference)
      .first<{ subject: string; delta: number }>();
    if (!row) return false;
    await this.db.batch([
      this.balanceStatement(row.subject, row.delta, at),
      this.db.prepare('UPDATE credit_ledger SET balance_applied = 1 WHERE reference = ?').bind(reference),
    ]);
    return true;
  }

  async balance(subject: string): Promise<number> {
    const row = await this.db.prepare('SELECT balance FROM credits WHERE subject = ?').bind(subject).first<{ balance: number }>();
    return row?.balance ?? 0;
  }

  // --- checkout intents ---

  async findIntent(intentKey: string): Promise<CheckoutIntent | null> {
    return (await this.db.prepare('SELECT * FROM checkout_intents WHERE intent_key = ?').bind(intentKey).first<CheckoutIntent>()) ?? null;
  }

  async listIntents(status: IntentStatus, updatedBefore: number, limit: number): Promise<CheckoutIntent[]> {
    const res = await this.db
      .prepare('SELECT * FROM checkout_intents WHERE status = ? AND updated_at < ? ORDER BY updated_at ASC LIMIT ?')
      .bind(status, updatedBefore, limit)
      .all<CheckoutIntent[]>();
    return (res.results ?? []) as unknown as CheckoutIntent[];
  }

  async createIntent(intent: CheckoutIntent): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO checkout_intents (intent_key, account_id, status, session_id, checkout_url, payment_id, product_id, credits, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(intent.intent_key, intent.account_id, intent.status, intent.session_id, intent.checkout_url, intent.payment_id ?? null, intent.product_id, intent.credits, intent.error, intent.created_at, intent.updated_at)
      .run();
  }

  async updateIntent(intentKey: string, patch: Partial<Pick<CheckoutIntent, 'status' | 'session_id' | 'checkout_url' | 'payment_id' | 'error' | 'updated_at'>>): Promise<void> {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of ['status', 'session_id', 'checkout_url', 'payment_id', 'error', 'updated_at'] as const) {
      if (key in patch) {
        fields.push(`${key} = ?`);
        values.push(patch[key] ?? null);
      }
    }
    if (!fields.length) return;
    values.push(intentKey);
    await this.db.prepare(`UPDATE checkout_intents SET ${fields.join(', ')} WHERE intent_key = ?`).bind(...values).run();
  }

  async finalizeIntent(intentKey: string, sessionId: string, checkoutUrl: string | null, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE checkout_intents SET status = 'created', session_id = ?, checkout_url = ?, error = NULL, updated_at = ?
         WHERE intent_key = ? AND status IN ('pending', 'failed')`,
      )
      .bind(sessionId, checkoutUrl, now, intentKey)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }
}
