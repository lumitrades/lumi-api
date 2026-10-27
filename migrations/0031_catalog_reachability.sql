-- Listing reachability (dead-listing flags). Additive only; apply BEFORE deploying the dead-listing-flags branch
-- (the Worker reads these columns in every catalog SELECT).
-- One row per listing, updated in place (never appended): the latest check and the current run of failed checks.
-- ADD COLUMN on SQLite is a schema-only change: no table rewrite, existing rows read NULL (= not checked this way yet).
ALTER TABLE catalog ADD COLUMN reach_at INTEGER;        -- ms, last reachability check (free quote check or test-buyer quote step)
ALTER TABLE catalog ADD COLUMN reach_kind TEXT;         -- ok | dead | down | needs_request | no_paywall | pay_to_differs | rate_limited
ALTER TABLE catalog ADD COLUMN reach_detail TEXT;       -- short factual result, e.g. 'HTTP 404'
ALTER TABLE catalog ADD COLUMN reach_strikes INTEGER;   -- failed checks in a row, one per occasion (>= 3: listing looks dead)
ALTER TABLE catalog ADD COLUMN reach_strike_at INTEGER; -- ms, latest counted strike (occasion anchor, 12 h)
ALTER TABLE catalog ADD COLUMN reach_since INTEGER;     -- ms, first failed check of the current run
