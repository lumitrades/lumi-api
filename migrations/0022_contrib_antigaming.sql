-- Lumi Check v0 (DRAFT; NOT applied to production). Needs owner approval before `wrangler d1 migrations apply --remote`.
-- Score-gaming fixes for Lumi Check contributors:
--   * wallet-control proofs: unproven wallets (including every wallet registered before this migration) get zero weight
--     until the contributor sends a proof to POST /v1/contrib/me/wallet-proof;
--   * per-submission weight (0 = stored as evidence, no badge progress or confirmations) and why;
--   * funding-source index for the one-count-per-cluster-per-seller-per-day check;
--   * cache of first-funder lookups (Base explorer, XRPL activation, Stellar create_account) so each wallet is looked up once.
ALTER TABLE contributor_wallets ADD COLUMN proven INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contributor_submissions ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;
ALTER TABLE contributor_submissions ADD COLUMN weight_note TEXT;
CREATE INDEX IF NOT EXISTS contributor_submissions_source_day ON contributor_submissions (source, day);
CREATE TABLE IF NOT EXISTS wallet_funding (
  address TEXT PRIMARY KEY,
  funder TEXT,
  funded_at INTEGER,
  checked_at INTEGER NOT NULL
) WITHOUT ROWID;
