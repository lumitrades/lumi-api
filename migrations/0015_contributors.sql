-- Lumi Scanner Kit v0: contributor keys and contributed test data. DRAFT on branch scanner-kit-v0; NOT applied to production.
-- Write cost per ACCEPTED submission: 1 row + 2 index entries in contributor_submissions, plus 1 row on the
-- contributions-only daily counter (meta k = 'contrib_writes:YYYY-MM-DD'). That counter is separate from the catalog
-- 'writes:' counter, so contributions can never use up catalog ingest/probe/evidence budget. Inserts go through the
-- lumi-contrib-writes queue in batches when it is bound. Rejected submissions write nothing.
-- Credits are derived (SUM over submissions): no credits table and no cash payout of any kind.
CREATE TABLE IF NOT EXISTS contributor_keys (
  key_id TEXT PRIMARY KEY,                 -- lck_<16 hex>
  label TEXT NOT NULL,                     -- owner-chosen name, e.g. "Lumi Scout"
  public_key TEXT NOT NULL,                -- ed25519 public key (64 hex); the private key never leaves the contributor
  wallets TEXT NOT NULL,                   -- JSON array of payer addresses this key may submit receipts for
  own_domains TEXT NOT NULL DEFAULT '[]',  -- JSON array of hosts the contributor operates (self-testing guard)
  daily_cap INTEGER,                       -- optional per-key override of accepted submissions per UTC day
  share_demand INTEGER NOT NULL DEFAULT 0, -- 1 = contributor opted in to aggregate-only demand stats
  status TEXT NOT NULL DEFAULT 'active',   -- active | revoked
  forfeited INTEGER NOT NULL DEFAULT 0,    -- 1 = unpaid credits forfeited (fraud/abuse)
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT
) WITHOUT ROWID;

-- One row per wallet so a wallet belongs to at most one key. source = funding source used by the anti-boost caps
-- (the account that funded this wallet, one hop through other contributor wallets; the wallet itself if unknown).
CREATE TABLE IF NOT EXISTS contributor_wallets (
  address TEXT PRIMARY KEY,                -- EVM lowercased, XRPL/Stellar as-is
  key_id TEXT NOT NULL,
  funder TEXT,
  funded_at INTEGER,
  source TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS contributor_submissions (
  tx_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  day TEXT NOT NULL,                       -- UTC YYYY-MM-DD of acceptance
  created_at INTEGER NOT NULL,
  mode TEXT NOT NULL,                      -- passive | test_buy
  kit_version TEXT,
  endpoint TEXT NOT NULL,
  endpoint_key TEXT NOT NULL,              -- first 32 hex of sha256(endpoint)
  domain TEXT,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  payer TEXT NOT NULL,
  source TEXT NOT NULL,                    -- payer's funding source (anti-boost)
  new_wallet INTEGER NOT NULL DEFAULT 0,   -- payer funded < 30 days before the submission
  receipt_hash TEXT NOT NULL,
  http_status INTEGER,
  outcome TEXT,
  finding TEXT NOT NULL,                   -- counted | unconfirmed | confirmed | held | disputed | contradicted
  wanted INTEGER NOT NULL DEFAULT 0,
  demand_opt_in INTEGER NOT NULL DEFAULT 0,
  ledger_ts INTEGER,
  credit_uusd INTEGER NOT NULL DEFAULT 0,  -- credits in micro-USD units (credits only, never cash)
  credit_note TEXT,
  dispute TEXT,                            -- JSON {at, reason, by} when the seller disputes
  metrics TEXT,                            -- JSON, validated and clamped (<= 2 KB)
  receipt TEXT NOT NULL                    -- the signed receipt JSON
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS contributor_submissions_key_day ON contributor_submissions (key_id, day);
CREATE INDEX IF NOT EXISTS contributor_submissions_ep_day ON contributor_submissions (endpoint_key, day);
