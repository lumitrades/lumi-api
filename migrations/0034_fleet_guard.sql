-- Fleet guard / wallet pattern check (2026-11-19, DRAFT, not applied). No raw payer or member addresses are stored:
-- subject_hmac / payer_hmac are HMAC-SHA256 under the FLEET_GUARD_HMAC_SECRET Worker secret (during a rotation, lookups,
-- overrides and deletions also try FLEET_GUARD_HMAC_SECRET_PREV). Retention, nightly from the scheduled handler, whether or
-- not FLEET_GUARD is on: memberships 90 days from added_at (last load/reconfirm), clusters once empty, settles 90 days,
-- keys 30 days after expiry, the product's sales rows 90 days. Overrides are the correction/exclusion record and are kept.
-- No counts, first-seen dates or member lists are stored for clusters.
CREATE TABLE IF NOT EXISTS fleet_guard_clusters (
  id TEXT PRIMARY KEY,              -- "F1", never a name
  basis TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_guard_members (
  subject_hmac TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('payer','seller')),
  subject_kind TEXT NOT NULL,         -- address kind or "domain"; decides "No match" vs "Insufficient data"
  added_at INTEGER NOT NULL           -- last load or reconfirmation; the 90-day clock and the label's as-of date
);
CREATE INDEX IF NOT EXISTS idx_fleet_guard_members_added ON fleet_guard_members (added_at);
CREATE INDEX IF NOT EXISTS idx_fleet_guard_members_cluster ON fleet_guard_members (cluster_id);
CREATE TABLE IF NOT EXISTS fleet_guard_overrides (
  subject_hmac TEXT PRIMARY KEY,      -- owner correction (dispute) or exclusion; wins over any membership
  label TEXT NOT NULL CHECK (label IN ('No match','Insufficient data')),
  created_at INTEGER NOT NULL
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
