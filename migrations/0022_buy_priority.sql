-- Check-driven test-buy priority: at most one slot per seller (host) per 30 days, and at most N sellers per day
-- (TRUST_PRIORITY_DAILY_CAP, default 5). Written by free and paid checks alike; payment never changes the order.
CREATE TABLE IF NOT EXISTS buy_priority (
  day TEXT NOT NULL,        -- UTC day, YYYY-MM-DD
  seller TEXT NOT NULL,     -- seller host (catalog_buys.domain)
  resource TEXT NOT NULL,   -- the listing that got the slot
  at INTEGER NOT NULL,
  PRIMARY KEY (day, seller)
) WITHOUT ROWID;
-- Once per seller per 30 days: claimPriority looks up the seller's latest slot.
CREATE INDEX IF NOT EXISTS buy_priority_seller_at ON buy_priority (seller, at);
