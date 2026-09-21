/**
 * Dodo Payments webhook fulfillment (rev 3): verified events become
 * per-payment entitlement changes, serialized by a per-payment lock.
 *
 * Entitlement model: one purchase = one non-expiring pack of
 * CREDITS_PER_PURCHASE moves ($5 USD = 500 minor units), granted to the
 * AUTHENTICATED ACCOUNT recorded server-side on the order at
 * checkout-creation time. Credit counts come from the server-side order row
 * (or the server-side product catalog when an order is recovered from webhook
 * metadata), never from webhook amounts.
 *
 * Grant gate (before any credit moves): the settled payment must match the
 * expected business (when DODO_BUSINESS_ID is configured), product, currency
 * (USD) and amount (500 minor units). Any mismatch QUARANTINES the order:
 * no grant, a ledger marker for audit, and the reconciler surfaces it for a
 * human decision.
 *
 * Event mapping (https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide):
 *   payment.succeeded   -> grant the order's credits (once per payment)
 *   payment.failed / .cancelled -> order status only (and only while unpaid)
 *   payment.processing  -> informational
 *   refund.succeeded    -> revoke the PROPORTIONAL share of the pack covered
 *                          by succeeded refunds (partial refunds supported);
 *                          cumulative revokes are capped at the outstanding grant
 *   refund.failed       -> refund record only
 *   dispute.opened / .accepted / .expired / .lost
 *                       -> revoke everything still outstanding for the payment
 *   dispute.won / .cancelled
 *                       -> restore what the dispute took, minus any refunds
 *                          that settled meanwhile (a refund always beats a
 *                          dispute win)
 *
 * Concurrency/ordering hazards (Dodo retries deliveries; cross-type ordering
 * is not guaranteed):
 *   - Every mutating branch runs inside the per-payment lock (payment_locks
 *     table), so simultaneous partial refunds, or a refund racing a dispute
 *     win, compute their deltas against a stable ledger and converge exactly.
 *   - Same event redelivered -> unique credit_ledger references make every
 *     transition exactly-once.
 *   - payment.succeeded arriving after a revoke for the same payment ->
 *     suppressed: revokes are recorded even for unknown orders (0-delta
 *     markers), so a late grant can never slip past a refund or dispute.
 *   - Balance writes are additive and floored at zero: revoking a payment the
 *     account already spent from can never push the shared balance negative
 *     ("no hidden negative debt").
 */

import { FulfillmentStore, DodoOrder, RefundRecord, UNMATCHED_SUBJECT } from './store';

export const CREDITS_PER_PURCHASE = 5; // $5 USD for five non-expiring moves (PRODUCTION-CHECKLIST.md)
export const PRODUCT_PRICE_MINOR = 500; // 500 minor units = $5.00 USD
export const PRODUCT_CURRENCY = 'USD';

const LOCK_STALE_MS = 60_000; // a crashed attempt's lock is stealable after this
const LOCK_ATTEMPTS = 12;

