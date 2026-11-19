-- Customer payer retention: HMAC columns so a wallet can still be matched after the raw
-- address is nulled, and an erasure-request log that stores only the HMAC. Additive.
-- Existing rows keep their raw values until the nightly purge (or an owner deletion).
-- Keep tx, amount, asset, date and route for accounting. See src/payer_retention.ts.

ALTER TABLE sales ADD COLUMN payer_hmac TEXT;
ALTER TABLE feed_keys ADD COLUMN wallet_hmac TEXT;
ALTER TABLE feed_payments ADD COLUMN payer_hmac TEXT;
ALTER TABLE monitor_plans ADD COLUMN payer_hmac TEXT;
ALTER TABLE monitor_pack_refusals ADD COLUMN payer_hmac TEXT;
ALTER TABLE trial_uses ADD COLUMN wallet_hmac TEXT;

CREATE INDEX IF NOT EXISTS sales_payer_hmac ON sales (payer_hmac);
CREATE INDEX IF NOT EXISTS feed_keys_wallet_hmac ON feed_keys (wallet_hmac);
CREATE INDEX IF NOT EXISTS feed_payments_payer_hmac ON feed_payments (payer_hmac);
CREATE INDEX IF NOT EXISTS monitor_plans_payer_hmac ON monitor_plans (payer_hmac);
CREATE INDEX IF NOT EXISTS monitor_pack_refusals_payer_hmac ON monitor_pack_refusals (payer_hmac);
CREATE INDEX IF NOT EXISTS trial_uses_wallet_hmac ON trial_uses (wallet_hmac);

-- Owner access / deletion audit: hmac of the submitted wallet, counts only, never a raw address.
CREATE TABLE IF NOT EXISTS payer_erasure_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  wallet_hmac TEXT NOT NULL,
  raw_nulled INTEGER NOT NULL,
  tables_json TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS payer_erasure_ts ON payer_erasure_requests (ts);
