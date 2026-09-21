/**
 * Minimal fetch-based client for the Dodo Payments REST API. The official SDKs
 * target Node; the Worker only needs a few endpoints, so we call them directly.
 *
 *   POST {apiBase}/checkouts            create a checkout session
 *   GET  {apiBase}/payments             list payments (reconciliation)
 *   GET  {apiBase}/refunds              list refunds (reconciliation)
 *   GET  {apiBase}/disputes             list disputes (reconciliation)
 *   Authorization: Bearer <DODO_API_KEY>
 *
 * Dodo's checkout API documents NO idempotency key (checked 2026-09-21 against
 * docs.dodopayments.com/api-reference/checkout-sessions/create), so checkout
 * recovery relies on the persisted pre-call intent + the correlation metadata
 * we send (account_id, intent_key, product_id) matched against the payments
 * list by the reconciler.
 *
 * List APIs paginate with page_number starting at 0 and page_size up to 100
 * (docs.dodopayments.com/api-reference/payments/get-payments). listAll starts
 * at page 0, caps pages, times every request out, and reports truncation so a
 * capped result is never silently treated as complete.
 *
 * Test-mode host: https://test.dodopayments.com (independent API keys, products
 * and webhooks from live mode). Live host is https://live.dodopayments.com and
 * must never be configured until the owner enables live payments.
 */

export interface CheckoutSessionRequest {
  product_cart: Array<{ product_id: string; quantity: number }>;
  return_url?: string;
  cancel_url?: string;
  metadata?: Record<string, string>;
}

export interface CheckoutSessionResponse {
  session_id: string;
  checkout_url: string | null;
}

export class DodoApiError extends Error {
  /**
   * ambiguous=false means the provider DEFINITIVELY refused the request before
   * acting on it (HTTP 4xx; Dodo documents 422 on POST /checkouts as "Invalid
   * Request Object or Parameters"). ambiguous=true means the outcome is
   * UNKNOWN: 5xx, proxy/gateway error pages, unparseable or structurally
   * invalid 2xx bodies - the request may have succeeded upstream.
   */
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly ambiguous: boolean,
  ) {
    super(`dodo_api_error_${status}`);
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const CHECKOUT_TIMEOUT_MS = 20_000; // session creation can legitimately take longer

type FetchImpl = typeof fetch;

const request = async (
  fetchImpl: FetchImpl,
  apiBase: string,
  apiKey: string,
  method: string,
  path: string,
  body: unknown | undefined,
  timeoutMs: number,
): Promise<unknown> => {
  const res = await fetchImpl(`${apiBase.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // Never forward upstream bodies to clients; they may contain account detail.
    // 4xx = definitive pre-creation refusal; 5xx (or a proxy/gateway page
    // standing in for the API) = ambiguous.
    const text = (await res.text().catch(() => '')).slice(0, 500);
    throw new DodoApiError(res.status, text, !(res.status >= 400 && res.status < 500));
  }
  try {
    return await res.json();
  } catch {
    // A 2xx we cannot parse proves nothing about whether the action happened.
    throw new DodoApiError(res.status, 'unparseable response body', true);
  }
};

export const createCheckoutSession = async (
  apiBase: string,
  apiKey: string,
  requestBody: CheckoutSessionRequest,
  fetchImpl: FetchImpl = fetch,
): Promise<CheckoutSessionResponse> => {
  const data = (await request(fetchImpl, apiBase, apiKey, 'POST', '/checkouts', requestBody, CHECKOUT_TIMEOUT_MS)) as Partial<CheckoutSessionResponse>;
  if (!data.session_id || typeof data.session_id !== 'string') {
    // Malformed 2xx: the session may well exist upstream. AMBIGUOUS.
    throw new DodoApiError(200, 'missing session_id in response', true);
  }
  return { session_id: data.session_id, checkout_url: data.checkout_url ?? null };
};

export interface DodoListPage<T> {
  items: T[];
}

export interface ListResult<T> {
  items: T[];
  /** True when the page cap was hit with a full last page: the result may be incomplete. */
  truncated: boolean;
}

const listAll = async <T>(
  fetchImpl: FetchImpl,
  apiBase: string,
  apiKey: string,
  path: string,
  params: Record<string, string> = {},
  pageSize = 100,
  maxPages = 10,
): Promise<ListResult<T>> => {
  const out: T[] = [];
  let truncated = false;
  // Dodo paginates from page_number = 0 (API reference: "Page number default is 0").
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ ...params, page_size: String(pageSize), page_number: String(page) });
    const data = (await request(fetchImpl, apiBase, apiKey, 'GET', `${path}?${query}`, undefined, REQUEST_TIMEOUT_MS)) as Partial<DodoListPage<T>>;
    const items = Array.isArray(data.items) ? data.items : [];
    out.push(...items);
    if (items.length < pageSize) {
      truncated = false;
      return { items: out, truncated };
    }
    truncated = true; // a full page at the cap may hide further pages
  }
  return { items: out, truncated };
};

export interface DodoPaymentSummary {
  payment_id?: string;
  status?: string;
  total_amount?: number;
  currency?: string;
  business_id?: string;
  checkout_session_id?: string;
  metadata?: Record<string, unknown>;
  refund_status?: string | null;
  dispute_status?: string | null;
}

export interface DodoRefundSummary {
  refund_id?: string;
  payment_id?: string;
  status?: string;
  amount?: number;
  currency?: string;
  is_partial?: boolean;
}

export interface DodoDisputeSummary {
  dispute_id?: string;
  payment_id?: string;
  dispute_status?: string;
  amount?: string;
  currency?: string;
}

export const listPayments = (apiBase: string, apiKey: string, fetchImpl: FetchImpl = fetch): Promise<ListResult<DodoPaymentSummary>> =>
  listAll<DodoPaymentSummary>(fetchImpl, apiBase, apiKey, '/payments');

export const listRefunds = (apiBase: string, apiKey: string, fetchImpl: FetchImpl = fetch): Promise<ListResult<DodoRefundSummary>> =>
  listAll<DodoRefundSummary>(fetchImpl, apiBase, apiKey, '/refunds');

export const listDisputes = (apiBase: string, apiKey: string, fetchImpl: FetchImpl = fetch): Promise<ListResult<DodoDisputeSummary>> =>
  listAll<DodoDisputeSummary>(fetchImpl, apiBase, apiKey, '/disputes');
