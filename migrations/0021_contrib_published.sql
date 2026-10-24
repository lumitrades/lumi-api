-- DRAFT (branch scanner-kit-v0, not applied to production): account deletion support.
-- published_at: set by the owner when a contributor receipt is cited in a published, dated test result.
-- On account deletion those rows are kept with the contributor link stripped; every other row of the account is deleted.
-- Deleted accounts leave a tombstone key row (status 'deleted', no label/public key/wallets/domains) so the random
-- key id can never authenticate again. No new index: deletion reads by the existing (key_id, day) index.
ALTER TABLE contributor_submissions ADD COLUMN published_at INTEGER;
