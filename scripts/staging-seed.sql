-- Synthetic reports for trying the digest and triage on STAGING or a local database. Never run on production.
-- Report IDs share one prefix so staging-cleanup.sql can remove exactly these rows.
INSERT INTO reports (report_id, day, kind, host, app_major, note, removed, kept) VALUES
  ('00000000-0000-4000-8000-000000000001', date('now'), 'tracker-kept', 'digest-test-a.example', 1, 'synthetic seed note, must never appear in the digest', '[]', '[{"name":"si","length":22,"charset":"base64url"}]'),
  ('00000000-0000-4000-8000-000000000002', date('now'), 'tracker-kept', 'digest-test-a.example', 1, NULL, '[]', '[{"name":"si","length":22,"charset":"base64url"}]'),
  ('00000000-0000-4000-8000-000000000003', date('now'), 'tracker-kept', 'digest-test-a.example', 1, NULL, '[]', '[{"name":"si","length":22,"charset":"base64url"}]'),
  ('00000000-0000-4000-8000-000000000004', date('now'), 'link-broke', 'digest-test-a.example', 1, NULL, '[{"name":"si","length":22,"charset":"base64url"}]', '[]'),
  ('00000000-0000-4000-8000-000000000005', date('now'), 'tracker-kept', 'digest-test-b.example', 1, NULL, '[]', '[{"name":"fbclid","length":40,"charset":"base64url"}]'),
  ('00000000-0000-4000-8000-000000000006', date('now'), 'tracker-kept', 'digest-test-b.example', 1, NULL, '[]', '[{"name":"fbclid","length":40,"charset":"base64url"}]');
INSERT INTO raw_total (id, n) SELECT 1, COUNT(*) FROM reports WHERE true ON CONFLICT (id) DO UPDATE SET n = excluded.n;
