-- Lumi Check v0 (DRAFT; NOT applied to production).
-- Accounts are kept while active: last_active_day = UTC day of the last accepted receipt (one write per key per day at most).
ALTER TABLE contributor_keys ADD COLUMN last_active_day TEXT;
