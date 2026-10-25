-- Free "probe-checked" seller tier (checked, not test-bought). Additive only. One small row per seller (registrable domain),
-- rewritten only when the outcome changes or once a day. No payTo, amounts, balances or counterparties are stored here.
CREATE TABLE IF NOT EXISTS probe_checked (
  seller TEXT PRIMARY KEY,           -- registrable domain (tenant host on shared platforms)
  checked_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,             -- pass | partial | fail | not_checked
  checks TEXT NOT NULL,              -- compact JSON {check_id: pass|fail|unknown}
  notes TEXT NOT NULL,               -- JSON array of neutral notes
  endpoints_checked INTEGER NOT NULL,
  endpoints_quoting INTEGER NOT NULL,
  median_latency_ms INTEGER,
  score_weight REAL NOT NULL,        -- capped at PROBE_MAX_WEIGHT (0.25); never an input when a delivered test-buy exists
  rules_version TEXT NOT NULL
) WITHOUT ROWID;
