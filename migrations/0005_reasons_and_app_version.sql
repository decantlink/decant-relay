-- A report carries one to three reasons and the app's full version and build.
-- `reasons` is a JSON array of the payload's words, sorted. It replaces `kind`.
ALTER TABLE reports ADD COLUMN reasons TEXT NOT NULL DEFAULT '[]';
UPDATE reports SET reasons = json_array(kind);
ALTER TABLE reports DROP COLUMN kind;

-- `app_version` and `app_build` replace `app_major`. NULL only on rows stored before this migration:
-- a major version alone is not a version, so it is not carried over.
ALTER TABLE reports ADD COLUMN app_version TEXT;
ALTER TABLE reports ADD COLUMN app_build INTEGER;
ALTER TABLE reports DROP COLUMN app_major;

-- Counts are per reason; a report with several reasons is counted under each.
ALTER TABLE counts RENAME COLUMN kind TO reason;
