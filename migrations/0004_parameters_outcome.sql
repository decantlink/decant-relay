-- Reports now say what happened to each parameter and which rules generation the app used.
-- One `parameters` column holds the payload's list as sent: name, length, charset, outcome, flagged.
-- It replaces the old `removed` and `kept` columns.
ALTER TABLE reports ADD COLUMN parameters TEXT NOT NULL DEFAULT '[]';
-- NULL only on rows stored before this migration; the relay always writes it now.
ALTER TABLE reports ADD COLUMN rules_generation INTEGER;

-- Rows from before the migration had no edits: every removed parameter was removed by the rules.
UPDATE reports SET parameters = (
  SELECT COALESCE(json_group_array(json(entry)), '[]') FROM (
    SELECT json_set(value, '$.outcome', 'removed-by-rules', '$.flagged', json('false')) AS entry FROM json_each(reports.removed)
    UNION ALL
    SELECT json_set(value, '$.outcome', 'kept', '$.flagged', json('false')) FROM json_each(reports.kept)
  )
);

ALTER TABLE reports DROP COLUMN removed;
ALTER TABLE reports DROP COLUMN kept;

-- Same words as the payload's `outcome`. `kept` already meant the same thing.
UPDATE counts SET outcome = 'removed-by-rules' WHERE outcome = 'removed';
-- How many of `n` were flagged by the person.
ALTER TABLE counts ADD COLUMN flagged_n INTEGER NOT NULL DEFAULT 0;
