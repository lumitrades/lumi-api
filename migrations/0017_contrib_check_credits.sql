-- Lumi Check v0 (DRAFT, branch scanner-kit-v0; NOT applied to production).
-- Free Lumi Check credits: redemptions only. The earn side is derived from verified contributor_submissions
-- (one per contributor, seller and UTC day), so a dispute reverses it. Purged with the 90-day retention.
CREATE TABLE IF NOT EXISTS contributor_credit_spends (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  product TEXT NOT NULL,
  cost INTEGER NOT NULL,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS contributor_credit_spends_key_day ON contributor_credit_spends (key_id, day);
CREATE INDEX IF NOT EXISTS contributor_credit_spends_day ON contributor_credit_spends (day);
