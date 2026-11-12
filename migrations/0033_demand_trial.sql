-- Demand-test trial keys (2026-11-12): issued keys that waive payment on paid trust routes until 21 Nov 2026 11:59 PM CT.
-- Usage is logged here, not in sales. Trial calls are never revenue (no sales row, no tx).
CREATE TABLE IF NOT EXISTS demand_trial_keys (
  key_hash TEXT PRIMARY KEY,           -- SHA-256 hex of the key; the plaintext key is never stored
  label TEXT NOT NULL,                 -- builder slug (not a secret)
  cap INTEGER NOT NULL DEFAULT 50,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,         -- ms since epoch (21 Nov 2026 23:59:59.999 America/Chicago)
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS demand_trial_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  route TEXT NOT NULL,
  path TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demand_trial_uses_label_ts ON demand_trial_uses (label, ts);
CREATE INDEX IF NOT EXISTS idx_demand_trial_uses_hash_ts ON demand_trial_uses (key_hash, ts);
