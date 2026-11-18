-- Running count of raw reports, so the storage ceiling needs no table scan.
CREATE TABLE raw_total (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n INTEGER NOT NULL
);
