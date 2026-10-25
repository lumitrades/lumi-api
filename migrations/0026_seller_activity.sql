-- Per-seller verified customer activity (information only; never a scoring input and never pay-to-play).
-- One row per seller with 30-day counts read from public on-chain payments to the seller's payTo addresses:
-- unique payers, x402-sized (< $1) customer payments, last payment time, and the top payer's share (private).
-- Lumi's own buyer wallets are excluded before rows reach this table. No payer wallet address is ever stored.
-- total_usd_30d and top_payer_share are private (owner-only routes); public responses show counts, the last payment date
-- and a concentration flag only.
-- Additive only (two new tables, IF NOT EXISTS). Apply to prod D1 BEFORE deploying the Worker that reads them.
-- Writes: the owner ingest endpoint upserts only rows whose content changed (fingerprint), and rewrites a seller's
-- lookup keys only when its domains/payTos changed.
CREATE TABLE IF NOT EXISTS seller_activity (
  seller TEXT PRIMARY KEY,             -- seller label from the research run (e.g. primary domain)
  domains TEXT NOT NULL,               -- space-separated, lowercased
  pay_to TEXT NOT NULL,                -- space-separated payTo addresses (lowercased), the seller's own receiving addresses
  payers_30d INTEGER,                  -- unique customer payers in the window
  payments_30d INTEGER,                -- x402-sized (< $1) customer payments in the window
  total_usd_30d REAL,                  -- PRIVATE: x402-sized customer payment total (owner-only)
  top_payer_share REAL,                -- PRIVATE: 0..1 share of x402-sized value from the single largest payer (owner-only)
  last_payment_at INTEGER,             -- ms epoch of the latest x402-sized customer payment seen
  window_end INTEGER NOT NULL,         -- ms epoch the 30-day window ends (data as of)
  source TEXT,
  fp TEXT NOT NULL,                    -- content fingerprint: unchanged rows are not rewritten
  kfp TEXT NOT NULL,                   -- lookup-key fingerprint: keys rewritten only when domains/payTos change
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Lookup keys -> seller: "d:<domain>" and "p:<payTo>".
CREATE TABLE IF NOT EXISTS seller_activity_keys (
  k TEXT PRIMARY KEY,
  seller TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS seller_activity_keys_seller ON seller_activity_keys (seller);
