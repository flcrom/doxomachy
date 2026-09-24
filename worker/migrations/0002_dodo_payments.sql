-- Dodo Payments test-mode integration, rev 4.
-- Durable leased webhook inbox, auth-scoped orders, per-payment locks,
-- idempotent checkout intents, refund records, minimized payload retention.
--
-- Exactly-once is structural: webhook_inbox dedupes deliveries by webhook-id
-- behind an owner-token lease; credit_ledger references are unique;
-- payment_locks serialize every entitlement transition for one payment.
--
-- credits(subject, balance) from 0001 is the balance row SHARED WITH THE AUTH
-- LANE (its spend/refund paths mutate balance directly). Payments therefore
-- applies ADDITIVE deltas floored at zero and never recomputes an absolute
-- balance from its own ledger, which would clobber auth-lane spends.
-- credit_ledger.balance_applied bridges a crash between the ledger insert and
-- the balance mutation: the reconciler re-applies any delta whose flag is 0.
--
-- account_sessions is OWNED BY THE AUTH LANE (its migration); not declared
-- here. 0001 `webhook_events` is superseded by webhook_inbox and untouched.
--
-- rev 4 ownership FKs (proposed policy; owner confirmation PENDING - no sign-off on record): apply AFTER the auth migration
-- (0002.sql creates accounts; filename sort guarantees order).
--  - dodo_orders.account_id    REFERENCES accounts(id), default NO ACTION
--    (= RESTRICT): financial history blocks account deletion at the DB
--    level; closing an account with orders must settle/refund + archive
--    first (ops flow), and the DB enforces it.
--  - checkout_intents.account_id REFERENCES accounts(id) ON DELETE CASCADE:
--    intents are ephemeral checkout state and die with the account.
--  - dodo_refunds.payment_id deliberately has NO FK: refunds must be
--    recordable before/without a resolved order because grant-suppression
--    caps depend on them; linkage is enforced by the reconciler's
--    refund_without_order drift check instead.
--  - credit_ledger.subject has NO FK: suppression markers use 'unmatched'.
-- Apply order: 0001.sql, 0002.sql (auth), then this file.

CREATE TABLE IF NOT EXISTS webhook_inbox (
  webhook_id  TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     TEXT,                  -- minimized verified event JSON; NULL after completion (no indefinite PII retention)
  status      TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
  claim_token TEXT,                  -- owner token of the active attempt; NULL when unclaimed
  claimed_at  INTEGER,               -- lease start (ms epoch); stale leases are stealable
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  outcome     TEXT,
  error       TEXT,
  received_at INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_status ON webhook_inbox (status);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_updated ON webhook_inbox (updated_at);

CREATE TABLE IF NOT EXISTS payment_locks (
  payment_id  TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,          -- unique token per acquisition
  acquired_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dodo_orders (
  session_id   TEXT PRIMARY KEY,      -- Dodo checkout session id ('recovered:<payment_id>' when reconciled without one)
  account_id   TEXT NOT NULL REFERENCES accounts(id), -- NO ACTION (= RESTRICT): orders block account deletion (see header)
  payment_id   TEXT,
  business_id  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('created','succeeded','failed','cancelled','partially_refunded','refunded','disputed','quarantined')),
  product_id   TEXT NOT NULL,
  credits      INTEGER NOT NULL CHECK (credits > 0),
  total_amount INTEGER CHECK (total_amount IS NULL OR total_amount >= 0),
  currency     TEXT,
  quarantine_reason TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- payment_id unique whenever present: column-level UNIQUE so the constraint is
-- targetable by name; SQLite UNIQUE permits any number of NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dodo_orders_payment ON dodo_orders (payment_id);
CREATE INDEX IF NOT EXISTS idx_dodo_orders_account ON dodo_orders (account_id);
CREATE INDEX IF NOT EXISTS idx_dodo_orders_status ON dodo_orders (status);

CREATE TABLE IF NOT EXISTS dodo_refunds (
  refund_id    TEXT PRIMARY KEY,
  payment_id   TEXT NOT NULL,
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0), -- NULL = amount unknown
  currency     TEXT,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dodo_refunds_payment ON dodo_refunds (payment_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  reference  TEXT PRIMARY KEY,        -- grant:<payment_id> | revoke:refund:<payment_id>:<refund_id>
                                      -- | revoke:dispute:<payment_id> | regrant:dispute:<payment_id>
                                      -- | quarantine:<payment_id>
  subject    TEXT NOT NULL,           -- account UUID ('unmatched' for suppression markers)
  payment_id TEXT,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,           -- webhook event type that caused it
  balance_applied INTEGER NOT NULL DEFAULT 0 CHECK (balance_applied IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_subject ON credit_ledger (subject);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_payment ON credit_ledger (payment_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_pending ON credit_ledger (balance_applied) WHERE balance_applied = 0;

CREATE TABLE IF NOT EXISTS checkout_intents (
  intent_key   TEXT PRIMARY KEY,      -- account_id || ':' || caller idempotency key
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, -- ephemeral: dies with the account
  status       TEXT NOT NULL CHECK (status IN ('pending','created','failed','recovered','abandoned','needs_reconciliation')),
  session_id   TEXT,
  checkout_url TEXT,
  payment_id   TEXT,
  product_id   TEXT NOT NULL,
  credits      INTEGER NOT NULL CHECK (credits > 0),
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
