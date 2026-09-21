-- Rollback for 0002.sql (magic-link auth). Apply only after the Worker no
-- longer serves /v1/auth/* or /v1/credits. Destroys all auth data.
DROP TRIGGER IF EXISTS accounts_delete_credit_guard;
DROP TABLE IF EXISTS paid_spends;
DROP TABLE IF EXISTS auth_rate_limits;
DROP TABLE IF EXISTS account_sessions;
DROP TABLE IF EXISTS magic_links;
DROP TABLE IF EXISTS accounts;
