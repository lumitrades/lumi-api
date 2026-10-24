-- Oct 24 2026: signed XRPL test payments a seller's endpoint did not accept (the tx never reached the ledger).
-- Informational only: shown as payment_attempts on /v1/trust/vendors for vendors that opt in via
-- label_unsettled_payments (src/vendors.ts) while Lumi has no paid test-buy of them. Never scored.
CREATE TABLE IF NOT EXISTS unsettled_attempts (
  tx_hash TEXT PRIMARY KEY,      -- the signed (never validated) XRPL Payment hash
  vendor_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  ts INTEGER NOT NULL,           -- ms since epoch, when Lumi signed and sent it
  network TEXT NOT NULL,
  amount TEXT,
  asset TEXT,
  http_status INTEGER,           -- seller's answer to the paid request
  detail TEXT
);
CREATE INDEX IF NOT EXISTS unsettled_attempts_vendor ON unsettled_attempts (vendor_id, ts);

-- Backfill from Lumi's own run logs (each hash re-checked: txnNotFound on XRPL mainnet, Oct 24 2026).
INSERT OR IGNORE INTO unsettled_attempts (tx_hash, vendor_id, endpoint, ts, network, amount, asset, http_status, detail) VALUES
 ('4D8116AF1972C269104507B344CFF49577CBD8B1EB6025588FCBBA17FE54A719', 'edge-agents', 'https://pay.edge-agents.ai/v1/services/macro-no-inflation', 1792724928615, 'xrpl:0', '0.01', 'RLUSD', 402, 'HTTP 402: No matching payment requirements'),
 ('784D0F69B69DA2834D53AC888A47B79E4028D4E9CEA4AE5229586979BA536393', 'edge-agents', 'https://pay.edge-agents.ai/v1/services/macro-no-inflation', 1792727271058, 'xrpl:0', '0.01', 'RLUSD', 402, 'HTTP 402: No matching payment requirements'),
 ('7DAC6138D26712FDA0421BC8FA064812A6255E22E35386AE989333981AD3218A', 'edge-agents', 'https://pay.edge-agents.ai/v1/services/perp-funding-rates', 1792747721213, 'xrpl:0', '0.01', 'RLUSD', 402, 'HTTP 402: No matching payment requirements'),
 ('1099E7F81ECCAF1569DD8EFF599124681E5B90130030C0F45B58D2A7624AE904', 'edge-agents', 'https://pay.edge-agents.ai/v1/services/perp-funding-rates', 1792833907491, 'xrpl:0', '0.01', 'RLUSD', 402, 'HTTP 402: No matching payment requirements');
