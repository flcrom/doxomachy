import { describe, it, expect } from 'vitest';
import {
  verifyWebhook,
  computeSignature,
  decodeSecret,
  WEBHOOK_TOLERANCE_SECONDS,
} from '../src/payments/standard-webhooks';
import { TEST_SECRET, NOW_SECONDS } from './helpers';

const ID = 'msg_test_1';
const TS = String(NOW_SECONDS);
const BODY = '{"type":"payment.succeeded","data":{"payment_id":"pay_1"}}';

describe('standard webhooks verification', () => {
  it('accepts a correctly signed delivery', async () => {
    const sig = await computeSignature(TEST_SECRET, ID, TS, BODY);
    const result = await verifyWebhook(TEST_SECRET, { id: ID, timestamp: TS, signature: `v1,${sig}` }, BODY, NOW_SECONDS);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a tampered body', async () => {
    const sig = await computeSignature(TEST_SECRET, ID, TS, BODY);
    const forged = BODY.replace('pay_1', 'pay_evil');
    const result = await verifyWebhook(TEST_SECRET, { id: ID, timestamp: TS, signature: `v1,${sig}` }, forged, NOW_SECONDS);
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a wrong secret', async () => {
    const sig = await computeSignature('whsec_b3RoZXIta2V5LWVudGlyZWx5', ID, TS, BODY);
    const result = await verifyWebhook(TEST_SECRET, { id: ID, timestamp: TS, signature: `v1,${sig}` }, BODY, NOW_SECONDS);
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects timestamps outside the tolerance window (replay protection)', async () => {
    const oldTs = String(NOW_SECONDS - WEBHOOK_TOLERANCE_SECONDS - 1);
    const sig = await computeSignature(TEST_SECRET, ID, oldTs, BODY);
    const result = await verifyWebhook(TEST_SECRET, { id: ID, timestamp: oldTs, signature: `v1,${sig}` }, BODY, NOW_SECONDS);
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('accepts timestamps at the tolerance edge', async () => {
    const edgeTs = String(NOW_SECONDS - WEBHOOK_TOLERANCE_SECONDS);
    const sig = await computeSignature(TEST_SECRET, ID, edgeTs, BODY);
    const result = await verifyWebhook(TEST_SECRET, { id: ID, timestamp: edgeTs, signature: `v1,${sig}` }, BODY, NOW_SECONDS);
    expect(result).toEqual({ ok: true });
  });

  it('accepts any matching v1 entry during secret rotation', async () => {
    const sig = await computeSignature(TEST_SECRET, ID, TS, BODY);
    const header = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1,${sig}`;
    const result = await verifyWebhook(TEST_SECRET, { id: ID, timestamp: TS, signature: header }, BODY, NOW_SECONDS);
    expect(result).toEqual({ ok: true });
  });

  it('ignores non-v1 signature versions', async () => {
    const sig = await computeSignature(TEST_SECRET, ID, TS, BODY);
    const result = await verifyWebhook(TEST_SECRET, { id: ID, timestamp: TS, signature: `v0,${sig}` }, BODY, NOW_SECONDS);
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('decodes whsec_ secrets as base64 and raw secrets as UTF-8', () => {
    expect(decodeSecret(TEST_SECRET)).toHaveLength(30);
    expect(new TextDecoder().decode(decodeSecret(TEST_SECRET))).toBe('test-signing-key-for-doxomachy');
    expect(new TextDecoder().decode(decodeSecret('plainsecret'))).toBe('plainsecret');
  });
});
