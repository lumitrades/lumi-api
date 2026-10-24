-- Lumi Check v0 (DRAFT, branch scanner-kit-v0; NOT applied to production).
-- Nightly rollup of tier-1 raw counters (check_outcomes) into long-term daily summaries, kept forever.
-- Raw rows are deleted after 90 days, and only for days recorded here as rolled up and clean (dirty = 0).
-- D1 cost: all access is by primary key or the two partial indexes below; no full-table scans.
CREATE TABLE IF NOT EXISTS check_outcome_daily (
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  checks INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  s_2xx INTEGER NOT NULL DEFAULT 0,
  s_3xx INTEGER NOT NULL DEFAULT 0,
  s_4xx INTEGER NOT NULL DEFAULT 0,
  s_5xx INTEGER NOT NULL DEFAULT 0,
  s_timeout INTEGER NOT NULL DEFAULT 0,
  s_network INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, subject)
) WITHOUT ROWID;

-- One row per rolled-up UTC day (about 365 rows a year).
CREATE TABLE IF NOT EXISTS check_rollup_days (
  day TEXT PRIMARY KEY,
  rolled_at INTEGER NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0,
  purged_at INTEGER
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS check_rollup_days_dirty ON check_rollup_days (day) WHERE dirty = 1;
CREATE INDEX IF NOT EXISTS check_rollup_days_unpurged ON check_rollup_days (day) WHERE purged_at IS NULL;
