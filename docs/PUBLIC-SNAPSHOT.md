# Public snapshot rollout

This code is inert unless both an R2 binding named `PUBLIC_SNAPSHOT` and the frontend variable `globalThis.DOXOMACHY_PUBLIC_SNAPSHOT` are configured. The Durable Object remains authoritative.

## Behavior
- Public state contains only beliefs, cycle, diary, version, and generatedAt.
- R2 reads are always read-only. Add and Protect stay disabled unless an authoritative WebSocket or API response is healthy.
- Read-only state shows its measured age. State older than 10 seconds is explicitly stale.
- Remaining moves are hidden as `—` until an authenticated API read or mutation response restores them.
- Mutation save and WebSocket broadcast do not await R2. Publication runs in a version-ordered background queue.
- Every authoritative GET and WebSocket connect repairs a missed publish. R2 HEAD version checks prevent downgrade, including initial seed.
- Logs include snapshot result, attempted version, lag, and publish duration.

## Payment stop condition
Current public Cloudflare flows may require an R2 subscription/checkout. Do not create a bucket, activate R2, add a payment method, or accept a paid subscription without direct confirmation in the existing account that activation requires neither payment nor a paid plan. If that cannot be confirmed, leave this code inert.

## Safe enablement after direct account confirmation
1. Create one bucket on the existing Worker account and add `PUBLIC_SNAPSHOT` binding.
2. Configure GET/HEAD CORS for the two site origins without credentials.
3. Attach `state.doxomachy.flcrom.dev` from the account owning the zone.
4. Seed via the version-guarded publisher. Never upload an empty or lower-version object over live state.
5. Verify schema, CORS, cache policy, generatedAt, and version against authority.
6. Set `globalThis.DOXOMACHY_PUBLIC_SNAPSHOT` before `app.js` only for a canary.
7. Watch Class A/B usage, `snapshot_failed`, version lag, and stale UI state. Roll back by removing the frontend variable; reads return to `/v1/mind`.
