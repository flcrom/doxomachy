-- Optional public identity for an account. The display name (letters,
-- numbers, dashes) shows immediately. A profile image or link is stored as
-- *_pending until the owner approves it from the review email, and only
-- approved values are ever served. public_id is what beliefs carry, so the
-- account UUID never appears in public data.
CREATE TABLE IF NOT EXISTS account_profiles (
  account_id    TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  public_id     TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  image         TEXT,            -- approved image as a data URL (small, resized in the browser)
  image_pending TEXT,
  link          TEXT,            -- approved https link
  link_pending  TEXT,
  updated_at    INTEGER NOT NULL
);
