export const PAIR_THRESHOLD = 3;
export const RETENTION_WARN_DAYS = 181;
export const WARN_FRACTION = 0.8;
const MAX_PAIRS_LISTED = 25;
const D1_CONSOLE = "https://dash.cloudflare.com/?to=/:account/workers/d1";

export interface EmailSender {
  send(message: { to: string; from: string; subject: string; text: string }): Promise<unknown>;
}

export interface DigestEnv {
  DB: D1Database;
  EMAIL?: EmailSender;
  DIGEST_TO?: string;
  DIGEST_FROM?: string;
  DIGEST_LABEL?: string;
  PAUSED?: string;
  DAILY_CAP?: string;
  MAX_RAW_REPORTS?: string;
}

/** Everything a digest may show. It has no field for notes, report IDs or parameter values. */
export interface DigestInput {
  label: string;
  newByKind: Record<string, number>;
  pairs: { host: string; param: string; n: number }[];
  pairsOmitted: boolean;
  otherReports: number;
  oldestAgeDays: number | null;
  peakAccepted: number;
  dailyCap: number;
  rawTotal: number;
  maxRawReports: number;
  paused: boolean;
  retentionFailed: boolean;
  heartbeat: boolean;
}

const plain = (text: string) => text.replace(/[^\x20-\x7e]/g, "?");

/** Builds the digest, or null on a quiet day: no new reports, no warning and not the weekly heartbeat. */
export function buildDigest(input: DigestInput): { subject: string; text: string } | null {
  const total = Object.values(input.newByKind).reduce((sum, n) => sum + n, 0);
  const warnings: string[] = [];
  if (input.retentionFailed) warnings.push("The retention job failed on its last run.");
  if (input.oldestAgeDays !== null && input.oldestAgeDays > RETENTION_WARN_DAYS)
    warnings.push(`The oldest raw report is ${input.oldestAgeDays} days old; retention should keep it under ${RETENTION_WARN_DAYS}.`);
  if (input.peakAccepted >= input.dailyCap * WARN_FRACTION)
    warnings.push(`Accepted reports reached ${input.peakAccepted} of the daily cap of ${input.dailyCap}.`);
  if (input.rawTotal >= input.maxRawReports * WARN_FRACTION)
    warnings.push(`Stored raw reports are ${input.rawTotal} of the ceiling of ${input.maxRawReports}.`);
  if (total === 0 && warnings.length === 0 && !input.heartbeat) return null;

  const prefix = input.label ? `[${plain(input.label)}] ` : "";
  const subject = `${prefix}Decant reports: ${total} new${warnings.length > 0 ? ", warning" : ""}`;
  const kinds = Object.entries(input.newByKind)
    .map(([kind, n]) => `${plain(kind)} ${n}`)
    .join(", ");
  const lines = [`New since the last digest: ${total}${kinds ? ` (${kinds})` : ""}`, ""];
  if (input.pairs.length > 0) {
    lines.push(`Site and parameter pairs with ${PAIR_THRESHOLD} or more reports, newest first:`);
    for (const p of input.pairs) lines.push(`- ${plain(p.host)} / ${plain(p.param)}: ${p.n}`);
    if (input.pairsOmitted) lines.push("- more pairs omitted; see the D1 console");
  }
  if (input.otherReports > 0) lines.push(`${input.otherReports} reports from other sites.`);
  if (input.pairs.length > 0 || input.otherReports > 0) lines.push("");
  lines.push("Health");
  for (const w of warnings) lines.push(`WARNING: ${w}`);
  lines.push(
    `- Oldest raw report: ${input.oldestAgeDays === null ? "none stored" : `${input.oldestAgeDays} days`} (warns above ${RETENTION_WARN_DAYS})`,
    `- Accepted per day, peak of yesterday and today: ${input.peakAccepted} of ${input.dailyCap}`,
    `- Stored raw reports: ${input.rawTotal} of ${input.maxRawReports}`,
    `- Relay: ${input.paused ? "paused" : "running"}`,
    "",
    `D1 console: ${D1_CONSOLE}`,
    "",
  );
  return { subject, text: lines.join("\n") };
}

