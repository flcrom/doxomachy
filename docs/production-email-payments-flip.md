# Production email and payments flip

This runbook keeps secrets out of git and separates setup, verification, and enablement. Do not paste key values into issues, commits, logs, or chat. Store them in the vault, then enter them directly with `wrangler secret put`.

## 1. Release gate

From the repository root:

```sh
npm test
npm --prefix worker ci
npm --prefix worker test
npm --prefix worker run typecheck
npm --prefix worker run dry-run
```

Apply the four forward D1 migrations in filename order before enabling auth or checkout. Preview/list first, back up D1, then apply to the production database:

```sh
cd worker
npx wrangler d1 migrations list doxomachy
npx wrangler d1 migrations apply doxomachy --remote
```

The forward migrations are `0001.sql`, `0002.sql`, `0002_dodo_payments.sql`, and `0003_dodo_disputes.sql`. The rollback SQL under `docs/runbooks/` is destructive and is not a migration.

## 2. Resend and magic-link email

### User-side setup must deliver

- A Resend account with the sending domain `doxomachy.flcrom.dev` added and verified.
- The exact Resend-generated DKIM and SPF DNS records installed in the DNS account that owns `flcrom.dev`. If Resend supplies a CNAME, keep Cloudflare proxying off for that record.
- The sender identity `Doxomachy <login@doxomachy.flcrom.dev>` on that verified domain.
- A sending-enabled Resend API key, delivered through the vault.
- A new random auth email pepper of at least 32 random bytes, delivered through the vault and backed up there. Losing it or changing it without the documented rotation process can orphan account lookup keys.
- DMARC added after domain verification. This is a deliverability/security follow-up, not a code dependency.

Resend recommends using a subdomain, requires exact DNS records, and says verification often finishes within 15 minutes but can take up to 72 hours. Source: https://resend.com/docs/add-a-domain

### Worker configuration

Set the secrets without printing their values:

```sh
cd worker
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put AUTH_EMAIL_PEPPER
```

Set `AUTH_FROM` to the exact verified sender string `Doxomachy <login@doxomachy.flcrom.dev>`. It is not confidential, but it must match the verified domain. It is committed as a Worker variable in `worker/wrangler.toml`.

`WEB_ORIGIN` must remain `https://doxomachy.flcrom.dev`; magic links are built from it. `WEB_ORIGIN_EXTRA` may retain the temporary Vercel origin during cutover.

Auth fails closed with `503 auth_not_configured` unless the database, `RESEND_API_KEY`, `AUTH_EMAIL_PEPPER`, `AUTH_FROM`, and a valid HTTPS `WEB_ORIGIN` are all present. A failed Resend send deletes the unused challenge and the public response stays generic.

### Verify before announcing auth

1. Deploy with the domain verified and the three auth values set.
2. Request a link for a real inbox through `POST /v1/auth/magic-link` from the production origin.
3. Confirm the message's From address is `Doxomachy <login@doxomachy.flcrom.dev>` and the link begins with `https://doxomachy.flcrom.dev/callback.html#token=`.
4. Confirm the link works once, expires after 15 minutes, and replay fails.
5. Confirm sign-out and a second-device sign-in (there is no sign-out-all).
6. Check inbox and spam placement. Never copy a live magic-link token into logs or tickets.

## 3. Dodo production setup

Dodo test and live mode have separate products, API keys, webhooks, transactions, and reports. The production API host is `https://live.dodopayments.com`. Live payments and payouts require account verification. Source: https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode

### User-side setup must deliver

In Dodo **live mode**:

