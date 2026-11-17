-- Raw reports. Nothing here comes from the request's network or header data.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  host TEXT NOT NULL,
  app_major INTEGER NOT NULL,
  note TEXT,
  removed TEXT NOT NULL,
  kept TEXT NOT NULL
);
CREATE INDEX reports_day ON reports (day);

-- Accepted reports per receive day, for the global daily cap.
CREATE TABLE daily_counter (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
) WITHOUT ROWID;

-- Kept after raw reports expire. No report IDs.
CREATE TABLE counts (
  host TEXT NOT NULL,
  param TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (host, param, kind, outcome)
) WITHOUT ROWID;
