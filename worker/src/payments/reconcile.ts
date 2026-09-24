/**
 * Reconciliation job: compare our orders/ledger/inbox against Dodo's own
 * records and recover what webhooks alone cannot guarantee.
 *
 * Recovery paths:
 *   1. Upstream payment exists but we have no order row (checkout finalize
 *      crashed): the order is rebuilt from the persisted checkout intent and
 *      server-side catalog, then fulfilled through the normal pipeline.
 *   2. Orphaned checkout intents: a 'pending' intent whose upstream session
 *      was created but never finalized locally is matched to payments by the
 *      correlation metadata we sent (intent_key). Matched intents are
 *      recovered; unmatched ones are escalated to needs_reconciliation
 *      (manual) and reported as drift on every run. Nothing is auto-abandoned
 *      anymore: a pending intent may hide a payable upstream session. (Dodo documents no
 *      checkout idempotency key, so this metadata match is the mechanism.)
 *   3. Refund/dispute events we never saw: replayed as synthetic events
 *      through the same fulfillment code (exactly-once references make this
 *      safe to run repeatedly).
 *   4. Inbox deliveries stuck in 'failed' OR stale 'processing' (crashed
 *      attempts, not only terminal failures): re-claimed under a fresh lease
 *      and re-fulfilled from their stored, verified MINIMIZED payloads.
 *   5. Ledger deltas whose balance write never landed (crash between the
 *      ledger insert and the balance batch): re-applied once, flagged.
 *
 * Housekeeping: quarantined orders are surfaced for a human decision; old
 * completed/failed inbox rows are pruned (completed 7d, failed 30d).
 *
 * Every list read reports TRUNCATION: when Dodo's page cap is hit, the report
 * names the incomplete source instead of silently reconciling a partial view.
 *
 * Triggered via POST /v1/admin/dodo/reconcile (Bearer DODO_ADMIN_KEY).
 */

import { packByProduct, packByKey } from './catalog';
import { D1FulfillmentStore, FulfillmentStore } from './store';
import { fulfillDodoEvent, withPaymentLock, CREDITS_PER_PURCHASE, PRODUCT_PRICE_MINOR, PRODUCT_CURRENCY, DodoWebhookEvent, ProductCatalog, ExpectedContext, LockUnavailable } from './fulfillment';
import { listPayments, listRefunds, listDisputes, DodoApiError, DodoPaymentSummary } from './dodo-client';

export interface ReconcileEnv {
  DB: D1Database;
  DODO_API_KEY?: string;
  DODO_API_BASE?: string;
  DODO_PRODUCT_ID?: string;
  DODO_PRODUCT_ID_LARGE?: string;
  DODO_BUSINESS_ID?: string;
}

export interface ReconcileReport {
  checked_at: number;
  mode: 'test' | 'live' | 'unknown';
  upstream: { payments: number; refunds: number; disputes: number } | 'not_configured';
  truncated: string[]; // list sources that hit the page cap: reconcile result is incomplete
  orders_recovered: number;
  intents_recovered: number;
  intents_needs_reconciliation: number;
  events_replayed: number;
  deliveries_retried: number;
  stale_claims: number; // deliveries stuck in 'processing' (crashed attempts) that were re-claimed
  balance_repairs: number; // ledger deltas whose balance write was re-applied
  quarantined: string[]; // payment ids quarantined by the expected-context gate (human decision needed)
  retention: { completed: number; failed: number }; // inbox rows pruned
  drift: string[];
}

const ORPHAN_INTENT_STALE_MS = 600_000; // a pending intent older than this is swept
const COMPLETED_RETENTION_MS = 7 * 86_400_000; // completed inbox rows pruned after 7d
const FAILED_RETENTION_MS = 30 * 86_400_000; // failed inbox rows pruned after 30d
const INBOX_STALE_MS = 60_000;

const catalog = (env: ReconcileEnv): ProductCatalog => (productId: string) => packByProduct(env, productId)?.credits ?? null;

const expected = (env: ReconcileEnv): ExpectedContext => ({
  businessId: env.DODO_BUSINESS_ID || undefined,
  productId: env.DODO_PRODUCT_ID || undefined,
  currency: PRODUCT_CURRENCY,
  amountMinor: PRODUCT_PRICE_MINOR,
  amountFor: (productId: string) => packByProduct(env, productId)?.amountMinor ?? null,
});

