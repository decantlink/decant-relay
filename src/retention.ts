export const RETENTION_DAYS = 180;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Folds raw reports older than RETENTION_DAYS into counts, then deletes them, in one batch. */
export async function runRetention(db: D1Database, now: Date): Promise<void> {
  const cutoff = isoDay(now.getTime() - RETENTION_DAYS * 86_400_000);
  const fold = (column: "removed" | "kept") =>
    db
      .prepare(
        `INSERT INTO counts (host, param, kind, outcome, n)
         SELECT r.host, json_extract(j.value, '$.name'), r.kind, '${column}', COUNT(*)
         FROM reports r, json_each(r.${column}) j
         WHERE r.day < ?1
         GROUP BY r.host, json_extract(j.value, '$.name'), r.kind
         ON CONFLICT (host, param, kind, outcome) DO UPDATE SET n = n + excluded.n`,
      )
      .bind(cutoff);

  await db.batch([
    fold("removed"),
    fold("kept"),
    db.prepare("DELETE FROM reports WHERE day < ?1").bind(cutoff),
    db.prepare("DELETE FROM daily_counter WHERE day < ?1").bind(cutoff),
  ]);
}