- Account verification/KYC complete and live payments enabled.
- Bank payout details verified.
- A live one-time product for exactly `$5 USD` and five non-expiring moves. Copying the tested sandbox product to live is allowed, but record the new live product ID.
- The exact live product ID (`DODO_PRODUCT_ID`).
- The live business ID (`DODO_BUSINESS_ID`). Configure it rather than leaving it blank, so missing or foreign-business webhooks are rejected.
- A live API key with write access, delivered through the vault. Checkout session creation needs write access. Dodo documents API key management under Developer -> API Keys: https://docs.dodopayments.com/api-reference/introduction
- A long random operator key for `DODO_ADMIN_KEY`, delivered through the vault.
- A live webhook endpoint at `https://api.doxomachy.flcrom.dev/webhooks/dodo`, plus its live `whsec_...` signing secret delivered through the vault.
- The webhook subscribed to:
  - `payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.processing`
  - `refund.succeeded`, `refund.failed`
  - `dispute.opened`, `dispute.challenged`, `dispute.accepted`, `dispute.cancelled`, `dispute.expired`, `dispute.won`, `dispute.lost`
- Final confirmation that the dashboard product price/currency and public refund terms match the product shown on Doxomachy.

Webhook setup and signature behavior: https://docs.dodopayments.com/developer-resources/webhooks

### Worker production configuration

Keep `DODO_CHECKOUT_ENABLED = "false"` while configuring and verifying. Set:

```toml
DODO_API_BASE = "https://live.dodopayments.com"
DODO_PRODUCT_ID = "<live product id>"
DODO_RETURN_URL = "https://doxomachy.flcrom.dev/pricing.html?checkout=return"
DODO_CHECKOUT_ENABLED = "false"
DODO_BUSINESS_ID = "<live business id>"
```

Then enter the live secrets directly:

```sh
cd worker
npx wrangler secret put DODO_API_KEY
npx wrangler secret put DODO_WEBHOOK_SECRET
npx wrangler secret put DODO_ADMIN_KEY
```

Test-mode keys, product IDs, webhook secrets, and data do not work in live mode. Do not overwrite the live Worker with sandbox values after the switch.

### Verify while checkout is still off

1. Deploy the production config with checkout still disabled.
2. Confirm `POST /v1/checkout/session` returns `403 checkout_disabled`.
3. Send a signed live webhook test from the Dodo dashboard. Confirm a valid event is accepted, an invalid signature is rejected, and the endpoint has no browser CORS dependency.
4. Call the reconciliation endpoint with the operator key and confirm there is no drift, no truncation, no quarantined payment, and mode reports `live`:

   ```sh
   curl -fsS -X POST \
     -H "Authorization: Bearer $DODO_ADMIN_KEY" \
     https://api.doxomachy.flcrom.dev/v1/admin/dodo/reconcile
   ```

   Do not place the operator key in shell history on a shared machine. Prefer reading it from the vault into the process environment.
5. Confirm production auth works. Checkout requires an authenticated account session.
6. Confirm the pricing page and checkout button are ready for the live route. The backend being enabled does not by itself change a frontend still presenting free-launch mode.
7. The buy button must sit behind an unticked checkbox the buyer ticks before checkout opens, worded: "I agree that my credits are delivered immediately and I understand that I lose my right of withdrawal once they are delivered. All sales are final." Keep the button disabled until it is ticked. This is the EU/UK express consent and acknowledgement for digital content (Consumer Rights Directive 2011/83/EU, Article 16(m)); the Refund & Cancellation Policy says buyers give it before paying.

### Enable and canary

Only after the checks above, change `DODO_CHECKOUT_ENABLED` to `"true"` and deploy. Immediately run one controlled real `$5` purchase, then verify:

- the hosted checkout returns to `https://doxomachy.flcrom.dev/pricing.html?checkout=return`;
- one `payment.succeeded` produces exactly five credits for the signed-in account;
- webhook retries do not duplicate credits;
- reconciliation reports zero drift and no truncation;
- a controlled refund removes the correct remaining credits and appears in reconciliation.

A live canary is a real charge. It requires explicit approval for the charge and the refund before running it.

### Fast rollback

Set `DODO_CHECKOUT_ENABLED` back to `"false"` and deploy. This stops new checkout sessions without deleting orders, webhook inbox rows, ledger records, or account credits. Keep the webhook endpoint active so refunds/disputes on existing payments still reconcile. If email delivery fails, remove or invalidate `RESEND_API_KEY` to make auth fail closed, but preserve `AUTH_EMAIL_PEPPER` in the vault so existing accounts are not orphaned.