/** Re-fulfill a stored/synthetic event through the normal pipeline. */
const replay = async (store: FulfillmentStore, env: ReconcileEnv, event: DodoWebhookEvent, at: number): Promise<string> => {
  const outcome = await fulfillDodoEvent(store, event, { catalog: catalog(env), expected: expected(env) }, at);
  return outcome.action;
};

export const runReconciliation = async (env: ReconcileEnv, fetchImpl: typeof fetch = fetch): Promise<ReconcileReport> => {
  const at = Date.now();
  const store = new D1FulfillmentStore(env.DB);
  const report: ReconcileReport = {
    checked_at: at,
    mode: env.DODO_API_BASE?.includes('test.dodopayments.com') ? 'test' : env.DODO_API_BASE?.includes('live.dodopayments.com') ? 'live' : 'unknown',
    upstream: 'not_configured',
    truncated: [],
    orders_recovered: 0,
    intents_recovered: 0,
    intents_needs_reconciliation: 0,
    events_replayed: 0,
    deliveries_retried: 0,
    stale_claims: 0,
    balance_repairs: 0,
    quarantined: [],
    retention: { completed: 0, failed: 0 },
    drift: [],
  };

  // Local-only housekeeping runs even without upstream credentials.
  const quarantined = await store.listOrdersByStatus('quarantined', 100);
  report.quarantined = quarantined.map((o) => o.payment_id ?? o.session_id);

  for (const pending of await store.pendingBalanceDeltas(100)) {
    // Serialized per payment: a concurrent reconciler working the same delta
    // contends on the same lock; the loser surfaces as drift and the next run
    // completes the repair. Truly simultaneous reappliers can never both
    // apply: the balance write + applied flag are one atomic batch inside the
    // lock, and the loser's re-read observes the winner's flag.
    if (!pending.payment_id) {
      report.drift.push(`balance_repair_no_payment:${pending.reference}`);
      continue;
    }
    try {
      // reapplyLedgerDelta re-reads balance_applied inside the lock: a loser
      // of a reconcile race observes the winner's flag and applies nothing.
      const repaired = await withPaymentLock(store, pending.payment_id, () => store.reapplyLedgerDelta(pending.reference, at));
      if (repaired) {
        report.balance_repairs++;
        report.drift.push(`balance_repair:${pending.reference}`);
      }
    } catch (err) {
      report.drift.push(`balance_repair_blocked:${pending.reference}:${err instanceof LockUnavailable ? 'lock_contended' : 'error'}`);
    }
  }

  // Conflict-flagged refunds surface every run until a human resolves them.
  for (const ref of await store.listLedgerReferences('refund_conflict:', 100)) report.drift.push(ref);
  for (const ref of await store.listLedgerReferences('refund_currency:', 100)) report.drift.push(ref);
  for (const ref of await store.listLedgerReferences('dispute_conflict:', 100)) report.drift.push(ref);
  for (const ref of await store.listLedgerReferences('dispute_transition:', 100)) report.drift.push(ref);

  // Retention first: anything old enough to prune is not worth retrying.
  report.retention = await store.pruneDeliveries(at - COMPLETED_RETENTION_MS, at - FAILED_RETENTION_MS);

  // Unfinished inbox deliveries: failed AND stale 'processing' rows (crashed
  // attempts), re-claimed under a fresh lease and replayed from the stored
  // minimized payload. Completed rows carry no payload and are acked already.
  for (const delivery of await store.listDeliveries(['failed', 'processing'], 100)) {
    if (!delivery.payload) {
      report.drift.push(`delivery_without_payload:${delivery.webhook_id}`);
      continue;
    }
    const claim = await store.claimDelivery(delivery.webhook_id, delivery.provider, delivery.event_type, delivery.payload, at, INBOX_STALE_MS);
    if (!claim.deliver) continue; // live owner or already completed
    if (delivery.status === 'processing') report.stale_claims++;
    try {
      const event = JSON.parse(delivery.payload) as DodoWebhookEvent;
      const outcome = await fulfillDodoEvent(store, event, { catalog: catalog(env), expected: expected(env) });
      await store.completeDelivery(delivery.webhook_id, claim.token, outcome.action, Date.now());
      report.deliveries_retried++;
    } catch (err) {
      const message = err instanceof LockUnavailable ? err.message : err instanceof Error ? err.message.slice(0, 300) : 'unknown';
      await store.failDelivery(delivery.webhook_id, claim.token, message, Date.now());
      report.drift.push(`delivery_still_failing:${delivery.webhook_id}`);
    }
  }

  if (!env.DODO_API_KEY || !env.DODO_API_BASE) return report;

  const [payments, refunds, disputes] = await Promise.all([
    listPayments(env.DODO_API_BASE, env.DODO_API_KEY, fetchImpl),
    listRefunds(env.DODO_API_BASE, env.DODO_API_KEY, fetchImpl),
    listDisputes(env.DODO_API_BASE, env.DODO_API_KEY, fetchImpl),
  ]);
  report.upstream = { payments: payments.items.length, refunds: refunds.items.length, disputes: disputes.items.length };
  if (payments.truncated) report.truncated.push('payments');
  if (refunds.truncated) report.truncated.push('refunds');
  if (disputes.truncated) report.truncated.push('disputes');

  // 1. Payments upstream vs our orders.
  for (const payment of payments.items) {
    const paymentId = payment.payment_id;
    if (!paymentId) continue;
    let order = await store.findOrderByPayment(paymentId);
    if (!order && payment.checkout_session_id) order = await store.findOrderBySession(payment.checkout_session_id);
    if (!order) {
      // Recover from the persisted checkout intent (metadata carries it).
      const intentKey = typeof payment.metadata?.intent_key === 'string' ? payment.metadata.intent_key : null;
      const intent = intentKey ? await store.findIntent(intentKey) : null;
      if (intent) {
        try {
          await store.createOrder({
            session_id: intent.session_id ?? `recovered:${paymentId}`,
            account_id: intent.account_id,
            payment_id: paymentId,
            business_id: payment.business_id ?? null, // never backfill from our own config: the grant gate requires the UPSTREAM business
            status: 'created',
            product_id: intent.product_id,
            credits: intent.credits,
            total_amount: payment.total_amount ?? null,
            currency: payment.currency ?? null,
            quarantine_reason: null,
            created_at: at,
            updated_at: at,
          });
          await store.updateIntent(intent.intent_key, { status: intent.status === 'pending' ? 'recovered' : intent.status, payment_id: paymentId, error: null, updated_at: at });
          report.orders_recovered++;
        } catch {
          report.drift.push(`order_recovery_failed:${paymentId}`);
          continue;
        }
      } else {
        report.drift.push(`unknown_payment:${paymentId}`);
        continue;
      }
    }
    // Succeeded upstream but no grant here: replay through fulfillment (the
    // expected-context gate still applies: a mismatched payment quarantines).
    if (payment.status === 'succeeded') {
      const sums = await store.paymentSums(paymentId);
      if (sums.granted <= 0) {
        try {
          // Business provenance for replays: Dodo's list API omits business_id,
          // but the list is authenticated to OUR business by our API key and
          // every candidate is bound to a persisted intent or existing order.
          // Webhook deliveries are gated strictly on the payload instead (the
          // misrouting surface). The order RECORD itself never backfills.
          const action = await replay(store, env, { type: 'payment.succeeded', business_id: payment.business_id ?? env.DODO_BUSINESS_ID, data: payment as Record<string, unknown> }, at);
          report.events_replayed++;
          if (action === 'no_order' || action === 'ignored') report.drift.push(`grant_replay_failed:${paymentId}:${action}`);
          if (action === 'quarantined') report.drift.push(`quarantined_on_replay:${paymentId}`);
        } catch (err) {
          report.drift.push(`grant_replay_error:${paymentId}:${err instanceof LockUnavailable ? 'lock_contended' : 'error'}`);
        }
      }
      const refreshed = await store.findOrderByPayment(paymentId);
      if (refreshed && refreshed.status === 'created') {
        report.drift.push(`status_drift:${paymentId}:local=created,upstream=succeeded`);
        await store.updateOrder(refreshed.session_id, { status: 'succeeded', updated_at: at });
      }
    }
  }

  // 2. Orphaned checkout intents: pending and stale. Dodo documents no
  // checkout idempotency key, so the correlation metadata sent at session
  // creation (intent_key) is matched against the payments list.
  for (const intent of [
    ...(await store.listIntents('pending', at - ORPHAN_INTENT_STALE_MS, 100)),
    ...(await store.listIntents('needs_reconciliation', at + 1, 100)), // ALL of them: these are unresolved ambiguities, matched and re-reported every run
  ]) {
    const match = payments.items.find((p: DodoPaymentSummary) => p.metadata?.intent_key === intent.intent_key);
    if (match?.payment_id) {
      try {
        const existing = await store.findOrderByPayment(match.payment_id);
        if (!existing) {
          await store.createOrder({
            session_id: intent.session_id ?? `recovered:${match.payment_id}`,
            account_id: intent.account_id,
            payment_id: match.payment_id,
            business_id: match.business_id ?? env.DODO_BUSINESS_ID ?? null,
            status: 'created',
            product_id: intent.product_id,
            credits: intent.credits,
            total_amount: match.total_amount ?? null,
            currency: match.currency ?? null,
            quarantine_reason: null,
            created_at: at,
            updated_at: at,
          });
        }
        await store.updateIntent(intent.intent_key, { status: 'recovered', payment_id: match.payment_id, error: null, updated_at: at });
        report.intents_recovered++;
        if (match.status === 'succeeded') {
          // Same provenance rule as order recovery above: the list payload
          // omits business_id, so a strict payload-only gate would quarantine
          // every legitimate recovery. Fall back to our configured business.
          const action = await replay(store, env, { type: 'payment.succeeded', business_id: match.business_id ?? env.DODO_BUSINESS_ID, data: match as Record<string, unknown> }, at);
          report.events_replayed++;
          if (action === 'no_order' || action === 'ignored') report.drift.push(`recovered_grant_failed:${match.payment_id}:${action}`);
        }
      } catch {
        report.drift.push(`intent_recovery_failed:${intent.intent_key}`);
      }
      continue;
    }
    if (intent.error === 'finalize_failed') {
      // The session exists upstream but no payment matched and we never stored
      // its id: nothing further is recoverable locally; a human should check.
      report.drift.push(`finalize_orphan:${intent.intent_key}`);
    } else {
      // Unmatched and ambiguous: escalate pending intents to
      // needs_reconciliation (the route does the same for stale ones) and
      // ALWAYS surface the key as drift so ops sees it on every run. Never
      // auto-abandon: the intent may correspond to a payable upstream session
      // created during a timeout/crash that Dodo cannot look up for us.
      if (intent.status === 'pending') {
        await store.updateIntent(intent.intent_key, { status: 'needs_reconciliation', error: intent.error ?? 'unmatched_stale', updated_at: at });
        report.intents_needs_reconciliation++;
      }
      report.drift.push(`intent_needs_reconciliation:${intent.intent_key}`);
    }
  }

  // 3. Refunds upstream vs our records: replay anything not yet applied.
  for (const refund of refunds.items) {
    if (!refund.refund_id || !refund.payment_id) continue;
    const ref = `revoke:refund:${refund.payment_id}:${refund.refund_id}`;
    if (refund.status === 'succeeded' && !(await store.hasLedger(ref))) {
      try {
        const action = await replay(store, env, { type: 'refund.succeeded', data: refund as Record<string, unknown> }, at);
        report.events_replayed++;
        if (action === 'no_order') report.drift.push(`refund_without_order:${refund.refund_id}`);
      } catch (err) {
        report.drift.push(`refund_replay_error:${refund.refund_id}:${err instanceof LockUnavailable ? 'lock_contended' : 'error'}`);
      }
    }
  }

  // 4. Disputes upstream vs our records.
  for (const dispute of disputes.items) {
    if (!dispute.payment_id) continue;
    const status = dispute.dispute_status || '';
    const mapped =
      status === 'dispute_opened' || status === 'opened' ? 'dispute.opened'
      : status === 'dispute_accepted' || status === 'accepted' ? 'dispute.accepted'
      : status === 'dispute_won' || status === 'won' ? 'dispute.won'
      : status === 'dispute_lost' || status === 'lost' ? 'dispute.lost'
      : status === 'dispute_cancelled' || status === 'cancelled' ? 'dispute.cancelled'
      : status === 'dispute_expired' || status === 'expired' ? 'dispute.expired'
      : null;
    if (!mapped) continue;
    const isRevoke = mapped !== 'dispute.won' && mapped !== 'dispute.cancelled';
    const ref = isRevoke ? `revoke:dispute:${dispute.payment_id}` : `regrant:dispute:${dispute.payment_id}`;
    if (!(await store.hasLedger(ref))) {
      try {
        await replay(store, env, { type: mapped, data: dispute as Record<string, unknown> }, at);
        report.events_replayed++;
      } catch (err) {
        report.drift.push(`dispute_replay_error:${dispute.payment_id}:${err instanceof LockUnavailable ? 'lock_contended' : 'error'}`);
      }
    }
  }

  return report;
};

export { DodoApiError };
