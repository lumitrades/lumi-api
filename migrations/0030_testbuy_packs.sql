-- Test-buy packs (Re-test pack, Founder pack). Additive only; apply BEFORE deploying the testbuy-packs branch.
-- 1) A pack purchase is a monitor_plans row (plan = 'retest_pack' | 'founder_pack', ends_at = 12-month expiry);
--    `credits` is the number of test-buys it bought. Null on every other plan, so existing rows are unaffected.
ALTER TABLE monitor_plans ADD COLUMN credits INTEGER;

-- 2) Fulfilment queue: one row per test-buy taken from a pack, run by hand / the operator box runner.
--    Balance of a pack = credits - jobs that are not 'cancelled' (a cancelled job returns its buy).
CREATE TABLE IF NOT EXISTS monitor_pack_jobs (
  id TEXT PRIMARY KEY,               -- mpj_<hex>
  plan_id TEXT NOT NULL,             -- monitor_plans.id of the pack
  enrollment_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,            -- enrolled seller endpoint URL
  day TEXT NOT NULL,                 -- UTC YYYY-MM-DD the job was queued
  status TEXT NOT NULL DEFAULT 'queued', -- queued | done | cancelled
  run_id INTEGER,                    -- monitor_runs.id once the box runner posts the result
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- One counted buy per endpoint per UTC day: a second live job for the same endpoint and day is refused.
CREATE UNIQUE INDEX IF NOT EXISTS monitor_pack_jobs_one_per_day ON monitor_pack_jobs (enrollment_id, endpoint, day) WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS monitor_pack_jobs_status ON monitor_pack_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS monitor_pack_jobs_plan ON monitor_pack_jobs (plan_id);

-- 3) Founder pack places, claimed atomically at settlement (not just in the pre-payment check).
--    At most 10 places (UNIQUE seat + CHECK 1..10; the insert is a single INSERT..SELECT that only adds a row while fewer
--    than 10 exist). Each company key ('pay:<payTo lowercased>' or 'dom:<registrable domain>') belongs to exactly one
--    place (PRIMARY KEY), so two enrolments sharing a wallet or a domain can never hold two places.
CREATE TABLE IF NOT EXISTS monitor_founder_places (
  place TEXT PRIMARY KEY,            -- fpl_<plan id of the first purchase>
  seat INTEGER NOT NULL UNIQUE CHECK (seat BETWEEN 1 AND 10),
  enrollment_id TEXT NOT NULL,       -- enrolment that took the place
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_founder_claims (
  key TEXT PRIMARY KEY,              -- pay:<payTo> | dom:<registrable domain>
  place TEXT NOT NULL REFERENCES monitor_founder_places(place),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monitor_founder_claims_place ON monitor_founder_claims (place);
-- Purchases per place, numbered 1..12 (PRIMARY KEY (place, n) + CHECK): a 13th purchase cannot be recorded.
CREATE TABLE IF NOT EXISTS monitor_founder_purchases (
  place TEXT NOT NULL REFERENCES monitor_founder_places(place),
  n INTEGER NOT NULL CHECK (n BETWEEN 1 AND 12),
  plan_id TEXT NOT NULL,
  paid_tx TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (place, n)
);

-- 4) Settled pack payments refused at settlement (a Founder place or purchase taken by a racing buyer). No credit is added.
--    Kept for manual review only: nothing is refunded automatically; any refund is an owner decision.
CREATE TABLE IF NOT EXISTS monitor_pack_refusals (
  paid_tx TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  reason TEXT NOT NULL,              -- founder_offer_full | founder_purchases_used
  paid_network TEXT NOT NULL,
  paid_asset TEXT NOT NULL,
  paid_amount TEXT NOT NULL,
  payer TEXT,
  usd REAL,
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
