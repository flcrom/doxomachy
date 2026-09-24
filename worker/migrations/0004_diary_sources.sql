-- Diary backup: the beliefs each UTC day's diary is written from, captured
-- on that day's first scheduled attempt. If generation fails, later ticks
-- regenerate from this frozen copy, including after the day has ended, so a
-- day is never lost to an AI outage or a rejected draft. Pending days are
-- written oldest-first, so cycle numbers stay in day order.
CREATE TABLE IF NOT EXISTS diary_sources (
  day         TEXT PRIMARY KEY,            -- UTC day key, YYYY-MM-DD
  beliefs     TEXT NOT NULL,               -- JSON array of the beliefs at capture time
  captured_at INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','written','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  diary_cycle TEXT,                        -- diaries.cycle once written
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS diary_sources_status_day ON diary_sources (status, day);
