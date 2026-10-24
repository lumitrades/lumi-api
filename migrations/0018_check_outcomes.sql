-- Lumi Check v0 (DRAFT; NOT applied to production).
-- Tier-1 anonymous delivery outcomes: per-day, per-subject counters only (no wallet, amount, tx, URL query, payload, IP or client id).
-- Raw rows: deleted 90 days after their day, only once rolled up (0019). WITHOUT ROWID: one B-tree, no extra index writes.
CREATE TABLE IF NOT EXISTS check_outcomes (
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
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
