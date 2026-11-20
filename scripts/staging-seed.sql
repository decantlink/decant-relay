-- Synthetic reports for trying the digest and triage on STAGING or a local database. Never run on production.
-- Report IDs share one prefix so staging-cleanup.sql can remove exactly these rows.
-- digest-test-b.example / fbclid is flagged, so the digest should list it before digest-test-a.example / si.
INSERT INTO reports (report_id, day, kind, host, app_major, note, rules_generation, parameters) VALUES
  ('00000000-0000-4000-8000-000000000001', date('now'), 'tracker-kept', 'digest-test-a.example', 1, 'synthetic seed note, must never appear in the digest', 17, '[{"name":"si","length":22,"charset":"base64url","outcome":"kept","flagged":false}]'),
  ('00000000-0000-4000-8000-000000000002', date('now'), 'tracker-kept', 'digest-test-a.example', 1, NULL, 17, '[{"name":"si","length":22,"charset":"base64url","outcome":"kept","flagged":false}]'),
  ('00000000-0000-4000-8000-000000000003', date('now'), 'tracker-kept', 'digest-test-a.example', 1, NULL, 17, '[{"name":"si","length":22,"charset":"base64url","outcome":"kept","flagged":false}]'),
  ('00000000-0000-4000-8000-000000000004', date('now'), 'link-broke', 'digest-test-a.example', 1, NULL, 17, '[{"name":"si","length":22,"charset":"base64url","outcome":"removed-by-rules","flagged":false}]'),
  ('00000000-0000-4000-8000-000000000005', date('now'), 'tracker-kept', 'digest-test-b.example', 1, NULL, 17, '[{"name":"fbclid","length":40,"charset":"base64url","outcome":"kept","flagged":true}]'),
  ('00000000-0000-4000-8000-000000000006', date('now'), 'tracker-kept', 'digest-test-b.example', 1, NULL, 17, '[{"name":"fbclid","length":40,"charset":"base64url","outcome":"kept","flagged":false}]'),
  ('00000000-0000-4000-8000-000000000007', date('now'), 'tracker-kept', 'digest-test-b.example', 1, NULL, 17, '[{"name":"fbclid","length":40,"charset":"base64url","outcome":"removed-by-you","flagged":true}]');
INSERT INTO raw_total (id, n) SELECT 1, COUNT(*) FROM reports WHERE true ON CONFLICT (id) DO UPDATE SET n = excluded.n;
