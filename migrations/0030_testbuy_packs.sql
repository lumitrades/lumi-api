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
