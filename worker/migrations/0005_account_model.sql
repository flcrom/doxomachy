-- Account-only play: every move needs a signed-in account, accounts get a
-- small free-shield allowance, and deleting an account happens on our side.
-- Pure forward migration: only CREATE ... IF NOT EXISTS, safe to re-apply.
--
-- account_free_shields: free shields used per account (no row = none used).
-- The allowance itself (3) is configuration, not schema.
CREATE TABLE IF NOT EXISTS account_free_shields (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at INTEGER NOT NULL
);

-- spend_meta: what a pending/settled spend marker (paid_spends.key) took, so
-- refunding a failed move returns exactly that: `amount` credits, or one free
-- shield. Markers written before this migration have no row and mean 1 credit.
CREATE TABLE IF NOT EXISTS spend_meta (
  key    TEXT PRIMARY KEY,
  kind   TEXT NOT NULL CHECK (kind IN ('credit','free_shield')),
  amount INTEGER NOT NULL CHECK (amount >= 1)
);

-- Account deletion no longer deletes the accounts row. It tombstones it
-- (email_hmac = 'deleted:<id>', the only link to an email, is overwritten)
-- and removes sessions, links, spends, balance and free-shield rows. Order
-- rows keep pointing at the tombstone, so dodo_orders keeps its FK and needs
-- no rebuild, and nothing blocks deletion any more.
