-- 90-day retention for Base payer data (2026-10-28).
-- base_inflow (one running total per payTo+payer, never pruned) is replaced by base_inflow_daily: one row per
-- payTo + payer + UTC day. The catalog cron deletes days older than 90 days once a day (INFLOW_RETENTION_DAYS),
-- so no payer row is kept for longer than about 90 days after the day it was recorded.
-- The (payer, last_ts) index serves the free wallet check (GET /v1/wallet/check), a read only: the queried wallet is never written.
CREATE TABLE IF NOT EXISTS base_inflow_daily (
  pay_to TEXT NOT NULL,                -- lowercased
  payer TEXT NOT NULL,                 -- lowercased Transfer `from`
  day TEXT NOT NULL,                   -- UTC day of the payments (YYYY-MM-DD)
  n INTEGER NOT NULL,
  units INTEGER NOT NULL,              -- USDC base units (6 decimals)
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  first_block INTEGER NOT NULL,
  last_tx TEXT,
  PRIMARY KEY (pay_to, payer, day)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS base_inflow_daily_payer ON base_inflow_daily (payer, last_ts);
-- Existing running totals move over as one row dated by their FIRST payment, so they roll off 90 days after it (the stricter end).
INSERT OR IGNORE INTO base_inflow_daily (pay_to, payer, day, n, units, first_ts, last_ts, first_block, last_tx)
  SELECT pay_to, payer, strftime('%Y-%m-%d', first_ts / 1000, 'unixepoch'), n, units, first_ts, last_ts, first_block, last_tx FROM base_inflow;
-- The old table is emptied, not dropped, so an older Worker version still runs if rolled back (the cron prunes it too).
DELETE FROM base_inflow;
