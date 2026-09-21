/**
 * Standard Webhooks signature verification (https://www.standardwebhooks.com/).
 *
 * Dodo Payments signs every webhook delivery per the Standard Webhooks spec:
 *   - Headers: `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature`.
 *   - `webhook-signature` is a space-separated list of `version,base64sig` pairs
 *     (e.g. "v1,AbC...= v1,OldKey...=" during secret rotation).
 *   - The signed content is: `${webhook-id}.${webhook-timestamp}.${rawBody}`.
 *   - The signature is base64(HMAC-SHA256(key, signedContent)).
 *   - Dashboard secrets are `whsec_`-prefixed; the bytes after the prefix are
 *     base64-encoded key material. Unprefixed secrets are used as raw UTF-8.
 *
 * Reference: https://docs.dodopayments.com/developer-resources/webhooks
 */

export const WEBHOOK_TOLERANCE_SECONDS = 300; // Standard Webhooks default tolerance

export interface WebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'timestamp_out_of_tolerance' | 'invalid_signature' };

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToBase64 = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
};

/** Constant-time string compare (length-leak is acceptable here; sigs are fixed-size). */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const extractWebhookHeaders = (headers: Headers): WebhookHeaders | null => {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signature = headers.get('webhook-signature');
  if (!id || !timestamp || !signature) return null;
  return { id, timestamp, signature };
};

/** Thrown when the configured secret cannot be decoded (operator misconfiguration). */
export class WebhookConfigError extends Error {
  constructor() {
    super('webhook_secret_undecodable');
  }
}

export const decodeSecret = (secret: string): Uint8Array => {
  const trimmed = secret.trim();
  if (trimmed.startsWith('whsec_')) {
    const b64 = trimmed.slice('whsec_'.length);
    try {
      return base64ToBytes(b64);
    } catch {
      // Malformed base64 in the configured secret: a config error, never a
      // signature verdict. Callers map this to 5xx, not 401.
      throw new WebhookConfigError();
    }
  }
  return new TextEncoder().encode(trimmed);
};

/** Compute the expected base64 v1 signature for a delivery. Exported for tests/tooling. */
export const computeSignature = async (
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    decodeSecret(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = `${id}.${timestamp}.${rawBody}`;
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  return bytesToBase64(mac);
};

/**
 * Verify a delivery against the webhook secret.
 * `nowSeconds` is injectable for deterministic tests.
 */
export const verifyWebhook = async (
  secret: string,
  headers: WebhookHeaders,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> => {
  const sentAt = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(sentAt) || Math.abs(nowSeconds - sentAt) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  const expected = await computeSignature(secret, headers.id, headers.timestamp, rawBody);
  const candidates = headers.signature
    .split(' ')
    .map((entry) => entry.split(','))
    .filter(([version, sig]) => version === 'v1' && typeof sig === 'string' && sig.length > 0)
    .map(([, sig]) => sig);
  if (candidates.some((sig) => timingSafeEqual(sig, expected))) return { ok: true };
  return { ok: false, reason: 'invalid_signature' };
};
