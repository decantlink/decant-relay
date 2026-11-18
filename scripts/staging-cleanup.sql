-- Removes the rows staging-seed.sql added and resets the digest marker. Never run on production.
DELETE FROM reports WHERE report_id LIKE '00000000-0000-4000-8000-%';
DELETE FROM digest_state;
INSERT INTO raw_total (id, n) SELECT 1, COUNT(*) FROM reports WHERE true ON CONFLICT (id) DO UPDATE SET n = excluded.n;
