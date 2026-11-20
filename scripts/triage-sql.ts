export const DAY = /^\d{4}-\d{2}-\d{2}$/;

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum|reindex)\b/i;

/** Throws unless `sql` is one SELECT (or WITH ... SELECT) statement. */
export function assertReadOnly(sql: string): void {
  const body = sql.trim().replace(/;$/, "");
  if (body.includes(";")) throw new Error("triage runs one statement at a time");
  if (!/^(select|with)\b/i.test(body) || FORBIDDEN.test(body)) throw new Error("triage is read-only: SELECT statements only");
}

export interface Statement {
  name: "kinds" | "groups" | "outcomes" | "generations" | "oldest" | "today" | "stored" | "notes";
  sql: string;
}

const GROUPS = (since: string) => `WITH pairs AS (
  SELECT r.id AS id, r.day AS day, r.host AS host, json_extract(j.value, '$.name') AS param, MAX(json_extract(j.value, '$.flagged')) AS flagged
  FROM reports r, json_each(r.parameters) j WHERE r.day >= '${since}'
  GROUP BY r.id, r.day, r.host, json_extract(j.value, '$.name')
)
SELECT host, param, COUNT(*) AS n, SUM(flagged) AS flagged, MAX(day) AS latest FROM pairs GROUP BY host, param ORDER BY SUM(flagged) DESC, MAX(id) DESC LIMIT 50`;

/** The triage questions as read-only SQL; `since` is a YYYY-MM-DD day. Notes are included only when asked for. */
export function triageStatements(since: string, withNotes: boolean): Statement[] {
  if (!DAY.test(since)) throw new Error("--since must be a day like 2026-11-01");
  const statements: Statement[] = [
    { name: "kinds", sql: `SELECT kind, COUNT(*) AS n FROM reports WHERE day >= '${since}' GROUP BY kind ORDER BY kind` },
    { name: "groups", sql: GROUPS(since) },
    {
      name: "outcomes",
      sql: `SELECT json_extract(j.value, '$.outcome') AS outcome, COUNT(*) AS n, SUM(json_extract(j.value, '$.flagged')) AS flagged FROM reports r, json_each(r.parameters) j WHERE r.day >= '${since}' GROUP BY outcome ORDER BY outcome`,
    },
    {
      name: "generations",
      sql: `SELECT rules_generation, COUNT(*) AS n FROM reports WHERE day >= '${since}' GROUP BY rules_generation ORDER BY rules_generation DESC`,
    },
    { name: "oldest", sql: "SELECT MIN(day) AS oldest FROM reports" },
    { name: "today", sql: "SELECT date('now') AS day, COALESCE((SELECT n FROM daily_counter WHERE day = date('now')), 0) AS accepted" },
    { name: "stored", sql: "SELECT COALESCE((SELECT n FROM raw_total WHERE id = 1), 0) AS raw_total" },
  ];
  if (withNotes)
    statements.push({
      name: "notes",
      sql: `SELECT day, kind, host, note FROM reports WHERE note IS NOT NULL AND day >= '${since}' ORDER BY id DESC LIMIT 50`,
    });
  for (const s of statements) assertReadOnly(s.sql);
  return statements;
}