const positiveInteger = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};
const isPaused = (value: string | undefined) => value !== undefined && value.trim() !== "" && value.trim() !== "0";
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const NEW_PAIRS = `
  WITH fresh AS (SELECT id, host, removed, kept FROM reports WHERE day > ?1 AND day <= ?2),
  pairs AS (
    SELECT fresh.id AS id, fresh.host AS host, json_extract(j.value, '$.name') AS param FROM fresh, json_each(fresh.removed) j
    UNION
    SELECT fresh.id, fresh.host, json_extract(j.value, '$.name') FROM fresh, json_each(fresh.kept) j
  ),
  frequent AS (SELECT host, param, COUNT(*) AS n, MAX(id) AS newest FROM pairs GROUP BY host, param HAVING COUNT(*) >= ?3)`;

/** Collects the digest figures from D1 for reports received on days after `lastDay`, through `throughDay`. */
async function gather(
  env: DigestEnv,
  now: Date,
  lastDay: string,
  throughDay: string,
  retentionFailed: boolean,
): Promise<DigestInput> {
  const db = env.DB;
  const [kinds, pairs, covered, oldest, counter, raw] = await db.batch([
    db.prepare("SELECT kind, COUNT(*) AS n FROM reports WHERE day > ?1 AND day <= ?2 GROUP BY kind ORDER BY kind").bind(lastDay, throughDay),
    db
      .prepare(`${NEW_PAIRS} SELECT host, param, n FROM frequent ORDER BY newest DESC, n DESC LIMIT ?4`)
      .bind(lastDay, throughDay, PAIR_THRESHOLD, MAX_PAIRS_LISTED + 1),
    db
      .prepare(`${NEW_PAIRS} SELECT COUNT(DISTINCT pairs.id) AS n FROM pairs JOIN frequent USING (host, param)`)
      .bind(lastDay, throughDay, PAIR_THRESHOLD),
    db.prepare("SELECT MIN(day) AS day FROM reports"),
    db.prepare("SELECT COALESCE(MAX(n), 0) AS n FROM daily_counter WHERE day >= ?1").bind(throughDay),
    db.prepare("SELECT COALESCE((SELECT n FROM raw_total WHERE id = 1), 0) AS n"),
  ]);
  const newByKind = Object.fromEntries((kinds.results as { kind: string; n: number }[]).map((r) => [r.kind, r.n]));
  const total = Object.values(newByKind).reduce((sum, n) => sum + n, 0);
  const listed = pairs.results as { host: string; param: string; n: number }[];
  const oldestDay = (oldest.results[0] as { day: string | null }).day;
  const today = isoDay(now.getTime());
  return {
    label: env.DIGEST_LABEL ?? "",
    newByKind,
    pairs: listed.slice(0, MAX_PAIRS_LISTED),
    pairsOmitted: listed.length > MAX_PAIRS_LISTED,
    otherReports: total - (covered.results[0] as { n: number }).n,
    oldestAgeDays: oldestDay === null ? null : Math.floor((Date.parse(today) - Date.parse(oldestDay)) / 86_400_000),
    peakAccepted: (counter.results[0] as { n: number }).n,
    dailyCap: positiveInteger(env.DAILY_CAP, 5000),
    rawTotal: (raw.results[0] as { n: number }).n,
    maxRawReports: positiveInteger(env.MAX_RAW_REPORTS, 50_000),
    paused: isPaused(env.PAUSED),
    retentionFailed,
    heartbeat: now.getUTCDay() === 1,
  };
}

/**
 * Sends the daily digest when there is something to say, covering the UTC days after the last
 * digest through yesterday. The marker moves only after a successful send, so a failed send is
 * retried the next night. Errors propagate so the cron run shows as failed; does nothing unless the
 * email binding and both addresses are configured.
 */
export async function sendDigest(env: DigestEnv, now: Date, retentionFailed: boolean): Promise<void> {
  if (!env.EMAIL || !env.DIGEST_TO || !env.DIGEST_FROM) return;
  const throughDay = isoDay(now.getTime() - 86_400_000);
  const state = await env.DB.prepare("SELECT last_day AS day FROM digest_state WHERE id = 1").first<{ day: string }>();
  const digest = buildDigest(await gather(env, now, state?.day ?? "", throughDay, retentionFailed));
  if (!digest) return;
  await env.EMAIL.send({ to: env.DIGEST_TO, from: env.DIGEST_FROM, subject: digest.subject, text: digest.text });
  await env.DB
    .prepare("INSERT INTO digest_state (id, last_day) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET last_day = excluded.last_day")
    .bind(throughDay)
    .run();
}
