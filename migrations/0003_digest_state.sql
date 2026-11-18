-- The last UTC day the daily digest covered. No report content. A date, so purges cannot move it.
CREATE TABLE digest_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_day TEXT NOT NULL
);
