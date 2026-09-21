# Dodo Payments test-mode integration (rev 4)

Branch: `feat/dodo-payments-test-mode`, rebased onto `main` @ 38eb9e0 (the
hardened + DO-scaling worker) and merged with the auth lane (rev 2). Nothing
here is deployed; Vercel and Cloudflare auto-deploy `main`, so this lands only
through the lead's review. First built 2026-09-18; rev 2 reworked it for the
first QA block (durable webhook inbox, authenticated-account identity,
idempotent checkout intents, actual-byte body caps, partial-refund/dispute
math, executable reconciliation, hardened schema); rev 3 (QA block 2):
leased inbox claims, per-payment locks, additive shared-balance writes,
payload minimization + retention pruning, quarantine on unresolvable amounts;
rev 4 (QA block 3): ownership FKs to `accounts(id)`, the end of all
auto-retry of ambiguous checkout intents (`needs_reconciliation`), and doc
corrections below. rev 5/6 (QA blocks 4-6): ambiguous-vs-definitive checkout
outcomes, refund identity immutability + monotonic status, refund/dispute
netting, exact business_id enforcement, concurrent-reconciliation safety,
atomic actual-amount debits (balance movement vs entitlement liability), and
immutable monotonic dispute records.

Built from the current official docs (re-verified 2026-09-21):

- Webhooks + Standard Webhooks verification: https://docs.dodopayments.com/developer-resources/webhooks
- Event catalog: https://docs.dodopayments.com/developer-resources/webhooks/intents/webhook-events-guide
- Dispute lifecycle: https://docs.dodopayments.com/developer-resources/webhooks/intents/dispute
- Checkout session API: https://docs.dodopayments.com/api-reference/checkout-sessions/create (NO documented idempotency key, no session-lookup endpoint)
- List APIs used by reconciliation: /api-reference/payments/get-payments, /refunds/get-refunds, /disputes/get-disputes (paginate from page_number=0)
- Test vs live mode: https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode

## What exists now

| Piece | Where | State |
| --- | --- | --- |
| Standard Webhooks verification (HMAC-SHA256, `whsec_` base64 keys, rotation-tolerant, 300s tolerance; malformed base64 is a clean 500/401, never a crash) | `worker/src/payments/standard-webhooks.ts` | Done, tested |
| Webhook endpoint `POST /webhooks/dodo`: verify -> durable leased inbox -> fulfill. Only COMPLETED deliveries are acked as duplicates; claimed/processing/failed deliveries are reclaimed and reprocessed. Payloads are minimized on receipt and CLEARED on completion (7d/30d retention pruning); no indefinite PII retention | `worker/src/payments/routes.ts`, `store.ts` | Done, tested |
| Fulfillment state machine behind per-payment locks: grant / netting refund revoke / temporary dispute suppression / dispute re-grant, all SQL-capped per payment; unresolvable or conflicting records quarantine the order (grant suppressed) instead of guessing | `worker/src/payments/fulfillment.ts` | Done, tested |
| Order + ledger + inbox + intent + refund schema with invariants (CHECK constraints, `payment_id` UNIQUE when set, ownership FKs to `accounts(id)`); immutable/monotonic dispute records in `0003_dodo_disputes.sql` | `worker/migrations/0002_dodo_payments.sql`, `0003_dodo_disputes.sql` | Done, tested (real SQL via node:sqlite with `PRAGMA foreign_keys=ON`) |
| Checkout `POST /v1/checkout/session`: Origin + authenticated account required, idempotent intent persisted BEFORE upstream, caller clientId ignored, ambiguous upstream outcomes NEVER auto-retried (escalate to `needs_reconciliation`), hard-gated OFF | `worker/src/payments/routes.ts` | Done, gated OFF |
| Reconciliation `POST /v1/admin/dodo/reconcile` (Bearer `DODO_ADMIN_KEY`, 404 when unset): recovers missing orders from intents (matched by `intent_key` metadata), replays missed refunds/disputes, retries failed inbox deliveries, re-applies crashed balance deltas, prunes retained payloads, reports drift | `worker/src/payments/reconcile.ts` | Done, tested |
| Tests: signature, inbox lease/replay, per-payment locking, partial + multiple refunds, refund x dispute permutations, refund monotonicity + identity immutability (conflicting duplicates quarantined), cross-currency refund rejection, out-of-order partial-refund-before-grant netting, dispute suppression/won netting, missing + foreign business rejection, checkout D1 failure (no duplicate sessions), definitive-refusal (422) vs ambiguous (5xx / timeout / malformed 2xx) outcomes, simultaneous reconciliation (Promise.all, exactly-once), ownership FK enforcement, auth/ownership, malformed base64, chunked-body caps, mounted-route wiring | `worker/test/` | Worker suite green; auth lane's own suite runs in the same tree |
| Live mode, KYC, real charges, deploy | - | Intentionally not touched |

