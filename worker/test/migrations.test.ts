import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * The exact set Wrangler forward-migrates: every .sql file under
 * worker/migrations, name-sorted. QA reproduction: a *.rollback.sql file in
 * this directory was executed by `wrangler d1 migrations apply`, dropping the
 * auth tables before 0002.sql recreated them empty - silent data destruction.
 * Rollback/destructive artifacts live in docs/runbooks/, never here.
 */
const discovered = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('migration directory safety (rollback must never forward-migrate)', () => {
  it('the Wrangler-discovered forward set contains no rollback or destructive artifact', () => {
    for (const file of discovered) {
      expect(file.toLowerCase()).not.toContain('rollback');
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      expect(sql, `${file} must be a pure forward migration`).not.toMatch(/\bDROP\s+(TABLE|TRIGGER|INDEX|VIEW)\b/i);
    }
    expect(discovered).toEqual(['0001.sql', '0002.sql', '0002_dodo_payments.sql', '0003_dodo_disputes.sql', '0004_diary_sources.sql', '0005_account_model.sql', '0006_profiles.sql']);
  });

  it('applying the discovered set in order, then re-applying it, preserves seeded auth data', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    const applyAll = () => {
      for (const file of discovered) db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    };
    applyAll();
    db.prepare('INSERT INTO accounts (id, email_hmac, created_at) VALUES (?, ?, ?)').run('acct-preserved', 'hmac-preserved', 1_758_000_000_000);
    db.prepare("INSERT INTO credits (subject, balance, updated_at) VALUES (?, ?, ?)").run('acct-preserved', 5, 1_758_000_000_000);
    applyAll(); // every forward migration is IF-NOT-EXISTS idempotent; data survives
    expect((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT balance FROM credits WHERE subject = ?').get('acct-preserved') as { balance: number }).balance).toBe(5);
    db.close();
  });
});
