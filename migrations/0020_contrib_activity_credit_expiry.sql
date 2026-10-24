-- Lumi Check v0 (DRAFT, branch scanner-kit-v0; NOT applied to production).
-- Accounts are kept while active: last_active_day = UTC day of the last accepted receipt or signed check (one write per key per day at most).
ALTER TABLE contributor_keys ADD COLUMN last_active_day TEXT;
-- Credits expire 90 days after they were earned: each spend records the earned lots it consumed (JSON [{lot, n}], oldest first).
ALTER TABLE contributor_credit_spends ADD COLUMN alloc TEXT;
