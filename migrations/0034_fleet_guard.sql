-- Fleet guard (2026-11-19, DRAFT, not applied). No raw payer or member addresses are stored: subject_hmac / payer_hmac are
-- HMAC-SHA256 under the FLEET_GUARD_HMAC_SECRET Worker secret. Retention: settles 90 days, keys 30 days after expiry
-- (purgeFleetGuard from the scheduled handler).
CREATE TABLE IF NOT EXISTS fleet_guard_clusters (
  id TEXT PRIMARY KEY,              -- "F1", never a name
  wallets INTEGER NOT NULL,
  sellers_paid INTEGER NOT NULL,
  first_seen TEXT,
  basis TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_guard_members (
  subject_hmac TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('payer','seller')),
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_guard_settles (
  tx_hash TEXT PRIMARY KEY,          -- each settled payment serves exactly once
  route TEXT NOT NULL,
  payer_hmac TEXT,
  settled_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fleet_guard_settles_at ON fleet_guard_settles (settled_at);
CREATE TABLE IF NOT EXISTS fleet_guard_keys (
  key_hash TEXT PRIMARY KEY,         -- SHA-256 of the key; plaintext shown once
  plan TEXT NOT NULL,
  calls INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  paid_tx TEXT NOT NULL UNIQUE,      -- credits tied to exactly one settled payment
  payer_hmac TEXT,
  created_at INTEGER NOT NULL,
  CHECK (used <= calls)
);
CREATE INDEX IF NOT EXISTS idx_fleet_guard_keys_exp ON fleet_guard_keys (expires_at);