## Identity and the auth seam

The entitlement subject is the **authenticated account UUID**, resolved by the
AUTH LANE's seam `requireAccount(request, env)` imported from
`worker/src/auth.ts`. Payments never reads `account_sessions` directly, never
declares that table (it lives in the auth lane's `0002.sql` migration), and
does NOT mount `GET /v1/credits` (the auth lane owns the account-bound
balance route; `credits.subject = account UUID` is the shared balance row the
auth lane spends/refunds and this lane grants into). There is no
`payments/account-auth.ts` file - earlier revisions of this doc referenced
one; that was wrong. Caller-supplied `clientId` is ignored everywhere.
Browser payment routes also require a real browser `Origin` (missing or wrong
Origin -> 403 at the mount in `worker/src/index.ts`).

### Ownership foreign keys (deletion policy - confirmed by the owner 2026-09-21)

- `dodo_orders.account_id REFERENCES accounts(id)` with default NO ACTION
  (= RESTRICT): **financial history blocks account deletion at the DB
  level.** Closing an account that has orders requires settling/refunding and
  archiving the orders first (ops flow); the auth lane's account-deletion
  endpoint will surface a constraint error otherwise. The owner confirmed
  this policy on 2026-09-21: financial records must not disappear.
- `checkout_intents.account_id REFERENCES accounts(id) ON DELETE CASCADE`:
  intents are ephemeral checkout state and die with the account.
- `dodo_refunds.payment_id` deliberately has **no FK**: refunds must be
  recordable before (or without ever) resolving an order, because
  grant-suppression caps depend on their cumulative amounts. Linkage is
  enforced by the reconciler's `refund_without_order` drift check instead.
- `credit_ledger.subject` has no FK: suppression markers use `'unmatched'`.
- Apply order matters: `0001.sql`, auth `0002.sql` (creates `accounts`), then
  `0002_dodo_payments.sql`. Filename sort already guarantees it.
- `dodo_orders.payment_id` is `TEXT UNIQUE` (SQLite allows multiple NULLs):
  unique whenever set, targetable by name, NULL pre-payment.

## Event -> entitlement mapping

One purchase = one non-expiring pack of 5 moves ($5). Credits are granted per
PAYMENT; revokes are proportional and capped.

- `payment.succeeded` -> grant 5 credits (once per `payment_id`). Unknown order: recovered from verified metadata via the server-side product catalog; otherwise `no_order` for reconciliation.
- `payment.failed` / `payment.cancelled` -> order status only, and only while unpaid (no regressing a succeeded order).
- `refund.succeeded` -> revoke `floor(credits * cumulative_refunded / total)` cumulative, minus what earlier refunds already revoked; once per `refund_id`. The refunded amount is summed ONLY in the order's currency; a refund whose currency disagrees with the order gets no entitlement math at all and is flagged `refund_currency:<payment>:<refund>` drift. Unknown amounts are treated as full refunds (conservative). Order becomes `partially_refunded` or `refunded`.
- `refund.failed` -> refund record only. Refund status is MONOTONIC per `refund_id` (succeeded is terminal): a late `refund.failed` for an already-succeeded refund is recorded but never downgrades it, never re-entitles.
- Refund identity is IMMUTABLE once recorded: `payment_id`, `amount`, `currency`. An exact duplicate only moves status forward; a conflicting duplicate (same `refund_id`, different amount/currency/payment) is NOT applied, is flagged `refund_conflict:<payment>:<refund>` drift, and never rewrites the financial record.
- Refunds NET against grants instead of suppressing them: a partial refund recorded before a late `payment.succeeded` grants the remainder (e.g. $2 of $5 refunded -> 3 credits, not 0). A full (or unknown-amount) refund before the grant still suppresses it entirely.
- `dispute.opened` / `.accepted` / `.expired` / `.lost` -> revoke everything still outstanding for the payment (once per payment).
- `dispute.opened` SUPPRESSES temporarily, it does not permanently revoke: if the payment later succeeds the grant is withheld while the dispute is open; if the payment was already granted, the dispute revokes. `dispute.challenged` is record-only (the merchant's response moves no money).
- `dispute.won` / `dispute.cancelled` -> restore what the dispute ACTUALLY took MINUS what refunds settled meanwhile, and when the grant was only suppressed (never landed) the NET entitlement is granted. A refund always beats a dispute win.
- Dispute records (`dodo_disputes`, migration 0003) are keyed by `dispute_id` with payment identity (`payment_id`, amount, currency) bound IMMUTABLY at first sight - a redelivery binding the same dispute to different identity is a conflict (no effect, `dispute_conflict:<payment>:<dispute>` drift). Status is monotonic through an explicit transition table: `opened -> challenged -> accepted`, with `won`/`lost`/`cancelled`/`expired` TERMINAL. A stale event after a terminal status (e.g. a late `dispute.opened` after `dispute.won`) is rejected: no state change, no entitlement effect, `dispute_transition:<payment>:<dispute>` drift.

### Entitlement liability vs balance movement

These are TWO DIFFERENT NUMBERS and the code never reuses one as the other:

- **Entitlement liability** is a per-payment accounting figure: how much of the grant remains contestable (`granted - refunds settled - dispute debits requested`). Fulfillment uses it ONLY to decide how much a new refund/dispute event may still REQUEST to debit, and how much a dispute win may restore. It lives in the fulfillment math (`paymentSums`, refund targets).
- **Balance movement** is what actually happened to the shared `credits` balance, recorded as `credit_ledger.delta`. Every debit (dispute revoke, refund revoke, grant-time refund settle) atomically records `-MIN(current_balance, request)` - computed inside a single atomic SQL batch against the live balance - never the requested liability. The shared balance is also spent by the auth lane between our events, so the request and the movement legitimately differ: grant 5, spend 3, dispute opened removes 2 (not 5), dispute won restores 2 and the account ends at 2 (not 5). A restore can only ever return what was actually taken.
- anything else -> 200, ignored (keeps dashboard "Send example" green).

## Idempotency and safety design

- `webhook_inbox` dedupes by `webhook-id` behind an owner-token lease claimed atomically in SQL (conditional UPDATE on an owner token): exactly one worker holds a delivery at a time. A duplicate is acked ONLY when completed; anything else is reclaimed (60s stale window for crashed 'processing') and reprocessed. 5xx asks Dodo to retry. The guarantee is *at-least-once processing with exactly-once effects*: a crash anywhere re-runs the delivery, and every state transition underneath is idempotent, so redelivery converges instead of double-applying.
- Fulfillment mutations run under a per-payment lock row claimed the same way. Concurrent events for the same payment serialize; the loser waits/retries rather than interleaving. The reconciler's balance repairs take the same per-payment lock, so a reconciliation racing a live delivery can never double-apply a delta.
- `credit_ledger.reference` is unique per transition (`grant:<payment_id>`, `revoke:refund:<payment_id>:<refund_id>`, `revoke:dispute:<payment_id>`, `regrant:dispute:<payment_id>`). Every change is exactly-once even across equivalent redeliveries.
- Revoke/re-grant deltas are computed INSIDE `INSERT ... SELECT` with SQL MIN/MAX caps: a transition can never revoke more than the payment's outstanding credits or restore more than its dispute took, even under concurrent or out-of-order deliveries.
- `credits(subject, balance)` is shared with the auth lane, which mutates the balance directly. Payments therefore applies ADDITIVE deltas floored at zero (`MAX(0, balance + ?)`) and never recomputes an absolute balance from its own ledger, which would clobber auth-lane spends. A crash between the ledger insert and the balance mutation leaves `balance_applied = 0`; the reconciler re-applies the recorded delta under the per-payment lock, which is what bridges the crash without double-applying.
- Out-of-order safety: revokes for unknown orders record suppression markers, so a late `payment.succeeded` settles every recorded refund/dispute against the grant instead of granting past them.
- Checkout intents are persisted BEFORE the upstream call, keyed by `account_id:idempotency-key`: same-key retries replay the stored outcome (no duplicate Dodo sessions).
- **Ambiguous outcomes are never auto-retried; definitive refusals are.** Dodo documents POST /checkouts responses 200 / 422 / 500 with no idempotency key and no session-lookup endpoint. A 4xx (e.g. the documented 422) is a DEFINITIVE pre-creation refusal: the intent is marked `failed` and a later retry with the same key starts fresh. A 5xx, timeout, transport error, malformed body, or a 2xx missing `session_id` is AMBIGUOUS (a payable session may exist upstream): the intent stays `pending` (`upstream_ambiguous`) and always answers 409 - never a second upstream attempt; once stale (10 min) it escalates to `needs_reconciliation` (route and reconciler both do this); the reconciler recovers via `intent_key` metadata matches and reports unmatched intents as `intent_needs_reconciliation:<key>` drift on EVERY run. Nothing is auto-abandoned.
- Body limits are ACTUAL-BYTE caps enforced while streaming (32KB webhook, 2KB checkout); Content-Length is never trusted.
- Webhook business context: when `DODO_BUSINESS_ID` is set, the event's `business_id` must match EXACTLY - a different business OR a missing one is rejected (403). At grant time the check is stricter still: only the VERIFIED PAYLOAD's business can satisfy it; the order row's own `business_id` (written from our configuration at checkout) is never used to pass. Reconciler replays are the one documented exception: Dodo's payments-list API omits `business_id`, so replays attribute the configured business to recovered upstream records (flagged for QA review).
- Verified payloads are minimized on receipt, cleared on completion, and pruned by age (7d completed / 30d failed). No indefinite PII retention.

## Setup checklist (lead / owner actions, none done here)

1. Apply the migrations IN ORDER: `cd worker && npx wrangler d1 migrations apply doxomachy` (preview first with `--dry-run`). `wrangler d1 migrations list` shows ONLY forward migrations (`0001.sql`, auth `0002.sql`, `0002_dodo_payments.sql`, `0003_dodo_disputes.sql`). Wrangler executes EVERY `.sql` file in `worker/migrations/` as a forward migration, so the auth rollback lives in `docs/runbooks/0002-auth-rollback.sql` (apply by hand only, after the Worker no longer serves auth routes; it destroys all auth data) and `worker/test/migrations.test.ts` guards the directory against rollback/destructive artifacts. (`webhook_events` from 0001 is superseded by `webhook_inbox` and left in place.)
2. In the Dodo dashboard **test mode**: create the $5 product, set `DODO_PRODUCT_ID` in `worker/wrangler.toml` (and optionally `DODO_BUSINESS_ID`). Keep `DODO_API_BASE = "https://test.dodopayments.com"` and `DODO_CHECKOUT_ENABLED = "false"` until the owner approves paid checkout.
3. Secrets (never in git):
   - `npx wrangler secret put DODO_API_KEY` -> test-mode API key (Developer -> API Keys)
   - `npx wrangler secret put DODO_WEBHOOK_SECRET` -> test-mode endpoint signing secret, `whsec_...` (Developer -> Webhooks -> endpoint Overview)
   - `npx wrangler secret put DODO_ADMIN_KEY` -> any long random string; enables the reconciliation endpoint
4. In Developer -> Webhooks, add endpoint `https://<worker-url>/webhooks/dodo` and subscribe to: `payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.processing`, `refund.succeeded`, `refund.failed`, `dispute.opened`, `dispute.challenged`, `dispute.accepted`, `dispute.cancelled`, `dispute.expired`, `dispute.won`, `dispute.lost`.
5. Verify with the dashboard Testing tab, one real $5 test-mode purchase with the test cards from https://docs.dodopayments.com/miscellaneous/testing-process, a partial AND a full test refund, and a dashboard dispute simulation; then run `POST /v1/admin/dodo/reconcile` and confirm zero drift.
6. Only after owner approval AND the auth lane is live: set `DODO_CHECKOUT_ENABLED = "true"`.

## Exact secure fields still needed

| Field | Kind | Where it goes | Source (test mode) |
| --- | --- | --- | --- |
| `DODO_API_KEY` | secret | `wrangler secret put` | Dodo dashboard -> Developer -> API Keys (test mode) |
| `DODO_WEBHOOK_SECRET` | secret | `wrangler secret put` | Dodo dashboard -> Developer -> Webhooks -> endpoint -> Overview (`whsec_...`) |
| `DODO_ADMIN_KEY` | secret | `wrangler secret put` | generated by the lead (any long random string) |
| `DODO_PRODUCT_ID` | var (not secret) | `wrangler.toml` | Dodo dashboard -> Products (test mode), the $5 five-move pack |
| `DODO_BUSINESS_ID` | var (not secret) | `wrangler.toml` | Dodo dashboard -> Business profile (optional hardening) |

## Deliberate boundaries

- Checkout returns 403 `checkout_disabled` unless `DODO_CHECKOUT_ENABLED` is exactly `"true"`; it is `"false"` in this patch.
- Checkout requires the auth lane's account sessions. Until that lane is live it 401s for everyone; checkout stays disabled regardless.
- Frontend untouched: `pricing.html` still shows free launch mode. When enabled, the frontend calls `POST /v1/checkout/session` with the account session token + an `Idempotency-Key` and redirects to `checkout_url`.
- Move consumption is NOT wired to `credits` yet. Follow-up for the game-mechanics owner: when `no_moves` would fire, check the account's `credits` balance first and decrement with a ledger consumption entry. `credits.balance` never goes below zero.
- The reconciliation route is ops-only (404 without `DODO_ADMIN_KEY`); it uses Dodo's test-mode list APIs and never creates charges.
- Known edge: a refund for a payment whose `payment.succeeded` was never delivered records a suppression marker and surfaces as `no_order`/`refund_without_order` drift for reconciliation; if the payment event arrives later, the grant settles the recorded refund (net grant for partial, full suppression for full/unknown).
- Confirmed policy (owner, 2026-09-21): accounts with order history cannot be deleted (RESTRICT). An ops refund-and-archive flow is needed before closing such accounts.
