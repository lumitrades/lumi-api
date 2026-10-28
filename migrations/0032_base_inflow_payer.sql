-- Free wallet check (GET /v1/wallet/check, 2026-10-28, branch only): read base_inflow by payer.
-- An index only: no new data is stored, and the queried wallet is never written.
CREATE INDEX IF NOT EXISTS base_inflow_payer ON base_inflow (payer, last_ts);
