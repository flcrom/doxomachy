# Doxomachy operations runbook

## Signals

The Worker emits one-line JSON application logs through `worker/src/observability.ts`. Every event carries `operation`, `outcome` (`ok`/`degraded`/`error`), `correlation_id`, and optional `status`, `route` (templated), `method`, `duration_ms`, `reason`, and numeric `gauges`. The schema is deliberately allowlisted.

**Never log request bodies, prompts, belief or diary text, aliases, session tokens, client IPs, authorization or idempotency values, secrets, webhook payloads, checkout URLs, payment IDs, amounts, or card data.** Route templates (`/v1/beliefs/:id/protect`) keep belief IDs out of logs. Errors go to `console.error`, degraded signals to `console.warn`, everything else to `console.log`, so severity filtering works in Workers Logs.

What is emitted:

- One `http` event per request: status, templated route, method, duration. These are the request/error/latency counters - count them by `status` and `route` in Workers Logs.
- `readiness` events for `/ready` polls.
- `cron` events: `started`, `completed`, `diary_failed` (the cron also rethrows, so the dashboard marks the trigger failed).
- `durable_object` events with reason codes: `writer_queue_saturated` (gauge `queue_depth`), `slow_mutation` (duration includes time spent waiting in the serialized writer queue, so it can fire on backlog alone, not only slow storage), `session_issuance_rate_limited`, `burst_rate_limited`, `quota_exhausted` (daily moves used up), `moderation_rejected`, `capacity_eviction` (gauges `evicted`, `tokens_used`), `ai_unavailable` (Workers AI call failed, e.g. free-tier quota), `diary_rejected`, `diary_written`.

## Endpoints

- `GET /health` - process liveness only. Safe for uptime monitors.
- `GET /ready` - checks D1 (`SELECT 1`) and the public-mind Durable Object. Returns 503 with per-dependency `checks` plus live `gauges` (`queue_depth`, `beliefs`, `tokens_used`, `sessions`). Use it for readiness polling and saturation snapshots.
- Every API response carries `x-correlation-id`. A caller-supplied ID is accepted only when it is a short safe token; otherwise the Worker generates one. Quote it in incident notes.

## Free-tier monitoring setup (no paid features)

Cloudflare (Worker side):

1. **Workers Logs** - enabled in `worker/wrangler.toml` (`[observability]`). Free plan includes 200,000 log events/day with 3-day retention. Invocation logs stay disabled for privacy (they record client IPs). Query from Workers > doxomachy > Observability > Logs.
2. **Dashboard metrics** - Workers > doxomachy > Metrics shows invocations, errors, duration and CPU time per period at no cost. Durable Object and D1 usage appear under their own dashboards.
3. **Cloudflare Notifications** - dash > Notifications > Add. The `workers_alert` type watches usage against thresholds (requests, CPU time, duration, egress) and delivers by email on all plans. Set this up once in the dashboard; it needs no code.
4. **Cron visibility** - a failed diary run appears under Workers > doxomachy > Triggers > Cron Triggers (past executions) because the scheduled handler rethrows on failure.

Vercel (frontend side): Hobby plan includes request logs and basic observability in the dashboard (Latency/breakdown metrics are paid Plus). Use `vercel logs --environment production --status-code 500 --json` for error sweeps. No native alerting on Hobby.

Optional (needs a user-approved account): a free external uptime monitor (e.g. UptimeRobot free tier) polling `https://doxomachy.matlabdec12.workers.dev/ready` every 5 minutes and alerting on non-200. That gives real paging without any Cloudflare/Vercel spend.

## Alert thresholds

Actionable starting points; tune after a week of real traffic. Sources: Workers Logs queries and the dashboard metrics above.

| Condition | Where | Action |
| --- | --- | --- |
| Any `/ready` 503 | readiness events / uptime monitor | Check `checks.database`/`checks.mind`, then Cloudflare status. Do not run migrations as a shortcut. |
| `cron` `diary_failed` or `ai_unavailable` / `diary_rejected` | Workers Logs | Check D1/DO/Workers AI health and free-tier AI quota. Rerun only after dependencies are healthy. Never copy diary input/output into logs or tickets. |
| 5xx events > 5% of `http` events in 15 min, or > 10 in 5 min | Workers Logs | Pull `x-correlation-id` samples, check `reason` codes, recent deploys. |
| p95 `duration_ms` > 1000 over 15 min | Workers Logs / dashboard | Check `writer_queue_saturated` and `slow_mutation` events; suspect DO serialization or D1 latency. |
| `writer_queue_saturated` with `queue_depth` >= 10 sustained, or any >= 50 | Workers Logs | Write backlog on the single public mind. Expect rising write latency; consider read-only mode messaging. |
| `session_issuance_rate_limited` > 50/hour | Workers Logs | Abuse wave or traffic spike. Verify the 10/hour per-IP issuance cap still holds; watch `capacity_eviction`. |
| `quota_exhausted` spikes | Workers Logs | Users hitting the 5 moves/day free cap; expected under growth, watch for anomalies. |
| `moderation_rejected` spikes | Workers Logs | Coordinated abuse or prompt-injection attempts against the diary input. |
| Log volume approaching 200k events/day | dashboard | Lower `head_sampling_rate` in `wrangler.toml` (e.g. 0.1) before the free cap is hit. |

## Release checks

From the repository root:

```sh
npm test
npm --prefix worker test
npm --prefix worker run typecheck
npm --prefix worker run dry-run
```

Review the dry-run bundle only. Deployment, migration application, secret changes, checkout enablement, and live webhook changes are separate, explicitly approved operations.

## Rollback

Revert the release commit and run the same checks. Deploying the rollback still requires explicit approval. Do not delete delivery, order, ledger or diary records. Preserve correlation IDs and timestamps in the incident note, without private or payment data.

## Auth pepper rotation

1. Generate a new pepper (32+ random bytes) and store a backup in the vault.
2. Set `AUTH_EMAIL_PEPPER_PREVIOUS` to the current pepper's value (append to the comma-separated ring if one is already set), then update `AUTH_EMAIL_PEPPER` to the new value and redeploy.
3. Existing accounts keep resolving through the ring and are lazily re-keyed to the new pepper on next sign-in. New sign-ins use the new pepper immediately.
4. Remove an old entry from the ring ONLY when its fingerprint is gone:

   ```
   wrangler d1 execute <db> --command "SELECT pepper_id, COUNT(*) FROM accounts GROUP BY pepper_id"
   ```

   `pepper_id` is the first 8 hex chars of `sha256('doxomachy-pepper:' + pepper)`. Compute an entry's fingerprint exactly:

   ```
   printf 'doxomachy-pepper:%s' "$OLD_PEPPER" | shasum -a 256 | cut -c1-8
   ```

   An entry is safe to drop when no account row carries that fingerprint. A dormant paid account may keep an old fingerprint indefinitely; dropping its ring entry orphans the account, so when in doubt, keep the entry.
