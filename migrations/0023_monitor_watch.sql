-- Per-endpoint Watch plans (Watch $5 / Watch Plus $12 / Watch Pro $20 per endpoint per 30 days), the free Watch tier,
-- the one-per-seller 14-day Watch Plus trial, and daily uptime rollups from the operator-box quote probe.
-- Additive only: existing monitor / monitor_plus / audit rows are untouched and keep working to their term end.
-- Numbered 0023: 0015-0022 are taken on other local branches (scanner-kit-v0 uses 0015-0022, free-check-priority 0022). Renumber when merging.
-- NOT applied anywhere yet. Apply to prod D1 BEFORE deploying the Worker that writes these columns.

-- Endpoint count a Watch plan row covers (NULL = legacy semantics: plan id decides) and its per-endpoint price.
ALTER TABLE monitor_plans ADD COLUMN endpoints INTEGER;
ALTER TABLE monitor_plans ADD COLUMN unit_usd REAL;

-- One Watch Plus trial per seller: a domain and a payTo can each start at most one trial, ever.
CREATE TABLE IF NOT EXISTS monitor_trials (
  id TEXT PRIMARY KEY,                 -- mtr_<hex>
  enrollment_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,               -- the watch_plus_trial plan row
  domain_lc TEXT NOT NULL UNIQUE,      -- registrable domain the seller proved (well-known file or DNS TXT)
  pay_to_lc TEXT NOT NULL UNIQUE,      -- payTo proven by signature in the same challenge
  nonce TEXT NOT NULL UNIQUE,          -- single-use challenge nonce
  proof TEXT NOT NULL,                 -- JSON: challenge, signature, public_key, signer, domain method
  created_at INTEGER NOT NULL
);

-- Daily probe rollups: one row per enrolment, endpoint and UTC day (posted once a day by the box runner).
CREATE TABLE IF NOT EXISTS monitor_uptime_daily (
  enrollment_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  day TEXT NOT NULL,                   -- YYYY-MM-DD (UTC)
  checks INTEGER NOT NULL,
  ok INTEGER NOT NULL,                 -- checks that returned a valid x402 quote paying the enrolled payTo
  p50_ms INTEGER,
  p95_ms INTEGER,
  quote_amount TEXT,
  quote_asset TEXT,
  quote_pay_to TEXT,
  PRIMARY KEY (enrollment_id, endpoint, day)
) WITHOUT ROWID;
