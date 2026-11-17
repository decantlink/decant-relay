import type { Report } from "./validate";

export type StoreResult = "stored" | "duplicate" | "capped";

/** Stores a validated report once per reportId unless today's count has reached `cap`. */
export async function storeReport(db: D1Database, report: Report, day: string, cap: number): Promise<StoreResult> {
  const compact = (list: Report["removed"]) =>
    JSON.stringify(list.map((p) => ({ name: p.name, length: p.shape.length, charset: p.shape.charset })));

  const [insert] = await db.batch([
    db
      .prepare(
        `INSERT INTO reports (report_id, day, kind, host, app_major, note, removed, kept)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         WHERE NOT EXISTS (SELECT 1 FROM reports WHERE report_id = ?1)
           AND COALESCE((SELECT n FROM daily_counter WHERE day = ?2), 0) < ?9`,
      )
      .bind(
        report.reportId,
        day,
        report.kind,
        report.host,
        report.appMajor,
        report.note ?? null,
        compact(report.removed),
        compact(report.kept),
        cap,
      ),
    db
      .prepare(
        `INSERT INTO daily_counter (day, n) SELECT ?1, 1 WHERE changes() = 1
         ON CONFLICT (day) DO UPDATE SET n = n + 1`,
      )
      .bind(day),
  ]);
  if (insert.meta.changes === 1) return "stored";

  const exists = await db.prepare("SELECT 1 AS found FROM reports WHERE report_id = ?").bind(report.reportId).first();
  return exists ? "duplicate" : "capped";
}
