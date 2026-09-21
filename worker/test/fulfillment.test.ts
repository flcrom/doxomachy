import { describe, it, expect, beforeEach } from 'vitest';
import { D1FulfillmentStore } from '../src/payments/store';
import { fulfillDodoEvent, FulfillmentContext } from '../src/payments/fulfillment';
import { FakeD1, TEST_ACCOUNT, TEST_BUSINESS, fixture, seedOrder } from './helpers';

let store: D1FulfillmentStore;
const ctx: FulfillmentContext = {
  catalog: (pid) => (pid === 'pdt_test_5pack' ? 5 : null),
  expected: { businessId: TEST_BUSINESS, productId: 'pdt_test_5pack', currency: 'USD', amountMinor: 500 },
};

beforeEach(async () => {
  store = new D1FulfillmentStore(new FakeD1() as unknown as D1Database);
  await seedOrder(store);
});

const deliver = (name: string, mutate?: (e: any) => any) => {
  const { event } = fixture(name);
  return fulfillDodoEvent(store, mutate ? mutate(event) : event, ctx);
};

describe('payment.succeeded', () => {
  it('grants the pack exactly once per payment', async () => {
    expect((await deliver('payment-succeeded.json')).action).toBe('granted');
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    const again = await deliver('payment-succeeded.json');
    expect(again).toMatchObject({ action: 'grant_suppressed', reason: 'already_granted' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('recovers a missing order from verified metadata using the server-side catalog', async () => {
    store = new D1FulfillmentStore(new FakeD1() as unknown as D1Database); // no seeded order
    const outcome = await deliver('payment-succeeded.json');
    expect(outcome.action).toBe('order_recovered');
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    const order = await store.findOrderByPayment('pay_test_5pack');
    expect(order).toMatchObject({ account_id: TEST_ACCOUNT, credits: 5, status: 'succeeded', total_amount: 500 });
  });

  it('refuses recovery when metadata has no account linkage', async () => {
    store = new D1FulfillmentStore(new FakeD1() as unknown as D1Database);
    const outcome = await deliver('payment-succeeded.json', (e) => ((e.data.metadata = {}), e));
    expect(outcome.action).toBe('no_order');
  });

  it('marks payment.failed only while unpaid', async () => {
    const atSeededOrder = (e: any) => ((e.data.checkout_session_id = 'cs_test_5pack'), (e.data.payment_id = 'pay_test_5pack'), e);
    expect((await deliver('payment-failed.json', atSeededOrder)).action).toBe('status_only');
    expect((await store.findOrderBySession('cs_test_5pack'))?.status).toBe('failed');
    // out of order: a failure arriving after success must not regress the order
    await deliver('payment-succeeded.json');
    await deliver('payment-failed.json', atSeededOrder);
    expect((await store.findOrderBySession('cs_test_5pack'))?.status).toBe('succeeded');
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('two concurrent deliveries of the same payment grant exactly once', async () => {
    const [a, b] = await Promise.all([deliver('payment-succeeded.json'), deliver('payment-succeeded.json')]);
    expect([a.action, b.action].sort()).toEqual(['grant_suppressed', 'granted']);
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    const sums = await store.paymentSums('pay_test_5pack');
    expect(sums.granted).toBe(5);
  });
});

describe('expected-context gate (quarantine)', () => {
  it('quarantines a currency mismatch before any grant', async () => {
    const outcome = await deliver('payment-succeeded.json', (e) => ((e.data.currency = 'EUR'), e));
    expect(outcome).toMatchObject({ action: 'quarantined', reason: 'currency_mismatch:EUR' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    const order = await store.findOrderBySession('cs_test_5pack');
    expect(order).toMatchObject({ status: 'quarantined', quarantine_reason: 'currency_mismatch:EUR' });
    // a redelivery of the same mismatched payment never grants
    const again = await deliver('payment-succeeded.json', (e) => ((e.data.currency = 'EUR'), e));
    expect(again.action).toBe('quarantined');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('quarantines an amount mismatch before any grant', async () => {
    const outcome = await deliver('payment-succeeded.json', (e) => ((e.data.total_amount = 499), e));
    expect(outcome).toMatchObject({ action: 'quarantined', reason: 'amount_mismatch:499' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('quarantines a business mismatch before any grant', async () => {
    const outcome = await deliver('payment-succeeded.json', (e) => ((e.business_id = 'bus_someone_else'), (e.data.business_id = 'bus_someone_else'), e));
    expect(outcome).toMatchObject({ action: 'quarantined', reason: 'business_mismatch:bus_someone_else' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('quarantines a missing amount/currency rather than guessing', async () => {
    const outcome = await deliver('payment-succeeded.json', (e) => (delete e.data.total_amount, delete e.data.currency, e));
    expect(outcome.action).toBe('quarantined');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });
});

describe('refunds', () => {
  it('full refund revokes the whole pack once', async () => {
    await deliver('payment-succeeded.json');
    const outcome = await deliver('refund-succeeded.json');
    expect(outcome).toMatchObject({ action: 'revoked', credits: 5, cause: 'refund' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    expect((await store.findOrderBySession('cs_test_5pack'))?.status).toBe('refunded');
    // duplicate refund delivery: no second revoke
    await deliver('refund-succeeded.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('partial refunds revoke proportionally and multiple refunds converge exactly', async () => {
    await deliver('payment-succeeded.json');
    // $2 of $5 refunded -> 2 of 5 credits
    expect((await deliver('refund-partial.json'))).toMatchObject({ action: 'revoked', credits: 2 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(3);
    expect((await store.findOrderBySession('cs_test_5pack'))?.status).toBe('partially_refunded');
    // remaining $3 refunded -> cumulative target 5, revoke 3 more
    const second = await deliver('refund-succeeded.json', (e) => ((e.data.refund_id = 'ref_test_rest'), (e.data.amount = 300), (e.data.is_partial = true), e));
    expect(second).toMatchObject({ action: 'revoked', credits: 3 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    // a further refund finds nothing: marker only, never negative
    const third = await deliver('refund-succeeded.json', (e) => ((e.data.refund_id = 'ref_test_extra'), (e.data.amount = 100), (e.data.is_partial = true), e));
    expect(third.action).toBe('status_only');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('two simultaneous partial refunds converge exactly under the payment lock', async () => {
    await deliver('payment-succeeded.json');
    const r1 = deliver('refund-succeeded.json', (e) => ((e.data.refund_id = 'ref_conc_1'), (e.data.amount = 200), (e.data.is_partial = true), e));
    const r2 = deliver('refund-succeeded.json', (e) => ((e.data.refund_id = 'ref_conc_2'), (e.data.amount = 300), (e.data.is_partial = true), e));
    await Promise.all([r1, r2]);
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    const sums = await store.paymentSums('pay_test_5pack');
    expect(sums.refund_revoked).toBe(5);
    expect((await store.findOrderBySession('cs_test_5pack'))?.status).toBe('refunded');
  });

  it('treats a refund of unknown amount as full (conservative)', async () => {
    await deliver('payment-succeeded.json');
    const outcome = await deliver('refund-succeeded.json', (e) => ((e.data.amount = null), e));
    expect(outcome).toMatchObject({ action: 'revoked', credits: 5 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('out of order: a FULL refund before payment.succeeded nets the late grant to exactly zero', async () => {
    await deliver('refund-succeeded.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    const late = await deliver('payment-succeeded.json');
    // Grant lands in full, the recorded refund settles its full share: net 0.
    expect(late).toMatchObject({ action: 'granted', credits: 0 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    expect((await store.findOrderByPayment('pay_test_5pack'))?.status).toBe('refunded');
  });

  it('out of order: a PARTIAL refund before payment.succeeded grants the correct NET entitlement ($2 of $5 -> 3 credits)', async () => {
    await deliver('refund-partial.json'); // $2.00 of $5.00 refunded before the grant
    const late = await deliver('payment-succeeded.json');
    expect(late).toMatchObject({ action: 'granted', credits: 3 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(3);
    expect((await store.findOrderByPayment('pay_test_5pack'))?.status).toBe('partially_refunded');
    // Redeliveries change nothing: grant and refund settle are exactly-once.
    await deliver('payment-succeeded.json');
    await deliver('refund-partial.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(3);
    // A later second partial refund ($2.00) settles cumulatively: target floor(5*400/500)=4, already revoked 2 -> revoke 2 more
    await deliver('refund-partial.json', (e) => ((e.data.refund_id = 'ref_test_partial_2'), e));
    expect(await store.balance(TEST_ACCOUNT)).toBe(1);
    // ...and a final full-total refund zeroes it
    await deliver('refund-partial.json', (e) => ((e.data.refund_id = 'ref_test_partial_3'), (e.data.amount = 100), e));
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    expect((await store.findOrderByPayment('pay_test_5pack'))?.status).toBe('refunded');
  });

  it('refund for a completely unknown payment is recorded; the late grant settles it (no over-grant)', async () => {
    store = new D1FulfillmentStore(new FakeD1() as unknown as D1Database);
    expect((await deliver('refund-succeeded.json')).action).toBe('no_order');
    const late = await deliver('payment-succeeded.json');
    expect(late.action).toBe('order_recovered');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('refund.failed records the refund but moves no credits', async () => {
    await deliver('payment-succeeded.json');
    const outcome = await deliver('refund-succeeded.json', (e) => ((e.type = 'refund.failed'), e));
    expect(outcome).toMatchObject({ action: 'status_only' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });
});

describe('disputes', () => {
  it('dispute.opened revokes the outstanding grant once per payment', async () => {
    await deliver('payment-succeeded.json');
    expect((await deliver('dispute-opened.json'))).toMatchObject({ action: 'revoked', credits: 5, cause: 'dispute' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    await deliver('dispute-lost.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('dispute.won restores what the dispute took', async () => {
    await deliver('payment-succeeded.json');
    await deliver('dispute-opened.json');
    expect((await deliver('dispute-won.json'))).toMatchObject({ action: 'regranted', credits: 5 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('dispute.cancelled restores what the dispute took', async () => {
    await deliver('payment-succeeded.json');
    await deliver('dispute-opened.json');
    const outcome = await deliver('dispute-won.json', (e) => ((e.type = 'dispute.cancelled'), e));
    expect(outcome).toMatchObject({ action: 'regranted', credits: 5 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('partial refund then dispute: dispute takes only what remains, win restores it', async () => {
    await deliver('payment-succeeded.json');
    await deliver('refund-partial.json'); // balance 3
    expect((await deliver('dispute-opened.json'))).toMatchObject({ action: 'revoked', credits: 3 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    expect((await deliver('dispute-won.json'))).toMatchObject({ action: 'regranted', credits: 3 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(3); // refunded share stays revoked
  });

  it('full refund during a dispute beats the dispute win', async () => {
    await deliver('payment-succeeded.json');
    await deliver('dispute-opened.json'); // balance 0, dispute took 5
    await deliver('refund-succeeded.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    const won = await deliver('dispute-won.json');
    expect(won).toMatchObject({ action: 'status_only', status: 'dispute.won_but_refunded' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('a simultaneous dispute win and full refund still settles at zero', async () => {
    await deliver('payment-succeeded.json');
    await deliver('dispute-opened.json'); // dispute took 5
    await Promise.all([deliver('dispute-won.json'), deliver('refund-succeeded.json')]);
    // Either interleaving converges: the refund beats the dispute win.
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    const sums = await store.paymentSums('pay_test_5pack');
    expect(sums.granted - sums.revoked).toBe(0);
  });

  it('dispute for an unknown order suppresses a late grant', async () => {
    store = new D1FulfillmentStore(new FakeD1() as unknown as D1Database);
    expect((await deliver('dispute-opened.json')).action).toBe('no_order');
    const late = await deliver('payment-succeeded.json');
    expect(late.action).toBe('grant_suppressed');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });

  it('dispute.won with nothing to restore is status-only', async () => {
    await deliver('payment-succeeded.json');
    expect((await deliver('dispute-won.json'))).toMatchObject({ action: 'status_only', status: 'dispute.won_nothing_to_restore' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });
});

describe('shared balance safety', () => {
  it('a revoke after the account already spent cannot push the balance negative', async () => {
    await deliver('payment-succeeded.json'); // balance 5
    // simulate an auth-lane spend: direct balance mutation, no ledger row
    await store.applyLedgerDelta('spend-simulation', TEST_ACCOUNT, null, -3, 'auth_lane_spend', Date.now());
    expect(await store.balance(TEST_ACCOUNT)).toBe(2);
    const outcome = await deliver('refund-succeeded.json'); // full refund: revoke 5
    expect(outcome).toMatchObject({ action: 'revoked', credits: 5 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0); // floored: 2 - 5 -> 0, never negative
  });
});

describe('other events', () => {
  it('ignores irrelevant event types cleanly', async () => {
    expect((await deliver('payment-succeeded.json', (e) => ((e.type = 'subscription.active'), e)))).toMatchObject({ action: 'ignored' });
  });
});

describe('out-of-order disputes (temporary suppression vs permanent revoke)', () => {
  it('dispute.opened before payment.succeeded suppresses the grant; dispute.won then grants the full entitlement', async () => {
    expect((await deliver('dispute-opened.json')).action).toBe('no_order'); // nothing granted yet: marker only
    const late = await deliver('payment-succeeded.json');
    expect(late).toMatchObject({ action: 'grant_suppressed', reason: 'dispute_pending' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    const won = await deliver('dispute-won.json');
    expect(won).toMatchObject({ action: 'regranted', credits: 5 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    // redelivery of the win is exactly-once
    await deliver('dispute-won.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('QA sequence: payment.succeeded -> dispute.opened -> refund.succeeded -> duplicate refund.failed -> dispute.won ends at balance 0', async () => {
    expect((await deliver('payment-succeeded.json')).action).toBe('granted');
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    expect((await deliver('dispute-opened.json')).action).toBe('revoked');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    await deliver('refund-succeeded.json'); // full refund while dispute holds everything: marker, target = full
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    // Out-of-order/duplicate refund.failed for the SAME refund_id: monotonic record must NOT downgrade
    const failed = await deliver('refund-succeeded.json', (e) => ((e.type = 'refund.failed'), e));
    expect(failed).toMatchObject({ action: 'status_only', status: 'refund_failed' });
    const won = await deliver('dispute-won.json');
    // The refund beat the dispute win: nothing is restored.
    expect(won).toMatchObject({ action: 'status_only', status: 'dispute.won_but_refunded' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    expect((await store.findOrderByPayment('pay_test_5pack'))?.status).toBe('refunded');
  });
});

describe('refund record integrity', () => {
  it('refund_id identity is immutable: a conflicting amount (200 -> 500) is rejected, never rewrites, and moves nothing', async () => {
    await deliver('payment-succeeded.json');
    await deliver('refund-partial.json'); // 200 of 500 -> revoke 2
    expect(await store.balance(TEST_ACCOUNT)).toBe(3);
    const conflict = await deliver('refund-partial.json', (e) => ((e.data.amount = 500), e)); // same refund_id, bigger amount
    expect(conflict).toMatchObject({ action: 'status_only', status: 'refund_conflict' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(3); // no extra revoke
    const row = await (store as any).db.prepare('SELECT amount_minor, status FROM dodo_refunds WHERE refund_id = ?').bind('ref_test_partial').first();
    expect(row).toMatchObject({ amount_minor: 200, status: 'succeeded' }); // original record intact
    expect(await store.hasLedger('refund_conflict:pay_test_5pack:ref_test_partial')).toBe(true);
  });

  it('refund.failed after refund.succeeded for the same refund_id does not downgrade the record', async () => {
    await deliver('payment-succeeded.json');
    await deliver('refund-partial.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(3);
    await deliver('refund-partial.json', (e) => ((e.type = 'refund.failed'), e));
    const row = await (store as any).db.prepare('SELECT status, amount_minor FROM dodo_refunds WHERE refund_id = ?').bind('ref_test_partial').first();
    expect(row).toMatchObject({ status: 'succeeded', amount_minor: 200 });
    expect(await store.balance(TEST_ACCOUNT)).toBe(3);
  });

  it('cross-currency refund: no entitlement math, conflict-flagged, balance untouched', async () => {
    await deliver('payment-succeeded.json');
    const outcome = await deliver('refund-succeeded.json', (e) => ((e.data.currency = 'EUR'), e));
    expect(outcome).toMatchObject({ action: 'status_only', status: 'refund_currency_mismatch' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    expect(await store.hasLedger('refund_currency:pay_test_5pack:ref_test_5pack')).toBe(true);
    // A later "correction" in the order's currency CONFLICTS with the recorded
    // identity (currency is immutable once recorded): flagged, never rewrites.
    const corrected = await deliver('refund-succeeded.json');
    expect(corrected).toMatchObject({ action: 'status_only', status: 'refund_conflict' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    expect(await store.hasLedger('refund_conflict:pay_test_5pack:ref_test_5pack')).toBe(true);
  });
});

describe('grant gate strictness', () => {
  it('missing business_id never passes when DODO_BUSINESS_ID is configured', async () => {
    const outcome = await deliver('payment-succeeded.json', (e) => (delete e.business_id, delete e.data.business_id, e));
    expect(outcome).toMatchObject({ action: 'quarantined', reason: 'business_mismatch:missing' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });
});

describe('balance movement vs entitlement liability (debits record the ACTUAL amount removed)', () => {
  const spend = async (n: number) => {
    // The auth lane mutates the shared balance directly; simulate its spend.
    await (store as unknown as { db: D1Database }).db
      .prepare('UPDATE credits SET balance = MAX(0, balance - ?), updated_at = ? WHERE subject = ?')
      .bind(n, Date.now(), TEST_ACCOUNT)
      .run();
  };

  it('grant 5, spend 3, dispute open then won ends at 2 (never 5): the debit records only what was actually removed', async () => {
    await deliver('payment-succeeded.json');
    await spend(3);
    expect(await store.balance(TEST_ACCOUNT)).toBe(2);
    const opened = await deliver('dispute-opened.json');
    expect(opened).toMatchObject({ action: 'revoked', cause: 'dispute' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    // Liability requested 5; the ledger records the ACTUAL balance movement: 2.
    expect((await store.paymentSums('pay_test_5pack')).dispute_revoked).toBe(2);
    const won = await deliver('dispute-won.json');
    expect(won).toMatchObject({ action: 'regranted', credits: 2 }); // restores only what was actually taken
    expect(await store.balance(TEST_ACCOUNT)).toBe(2);
  });

  it('refund-after-spend: a full refund removes only what remains (grant 5, spend 3 -> removes 2)', async () => {
    await deliver('payment-succeeded.json');
    await spend(3);
    await deliver('refund-succeeded.json'); // full $5 refund
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    expect((await store.paymentSums('pay_test_5pack')).refund_revoked).toBe(2);
    expect(await store.findOrderByPayment('pay_test_5pack')).toMatchObject({ status: 'refunded' });
  });

  it('partial refund after heavy spend clamps to the remaining balance (grant 5, spend 4, $2 refund -> removes 1)', async () => {
    await deliver('payment-succeeded.json');
    await spend(4);
    await deliver('refund-partial.json'); // $2 of $5 -> liability target 2
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    expect((await store.paymentSums('pay_test_5pack')).refund_revoked).toBe(1);
    expect(await store.findOrderByPayment('pay_test_5pack')).toMatchObject({ status: 'partially_refunded' });
  });

  it('dispute spent to zero: won restores nothing when the debit actually removed nothing', async () => {
    await deliver('payment-succeeded.json');
    await spend(5);
    await deliver('dispute-opened.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    expect((await store.paymentSums('pay_test_5pack')).dispute_revoked).toBe(0);
    await deliver('dispute-won.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
  });
});

describe('dispute record integrity (immutable identity, monotonic status)', () => {
  it('payment.succeeded -> dispute.won -> late dispute.opened keeps balance 5 (terminal rejects the stale event)', async () => {
    await deliver('payment-succeeded.json');
    const won = await deliver('dispute-won.json'); // terminal arrives FIRST (out-of-order delivery)
    expect(won).toMatchObject({ action: 'status_only' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    const late = await deliver('dispute-opened.json');
    expect(late).toMatchObject({ action: 'status_only', status: 'dispute_rejected' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    expect(await store.hasLedger('dispute_transition:pay_test_5pack:dsp_test_5pack')).toBe(true);
  });

  it('opened -> cancelled -> stale lost is rejected and moves nothing further', async () => {
    await deliver('payment-succeeded.json');
    await deliver('dispute-opened.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    await deliver('dispute-won.json', (e) => { e.type = 'dispute.cancelled'; return e; });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
    const stale = await deliver('dispute-lost.json');
    expect(stale).toMatchObject({ action: 'status_only', status: 'dispute_rejected' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });

  it('dispute identity is bound at first sight: the same dispute_id on another payment conflicts and moves nothing', async () => {
    await deliver('payment-succeeded.json');
    await deliver('dispute-opened.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    const foreign = await deliver('dispute-opened.json', (e) => {
      e.data.payment_id = 'pay_someone_else';
      return e;
    });
    expect(foreign).toMatchObject({ action: 'status_only', status: 'dispute_conflict' });
    expect(await store.hasLedger('dispute_conflict:pay_someone_else:dsp_test_5pack')).toBe(true);
    expect(await store.balance(TEST_ACCOUNT)).toBe(0); // unchanged by the conflicted event
  });

  it('dispute.challenged is recorded but moves no money; opened -> challenged -> won restores', async () => {
    await deliver('payment-succeeded.json');
    await deliver('dispute-opened.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    const challenged = await deliver('dispute-opened.json', (e) => { e.type = 'dispute.challenged'; return e; });
    expect(challenged).toMatchObject({ action: 'status_only', status: 'dispute_recorded' });
    expect(await store.balance(TEST_ACCOUNT)).toBe(0);
    await deliver('dispute-won.json');
    expect(await store.balance(TEST_ACCOUNT)).toBe(5);
  });
});