export interface DodoWebhookEvent {
  business_id?: string;
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

/** Server-side product catalog: product id -> credits. Webhook metadata is never trusted for this. */
export type ProductCatalog = (productId: string) => number | null;

/** Expected business/product/currency/amount context a settled payment must match before any grant. */
export interface ExpectedContext {
  businessId?: string; // when configured, payloads for any other business are quarantined
  productId?: string; // server-configured product id for the pack
  currency: string;
  amountMinor: number;
}

export interface FulfillmentContext {
  catalog: ProductCatalog;
  expected: ExpectedContext;
}

export type FulfillmentOutcome =
  | { action: 'granted'; order: DodoOrder; credits: number }
  | { action: 'grant_suppressed'; order: DodoOrder; reason: 'dispute_pending' | 'already_granted' }
  | { action: 'quarantined'; order: DodoOrder; reason: string }
  | { action: 'revoked'; order: DodoOrder | null; credits: number; cause: 'refund' | 'dispute' }
  | { action: 'regranted'; order: DodoOrder; credits: number }
  | { action: 'order_recovered'; order: DodoOrder }
  | { action: 'status_only'; status: string }
  | { action: 'no_order'; paymentId: string | null }
  | { action: 'ignored'; type: string };

export class LockUnavailable extends Error {
  constructor(public readonly paymentId: string) {
    super(`payment_lock_unavailable:${paymentId}`);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const grantRef = (paymentId: string) => `grant:${paymentId}`;
const refundRevokeRef = (paymentId: string, refundId: string) => `revoke:refund:${paymentId}:${refundId}`;
const disputeRevokeRef = (paymentId: string) => `revoke:dispute:${paymentId}`;
const disputeRegrantRef = (paymentId: string) => `regrant:dispute:${paymentId}`;
const disputeConflictRef = (paymentId: string, disputeId: string) => `dispute_conflict:${paymentId}:${disputeId}`;
const disputeTransitionRef = (paymentId: string, disputeId: string) => `dispute_transition:${paymentId}:${disputeId}`;
const quarantineRef = (paymentId: string) => `quarantine:${paymentId}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialize every entitlement transition for one payment. The lock row lives
 * in D1, so this holds across isolates and Durable Object instances. A
 * crashed attempt's lock expires after LOCK_STALE_MS. LockUnavailable
 * propagates: webhook routes turn it into a 500 so Dodo retries later.
 */
export const withPaymentLock = async <T>(store: FulfillmentStore, paymentId: string, fn: () => Promise<T>): Promise<T> => {
  const owner = crypto.randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !acquired; attempt++) {
    acquired = await store.acquirePaymentLock(paymentId, owner, Date.now(), LOCK_STALE_MS);
    if (!acquired) await sleep(15 * (attempt + 1));
  }
  if (!acquired) throw new LockUnavailable(paymentId);
  try {
    return await fn();
  } finally {
    // Conditional release: a stolen lock (expired mid-flight) is not ours to delete.
    await store.releasePaymentLock(paymentId, owner).catch(() => undefined);
  }
};

/**
 * Record a dispute event into the immutable, monotonic dispute table.
 * Returns 'ok' when the event may take its entitlement effect (fresh record,
 * valid transition, or an exact same-status duplicate whose effect is already
 * exactly-once via the ledger reference). 'dispute_conflict' means the
 * dispute_id was first seen bound to a different payment/amount/currency;
 * 'dispute_rejected' means the recorded status is terminal (or the transition
 * is not in the table) and the stale event must change nothing. Both leave a
 * 0-delta drift marker for the reconciler to surface.
 */
const recordDisputeEvent = async (
  store: FulfillmentStore,
  data: Record<string, unknown>,
  paymentId: string,
  type: string,
  subject: string,
  at: number,
): Promise<'ok' | 'dispute_conflict' | 'dispute_rejected'> => {
  const disputeId = str(data.dispute_id);
  if (!disputeId) return 'ok'; // no record possible; the payment-keyed effect below is still exactly-once
  const result = await store.recordDispute({
    dispute_id: disputeId,
    payment_id: paymentId,
    amount_minor: num(data.amount),
    currency: str(data.currency),
    status: type.slice('dispute.'.length),
    created_at: at,
  });
  if (result === 'conflict') {
    await store.applyMarker(disputeConflictRef(paymentId, disputeId), subject, paymentId, type, at);
    return 'dispute_conflict';
  }
  if (result === 'rejected') {
    await store.applyMarker(disputeTransitionRef(paymentId, disputeId), subject, paymentId, type, at);
    return 'dispute_rejected';
  }
  return 'ok';
};

/** Find the server-side order for a payment/refund/dispute payload. */
const findOrder = async (store: FulfillmentStore, data: Record<string, unknown>): Promise<DodoOrder | null> => {
  const sessionId = str(data.checkout_session_id);
  const paymentId = str(data.payment_id);
  if (sessionId) {
    const bySession = await store.findOrderBySession(sessionId);
    if (bySession) return bySession;
  }
  if (paymentId) return store.findOrderByPayment(paymentId);
  return null;
};

const metadata = (data: Record<string, unknown>): Record<string, unknown> =>
  data.metadata && typeof data.metadata === 'object' ? (data.metadata as Record<string, unknown>) : {};

const linkPayment = async (store: FulfillmentStore, order: DodoOrder, data: Record<string, unknown>, businessId: string | null, at: number): Promise<void> => {
  const paymentId = str(data.payment_id);
  const patch: Parameters<FulfillmentStore['updateOrder']>[1] = { updated_at: at };
  if (paymentId && order.payment_id !== paymentId) patch.payment_id = paymentId;
  if (businessId && !order.business_id) patch.business_id = businessId;
  const total = num(data.total_amount);
  const currency = str(data.currency);
  if (total !== null && total >= 0) patch.total_amount = total;
  if (currency) patch.currency = currency;
  await store.updateOrder(order.session_id, patch);
};

/**
 * Recover a missing order from verified webhook metadata. Credits come from
 * the server-side catalog keyed by the metadata product id; amounts are taken
 * from the payment payload. Used when checkout finalization crashed after the
 * upstream session was created, or when the webhook arrived before our row.
 * Returns null when the payload cannot be trusted into an order.
 */
const recoverOrder = async (store: FulfillmentStore, data: Record<string, unknown>, businessId: string | null, ctx: FulfillmentContext, at: number): Promise<DodoOrder | null> => {
  const meta = metadata(data);
  const accountId = str(meta.account_id);
  const sessionId = str(data.checkout_session_id) ?? str(meta.checkout_session_id);
  const productId = str(meta.product_id);
  const paymentId = str(data.payment_id);
  if (!accountId || !sessionId || !productId || !paymentId) return null;
  const credits = ctx.catalog(productId);
  if (!credits) return null;
  const order: DodoOrder = {
    session_id: sessionId,
    account_id: accountId,
    payment_id: paymentId,
    business_id: businessId,
    status: 'created',
    product_id: productId,
    credits,
    total_amount: num(data.total_amount),
    currency: str(data.currency),
    quarantine_reason: null,
    created_at: at,
    updated_at: at,
  };
  try {
    await store.createOrder(order);
    return order;
  } catch {
    // Lost a race with another recovery path; re-read.
    return (await store.findOrderBySession(sessionId)) ?? null;
  }
};

/**
 * The settled payment must match the configured business/product/currency/
 * amount before any grant. Returns a violation string or null.
 */
const grantViolation = (order: DodoOrder, data: Record<string, unknown>, businessId: string | null, expected: ExpectedContext): string | null => {
  if (expected.businessId) {
    // STRICT: the VERIFIED PAYLOAD's business must match exactly. A missing
    // business never passes, and the order's own business_id (set from our
    // configuration at checkout time) is never used to satisfy the check.
    if (businessId !== expected.businessId) return `business_mismatch:${businessId ?? 'missing'}`;
  }
  if (expected.productId && order.product_id !== expected.productId) return `product_mismatch:${order.product_id}`;
  const currency = str(data.currency) ?? order.currency;
  if (currency !== expected.currency) return `currency_mismatch:${currency ?? 'missing'}`;
  const total = num(data.total_amount) ?? order.total_amount;
  if (total !== expected.amountMinor) return `amount_mismatch:${total ?? 'missing'}`;
  return null;
};

/**
 * Cumulative refund target in credits for a payment: the proportional share of
 * the pack covered by succeeded refunds, capped at the pack size. Falls back to
 * the full pack when amounts are unknown (conservative: a refund of unknown
 * size is treated as full).
 */
const refundTargetCredits = async (store: FulfillmentStore, order: DodoOrder, paymentId: string): Promise<number> => {
  // Unknown amounts, unknown order totals, or a missing order currency are all
  // treated as a FULL refund (conservative). Refunds in a different currency
  // than the order are excluded from the math (conflict-flagged instead).
  if (!order.total_amount || order.total_amount <= 0 || !order.currency) return order.credits;
  const { total: refunded, hasUnknown } = await store.refundedAmount(paymentId, order.currency);
  if (hasUnknown || refunded >= order.total_amount) return order.credits;
  return Math.min(order.credits, Math.floor((order.credits * refunded) / order.total_amount));
};

/**
 * Target computation for a running refunded total (grant-time settling).
 * Same conservative rules as refundTargetCredits.
 */
const targetFromRunning = (order: DodoOrder, runningRefunded: number, unknown: boolean): number => {
  if (unknown || !order.total_amount || order.total_amount <= 0 || !order.currency) return order.credits;
  if (runningRefunded >= order.total_amount) return order.credits;
  return Math.min(order.credits, Math.floor((order.credits * runningRefunded) / order.total_amount));
};

/**
 * Grant-time settling of refunds recorded BEFORE the grant landed
 * (out-of-order delivery). The grant itself is always full; each recorded
 * succeeded refund then revokes its progressive share via its own ledger
 * reference (exactly-once, upgrading any 0-delta suppression marker), so the
 * net entitlement is credits minus the cumulative refund target - not a
 * blanket zero. Cross-currency records are skipped (conflict-flagged).
 * Returns the settled target in credits.
 */
const settleRecordedRefunds = async (store: FulfillmentStore, order: DodoOrder, paymentId: string, at: number): Promise<number> => {
  let running = 0;
  let unknown = false;
  let prevTarget = 0;
  for (const refund of await store.succeededRefunds(paymentId)) {
    if (refund.currency && order.currency && refund.currency !== order.currency) continue; // conflict-flagged elsewhere
    if (refund.amount_minor === null || !refund.currency) unknown = true;
    else running += refund.amount_minor;
    const target = targetFromRunning(order, running, unknown);
    const share = Math.max(0, target - prevTarget);
    const ref = refundRevokeRef(paymentId, refund.refund_id);
    if (share > 0) await store.applyDeltaOverMarker(ref, order.account_id, paymentId, -share, 'refund.succeeded', at);
    else await store.applyMarker(ref, order.account_id, paymentId, 'refund.succeeded', at);
    prevTarget = target;
  }
  return prevTarget;
};

export const fulfillDodoEvent = async (
  store: FulfillmentStore,
  event: DodoWebhookEvent,
  ctx: FulfillmentContext,
  at: number = Date.now(),
): Promise<FulfillmentOutcome> => {
  const type = str(event.type) ?? '';
  const data = event.data ?? {};
  const paymentId = str(data.payment_id);

  switch (type) {
    case 'payment.succeeded': {
      if (!paymentId) return { action: 'no_order', paymentId: null };
      // Dodo carries business_id at the event top level (not inside data).
      const businessId = str(event.business_id) ?? str(data.business_id);
      return withPaymentLock(store, paymentId, async () => {
        let order = await findOrder(store, data);
        let recovered = false;
        if (!order) {
          order = await recoverOrder(store, data, businessId, ctx, at);
          recovered = !!order;
        }
        if (!order) return { action: 'no_order', paymentId } as FulfillmentOutcome;
        await linkPayment(store, order, data, businessId, at);
        // linkPayment mutated the row: work from the refreshed order so the
        // grant gate and refund settling see the linked amounts/currency.
        order = (await store.findOrderBySession(order.session_id)) ?? order;
        // Contested money: a dispute that has not been resolved suppresses the
        // grant TEMPORARILY. dispute.won/cancelled runs the net-grant below.
        if ((await store.hasLedger(disputeRevokeRef(paymentId))) && !(await store.hasLedger(disputeRegrantRef(paymentId)))) {
          await store.updateOrder(order.session_id, { status: 'succeeded', updated_at: at });
          return { action: 'grant_suppressed', order, reason: 'dispute_pending' };
        }
        // Expected-context gate: wrong business/product/currency/amount -> quarantine, no grant.
        const violation = grantViolation(order, data, businessId, ctx.expected);
        if (violation) {
          await store.updateOrder(order.session_id, { status: 'quarantined', quarantine_reason: violation, updated_at: at });
          await store.applyMarker(quarantineRef(paymentId), order.account_id, paymentId, `payment.succeeded:${violation}`, at);
          return { action: 'quarantined', order, reason: violation };
        }
        // Grant in FULL, then settle any refunds recorded before the grant so
        // the net entitlement is credits minus the cumulative refund target.
        const applied = await store.applyLedgerDelta(grantRef(paymentId), order.account_id, paymentId, order.credits, 'payment.succeeded', at);
        if (applied === 'duplicate') return { action: 'grant_suppressed', order, reason: 'already_granted' };
        const settled = await settleRecordedRefunds(store, order, paymentId, at);
        const status = settled >= order.credits ? 'refunded' : settled > 0 ? 'partially_refunded' : 'succeeded';
        await store.updateOrder(order.session_id, { status, updated_at: at });
        return recovered ? { action: 'order_recovered', order } : { action: 'granted', order, credits: order.credits - settled };
      });
    }

    case 'payment.failed':
    case 'payment.cancelled': {
      const order = await findOrder(store, data);
      if (order && order.status === 'created') {
        await linkPayment(store, order, data, str(event.business_id) ?? str(data.business_id), at);
        await store.updateOrder(order.session_id, { status: type === 'payment.failed' ? 'failed' : 'cancelled', updated_at: at });
      }
      return { action: 'status_only', status: type };
    }

    case 'refund.succeeded':
    case 'refund.failed': {
      const refundId = str(data.refund_id);
      if (!paymentId || !refundId) return { action: 'no_order', paymentId };
      const status = type === 'refund.succeeded' ? 'succeeded' : 'failed';
      const recorded = await store.recordRefund({
        refund_id: refundId,
        payment_id: paymentId,
        amount_minor: num(data.amount),
        currency: str(data.currency),
        status,
        created_at: at,
      });
      if (recorded === 'conflict') {
        // A refund_id whose payment/amount/currency disagrees with the
        // recorded identity: never overwrite the financial record, never run
        // entitlement math on conflicting data. Flag for reconciliation.
        await store.applyMarker(`refund_conflict:${paymentId}:${refundId}`, UNMATCHED_SUBJECT, paymentId, `${type}:identity_conflict`, at);
        return { action: 'status_only', status: 'refund_conflict' };
      }
      if (status === 'failed') return { action: 'status_only', status: 'refund_failed' };

      return withPaymentLock(store, paymentId, async () => {
        const order = await findOrder(store, data);
        const ref = refundRevokeRef(paymentId, refundId);
        if (!order) {
          // Unknown order: record a 0-delta suppression marker so a late grant
          // settles this refund's share instead of ever over-granting.
          await store.applyMarker(ref, UNMATCHED_SUBJECT, paymentId, type, at);
          return { action: 'no_order', paymentId } as FulfillmentOutcome;
        }
        // Currency must match the order before any entitlement math. A
        // mismatched currency is flagged and excluded (never converted);
        // a missing currency is treated as an unknown amount (conservative).
        const refundCurrency = str(data.currency);
        if (refundCurrency && order.currency && refundCurrency !== order.currency) {
          await store.applyMarker(`refund_currency:${paymentId}:${refundId}`, UNMATCHED_SUBJECT, paymentId, `${type}:currency_mismatch:${refundCurrency}`, at);
          return { action: 'status_only', status: 'refund_currency_mismatch' };
        }
        const target = await refundTargetCredits(store, order, paymentId);
        const sums = await store.paymentSums(paymentId);
        const outstanding = Math.max(0, sums.granted - sums.revoked);
        const revokeNow = Math.min(Math.max(0, target - sums.refund_revoked), outstanding);
        if (revokeNow > 0) {
          await store.applyLedgerDelta(ref, order.account_id, paymentId, -revokeNow, type, at);
        } else {
          // Nothing (more) to revoke, but keep the per-refund marker: it makes
          // this exact transition exactly-once and suppresses late grants.
          await store.applyMarker(ref, order.account_id, paymentId, type, at);
        }
        const refundedAll = target >= order.credits;
        await store.updateOrder(order.session_id, { status: refundedAll ? 'refunded' : 'partially_refunded', updated_at: at });
        return revokeNow > 0
          ? { action: 'revoked', order, credits: revokeNow, cause: 'refund' }
          : { action: 'status_only', status: 'refund_recorded' };
      });
    }

    case 'dispute.opened':
    case 'dispute.challenged':
    case 'dispute.accepted':
    case 'dispute.expired':
    case 'dispute.lost': {
      if (!paymentId) return { action: 'no_order', paymentId: null };
      return withPaymentLock(store, paymentId, async () => {
        const order = await findOrder(store, data);
        const recorded = await recordDisputeEvent(store, data, paymentId, type, order?.account_id ?? UNMATCHED_SUBJECT, at);
        if (recorded !== 'ok') return { action: 'status_only', status: recorded };
        // dispute.challenged is record-only: the merchant's response does not
        // move money by itself.
        if (type === 'dispute.challenged') return { action: 'status_only', status: 'dispute_recorded' };
        const ref = disputeRevokeRef(paymentId);
        if (!order) {
          await store.applyMarker(ref, UNMATCHED_SUBJECT, paymentId, type, at);
          return { action: 'no_order', paymentId } as FulfillmentOutcome;
        }
        // ENTITLEMENT LIABILITY decides the request (what this payment still
        // owes); the ledger records only the BALANCE MOVEMENT that was
        // atomically removable from the live shared balance (see store).
        const sums = await store.paymentSums(paymentId);
        const outstanding = Math.max(0, sums.granted - sums.revoked);
        if (outstanding > 0) {
          await store.applyLedgerDelta(ref, order.account_id, paymentId, -outstanding, type, at);
        } else {
          await store.applyMarker(ref, order.account_id, paymentId, type, at);
        }
        await store.updateOrder(order.session_id, { status: 'disputed', updated_at: at });
        return { action: 'revoked', order, credits: outstanding, cause: 'dispute' };
      });
    }

    case 'dispute.won':
    case 'dispute.cancelled': {
      if (!paymentId) return { action: 'no_order', paymentId: null };
      return withPaymentLock(store, paymentId, async () => {
        let order = await findOrder(store, data);
        const recorded = await recordDisputeEvent(store, data, paymentId, type, order?.account_id ?? UNMATCHED_SUBJECT, at);
        if (recorded !== 'ok') return { action: 'status_only', status: recorded };
        if (!order) return { action: 'no_order', paymentId } as FulfillmentOutcome;
        const businessId = str(event.business_id) ?? str(data.business_id);
        // The dispute is resolved. If the grant was suppressed while the
        // dispute was pending, run the same gated net-grant a late
        // payment.succeeded would: the buyer won, so the entitlement lands
        // (minus any refunds that settled meanwhile).
        if (!(await store.hasLedger(grantRef(paymentId)))) {
          const violation = grantViolation(order, data, businessId, ctx.expected);
          if (violation) {
            await store.updateOrder(order.session_id, { status: 'quarantined', quarantine_reason: violation, updated_at: at });
            await store.applyMarker(quarantineRef(paymentId), order.account_id, paymentId, `${type}:${violation}`, at);
            return { action: 'quarantined', order, reason: violation };
          }
          const applied = await store.applyLedgerDelta(grantRef(paymentId), order.account_id, paymentId, order.credits, 'payment.succeeded', at);
          if (applied === 'applied') {
            const settled = await settleRecordedRefunds(store, order, paymentId, at);
            await store.applyMarker(disputeRegrantRef(paymentId), order.account_id, paymentId, type, at);
            const status = settled >= order.credits ? 'refunded' : settled > 0 ? 'partially_refunded' : 'succeeded';
            await store.updateOrder(order.session_id, { status, updated_at: at });
            return { action: 'regranted', order, credits: order.credits - settled };
          }
        }
        const sums = await store.paymentSums(paymentId);
        if (sums.dispute_revoked <= 0 && !(await store.hasLedger(disputeRevokeRef(paymentId)))) {
          return { action: 'status_only', status: `${type}_nothing_to_restore` };
        }
        // A refund always beats a dispute win: restore only what the dispute
        // took minus the credits that refunds settled meanwhile (including
        // refunds that found nothing left to revoke during the dispute).
        const refundTarget = await refundTargetCredits(store, order, paymentId);
        const settledByRefunds = Math.max(0, refundTarget - sums.refund_revoked);
        const restore = Math.min(Math.max(0, sums.dispute_revoked - settledByRefunds), sums.revoked);
        if (restore <= 0) {
          await store.applyMarker(disputeRegrantRef(paymentId), order.account_id, paymentId, type, at);
          const status = refundTarget >= order.credits ? 'refunded' : refundTarget > 0 ? 'partially_refunded' : 'succeeded';
          await store.updateOrder(order.session_id, { status, updated_at: at });
          return { action: 'status_only', status: `${type}_but_refunded` };
        }
        const applied = await store.applyLedgerDelta(disputeRegrantRef(paymentId), order.account_id, paymentId, restore, type, at);
        if (applied === 'duplicate') return { action: 'status_only', status: 'regrant_already_applied' };
        await store.updateOrder(order.session_id, { status: 'succeeded', updated_at: at });
        return { action: 'regranted', order, credits: restore };
      });
    }

    default:
      // Unsubscribed or irrelevant event families (subscriptions, license keys,
      // payouts, ...). Acknowledge so dashboard test sends do not error-loop.
      return { action: 'ignored', type };
  }
};
