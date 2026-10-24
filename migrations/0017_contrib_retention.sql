-- Lumi Check v0 (DRAFT; NOT applied to production).
-- Index for the daily retention purge (DELETE ... WHERE day < ?), CONTRIB_RETENTION_DAYS = 90.
CREATE INDEX IF NOT EXISTS contributor_submissions_day ON contributor_submissions (day);
