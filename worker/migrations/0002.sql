CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email_hmac TEXT NOT NULL UNIQUE, pepper_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS magic_links (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), email_hmac TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, consume_key TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS magic_links_email ON magic_links(email_hmac);
CREATE INDEX IF NOT EXISTS magic_links_expiry ON magic_links(expires_at);
CREATE TABLE IF NOT EXISTS account_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS account_sessions_account ON account_sessions(account_id);
CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_rate_limits_window ON auth_rate_limits(window_start);
CREATE TABLE IF NOT EXISTS paid_spends (key TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, resolved_at INTEGER, resolver TEXT);
CREATE INDEX IF NOT EXISTS paid_spends_created ON paid_spends(created_at);
CREATE INDEX IF NOT EXISTS paid_spends_pending ON paid_spends(account_id, status, created_at);
CREATE INDEX IF NOT EXISTS paid_spends_stale ON paid_spends(status, created_at);

-- Atomic deletion guard: a credit grant racing a deletion pre-check aborts
-- the account delete, and D1 rolls the whole batch (sessions, links, spends,
-- rate rows, credits) back with it. The caller maps the abort to
-- credits_remaining. References the credits table from 0001.
CREATE TRIGGER IF NOT EXISTS accounts_delete_credit_guard BEFORE DELETE ON accounts
WHEN EXISTS (SELECT 1 FROM credits WHERE subject = OLD.id AND balance > 0)
BEGIN
  SELECT RAISE(ABORT, 'credits_remaining');
END;
