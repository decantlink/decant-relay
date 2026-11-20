export type Charset = "empty" | "digits" | "hex" | "alpha" | "alnum" | "base64url" | "other";
export type Reason = "tracker-kept" | "link-broke" | "other";

export type Outcome = "removed-by-rules" | "removed-by-you" | "kept" | "restored-by-you";

export interface Parameter {
  name: string;
  shape: { length: number; charset: Charset };
  outcome: Outcome;
  flagged: boolean;
}

export interface Report {
  schemaVersion: 1;
  reportId: string;
  reasons: Reason[];
  host: string;
  appVersion: string;
  appBuild: number;
  date: string;
  rulesGeneration: number;
  parameters: Parameter[];
  note?: string;
}

export type Validation = { ok: true; report: Report } | { ok: false; error: string };

const CHARSETS: readonly string[] = ["empty", "digits", "hex", "alpha", "alnum", "base64url", "other"];
const REASONS: readonly string[] = ["tracker-kept", "link-broke", "other"];
const APP_VERSION = /^[0-9]{1,4}(\.[0-9]{1,4}){1,2}$/;
const OUTCOMES: readonly string[] = ["removed-by-rules", "removed-by-you", "kept", "restored-by-you"];
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const PARAM_NAME = /^[A-Za-z0-9_.:[\]-]+$/;
const NOTE_FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;

const fail = (error: string): Validation => ({ ok: false, error });
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hasOnly = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).every((k) => keys.includes(k));

function isCalendarDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

function validateParameters(value: unknown, field: string): Parameter[] | string {
  if (!Array.isArray(value)) return `${field}: not an array`;
  if (value.length > 32) return `${field}: more than 32 items`;
  const out: Parameter[] = [];
  for (let i = 0; i < value.length; i++) {
    const at = `${field}[${i}]`;
    const p = value[i];
    if (!isObject(p) || !hasOnly(p, ["name", "shape", "outcome", "flagged"])) {
      return `${at}: not an object with name, shape, outcome and flagged only`;
    }
    const name = p.name;
    if (typeof name !== "string" || name.length < 1 || name.length > 64 || !PARAM_NAME.test(name)) {
      return `${at}.name: invalid`;
    }
    const shape = p.shape;
    if (!isObject(shape) || !hasOnly(shape, ["length", "charset"])) return `${at}.shape: not an object with length and charset only`;
    const { length, charset } = shape;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 4096) {
      return `${at}.shape.length: invalid`;
    }
    if (typeof charset !== "string" || !CHARSETS.includes(charset)) return `${at}.shape.charset: invalid`;
    if ((charset === "empty") !== (length === 0)) return `${at}.shape: empty and length 0 go together`;
    const { outcome, flagged } = p;
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) return `${at}.outcome: invalid`;
    if (typeof flagged !== "boolean") return `${at}.flagged: not a boolean`;
    out.push({ name, shape: { length, charset: charset as Charset }, outcome: outcome as Outcome, flagged });
  }
  return out;
}

/** Checks a parsed JSON value against schema/report.schema.json; errors name a field, never a value. */
export function validateReport(input: unknown): Validation {
  if (!isObject(input)) return fail("payload: not an object");
  if (!hasOnly(input, ["schemaVersion", "reportId", "reasons", "host", "appVersion", "appBuild", "date", "rulesGeneration", "parameters", "note"])) {
    return fail("payload: unknown field");
  }
  if (input.schemaVersion !== 1) return fail("schemaVersion: must be 1");
  const { reportId, reasons, host, appVersion, appBuild, date, note } = input;
  if (typeof reportId !== "string" || !REPORT_ID.test(reportId)) return fail("reportId: invalid");
  if (
    !Array.isArray(reasons) ||
    reasons.length < 1 ||
    reasons.length > 3 ||
    !reasons.every((r) => typeof r === "string" && REASONS.includes(r)) ||
    new Set(reasons).size !== reasons.length
  ) {
    return fail("reasons: invalid");
  }
  if (typeof host !== "string" || host.length > 253 || !HOST.test(host)) return fail("host: invalid");
  if (typeof appVersion !== "string" || appVersion.length > 14 || !APP_VERSION.test(appVersion)) return fail("appVersion: invalid");
  if (typeof appBuild !== "number" || !Number.isInteger(appBuild) || appBuild < 1 || appBuild > 999_999) {
    return fail("appBuild: invalid");
  }
  if (typeof date !== "string" || !isCalendarDate(date)) return fail("date: invalid");
  const { rulesGeneration } = input;
  if (
    typeof rulesGeneration !== "number" ||
    !Number.isInteger(rulesGeneration) ||
    rulesGeneration < 1 ||
    rulesGeneration > 1_000_000
  ) {
    return fail("rulesGeneration: invalid");
  }
  const parameters = validateParameters(input.parameters, "parameters");
  if (typeof parameters === "string") return fail(parameters);
  if (note !== undefined) {
    if (typeof note !== "string") return fail("note: not a string");
    const characters = [...note].length;
    if (characters < 1 || characters > 280 || NOTE_FORBIDDEN.test(note)) return fail("note: invalid");
  }
  return {
    ok: true,
    report: {
      schemaVersion: 1,
      reportId,
      reasons: [...(reasons as Reason[])].sort(),
      host,
      appVersion,
      appBuild,
      date,
      rulesGeneration,
      parameters,
      ...(note === undefined ? {} : { note }),
    },
  };
}
