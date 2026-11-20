import type { Report } from "./validate";

export type StoreResult = "stored" | "duplicate" | "capped";

/** Stores a validated report once per reportId unless today's count has reached `cap` or all raw reports `ceiling`. */
export async function storeReport(db: D1Database, report: Report, day: string, cap: number, ceiling: number): Promise<StoreResult> {
  const parameters = JSON.stringify(
    report.parameters.map((p) => ({ name: p.name, length: p.shape.length, charset: p.shape.charset, outcome: p.outcome, flagged: p.flagged })),
  );

  const [insert] = await db.batch([
    db
      .prepare(
        `INSERT INTO reports (report_id, day, reasons, host, app_version, app_build, note, rules_generation, parameters)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
         WHERE NOT EXISTS (SELECT 1 FROM reports WHERE report_id = ?1)
           AND COALESCE((SELECT n FROM daily_counter WHERE day = ?2), 0) < ?10
           AND COALESCE((SELECT n FROM raw_total WHERE id = 1), 0) < ?11`,
      )
      .bind(
        report.reportId,
        day,
        JSON.stringify(report.reasons),
        report.host,
        report.appVersion,
        report.appBuild,
        report.note ?? null,
        report.rulesGeneration,
        parameters,
        cap,
        ceiling,
      ),
    db
      .prepare(
        `INSERT INTO daily_counter (day, n) SELECT ?1, 1 WHERE changes() = 1
         ON CONFLICT (day) DO UPDATE SET n = n + 1`,
      )
      .bind(day),
    db.prepare("INSERT INTO raw_total (id, n) SELECT 1, 1 WHERE changes() = 1 ON CONFLICT (id) DO UPDATE SET n = n + 1"),
  ]);
  if (insert.meta.changes === 1) return "stored";

  const exists = await db.prepare("SELECT 1 AS found FROM reports WHERE report_id = ?").bind(report.reportId).first();
  return exists ? "duplicate" : "capped";
}
