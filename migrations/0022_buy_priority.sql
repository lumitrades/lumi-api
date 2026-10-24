-- Check-driven test-buy priority: at most one slot per seller (host) per UTC day, and at most N sellers per day
-- (TRUST_PRIORITY_DAILY_CAP, default 5). Written by free and paid checks alike; payment never changes the order.
CREATE TABLE IF NOT EXISTS buy_priority (
  day TEXT NOT NULL,        -- UTC day, YYYY-MM-DD
  seller TEXT NOT NULL,     -- seller host (catalog_buys.domain)
  resource TEXT NOT NULL,   -- the listing that got the slot
  at INTEGER NOT NULL,
  PRIMARY KEY (day, seller)
) WITHOUT ROWID;
