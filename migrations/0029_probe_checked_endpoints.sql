-- Which endpoints a free probe run actually hit (normalised origin+path JSON array, no query string). Additive, nullable:
-- rows written before this migration read as "endpoint not recorded". Lets /v1/check tell a probe failure on the
-- endpoint Lumi test-bought apart from a failure on some other endpoint of the same domain.
ALTER TABLE probe_checked ADD COLUMN probed_endpoints TEXT;
