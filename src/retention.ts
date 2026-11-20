export const RETENTION_DAYS = 180;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Folds raw reports older than RETENTION_DAYS into counts per outcome, then deletes them, in one batch. */
export async function runRetention(db: D1Database, now: Date): Promise<void> {
  const cutoff = isoDay(now.getTime() - RETENTION_DAYS * 86_400_000);
  const fold = db
    .prepare(
      `INSERT INTO counts (host, param, kind, outcome, n, flagged_n)
       SELECT r.host, json_extract(j.value, '$.name'), r.kind, json_extract(j.value, '$.outcome'), COUNT(*),
              SUM(json_extract(j.value, '$.flagged'))
       FROM reports r, json_each(r.parameters) j
       WHERE r.day < ?1
       GROUP BY r.host, json_extract(j.value, '$.name'), r.kind, json_extract(j.value, '$.outcome')
       ON CONFLICT (host, param, kind, outcome) DO UPDATE SET n = n + excluded.n, flagged_n = flagged_n + excluded.flagged_n`,
    )
    .bind(cutoff);

  await db.batch([
    fold,
    db.prepare("DELETE FROM reports WHERE day < ?1").bind(cutoff),
    db.prepare("DELETE FROM daily_counter WHERE day < ?1").bind(cutoff),
    db.prepare(
      "INSERT INTO raw_total (id, n) SELECT 1, COUNT(*) FROM reports WHERE true ON CONFLICT (id) DO UPDATE SET n = excluded.n",
    ),
  ]);
}
