-- Sales client type (Lumi API 1.1.7): "<ua_class>: <UA family>" of the paying request, at most 40 chars.
-- Built from the User-Agent only; no IP or other header is stored. Additive and nullable (older rows stay NULL).
ALTER TABLE sales ADD COLUMN client TEXT;
