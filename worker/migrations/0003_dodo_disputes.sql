-- Doxomachy Dodo Payments (test mode): dispute records.
--
-- Disputes get the same integrity treatment as refunds (0002_dodo_payments):
-- the record is keyed by dispute_id, the payment identity (payment_id, and
-- amount/currency when present) is IMMUTABLE once recorded, and status moves
-- only through an explicit transition table with won/lost/cancelled/expired
-- terminal. A stale event (e.g. dispute.opened delivered after dispute.won)
-- is REJECTED: no state change, no entitlement effect, drift marker only.
--
-- payment_id deliberately has NO FK, mirroring dodo_refunds: a dispute must be
-- recordable before/without a resolved order so grant suppression can see it.
-- Apply order: 0001.sql, 0002.sql (auth), 0002_dodo_payments.sql, this file.

CREATE TABLE IF NOT EXISTS dodo_disputes (
  dispute_id   TEXT PRIMARY KEY,
  payment_id   TEXT NOT NULL,                    -- bound at first sight, immutable
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor >= 0), -- NULL = unknown
  currency     TEXT,                             -- NULL = unknown; immutable once set
  status       TEXT NOT NULL CHECK (status IN ('opened','challenged','accepted','won','lost','cancelled','expired')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dodo_disputes_payment ON dodo_disputes (payment_id);
