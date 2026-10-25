-- Human review before a test-buy based "checks_failed" is published, and seller re-test requests (legal review 2026-10-25,
-- M14 and §3.4). Additive only. Until a person approves a row, /v1/check and /v1/verdict show "check_first"
-- (checks_failed_pending_review). An open re-test request pauses checks_failed for up to 72 hours while Lumi re-buys.
-- One pending row is written the first time a seller's evidence crosses the bar (INSERT OR IGNORE; no write per request).
CREATE TABLE IF NOT EXISTS verdict_reviews (
  host TEXT NOT NULL,
  evidence TEXT NOT NULL,          -- reason code + start of the failing streak (or the resource), so new evidence re-opens review
  state TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  codes TEXT NOT NULL,
  relationship TEXT,               -- disclosed to the reviewer (competitor/customer/paying_seller); never an input to the label
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  note TEXT,
  PRIMARY KEY (host, evidence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS verdict_reviews_state ON verdict_reviews (state, created_at);

CREATE TABLE IF NOT EXISTS verdict_appeals (
  host TEXT PRIMARY KEY,
  opened_at INTEGER NOT NULL,
  until_at INTEGER NOT NULL,       -- opened_at + 72 h
  source TEXT NOT NULL,            -- email | contact_form | signed_reply | owner
  reply TEXT,                      -- the seller's reply, shown in /v1/verdict (public)
  rebuy TEXT                       -- outcome of the re-buy request (queued / not_base / ...)
) WITHOUT ROWID;
