export type Charset = "empty" | "digits" | "hex" | "alpha" | "alnum" | "base64url" | "other";
export type Kind = "tracker-kept" | "link-broke";

export interface Parameter {
  name: string;
  shape: { length: number; charset: Charset };
}

export interface Report {
  schemaVersion: 1;
  reportId: string;
  kind: Kind;
  host: string;
  appMajor: number;
  date: string;
  removed: Parameter[];
  kept: Parameter[];
  note?: string;
}

export type Validation = { ok: true; report: Report } | { ok: false; error: string };

const CHARSETS: readonly string[] = ["empty", "digits", "hex", "alpha", "alnum", "base64url", "other"];
const KINDS: readonly string[] = ["tracker-kept", "link-broke"];
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
    if (!isObject(p) || !hasOnly(p, ["name", "shape"])) return `${at}: not an object with name and shape only`;
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
    out.push({ name, shape: { length, charset: charset as Charset } });
  }
  return out;
}

/** Checks a parsed JSON value against schema/report.schema.json; errors name a field, never a value. */
export function validateReport(input: unknown): Validation {
  if (!isObject(input)) return fail("payload: not an object");
  if (!hasOnly(input, ["schemaVersion", "reportId", "kind", "host", "appMajor", "date", "removed", "kept", "note"])) {
    return fail("payload: unknown field");
  }
  if (input.schemaVersion !== 1) return fail("schemaVersion: must be 1");
  const { reportId, kind, host, appMajor, date, note } = input;
  if (typeof reportId !== "string" || !REPORT_ID.test(reportId)) return fail("reportId: invalid");
  if (typeof kind !== "string" || !KINDS.includes(kind)) return fail("kind: invalid");
  if (typeof host !== "string" || host.length > 253 || !HOST.test(host)) return fail("host: invalid");
  if (typeof appMajor !== "number" || !Number.isInteger(appMajor) || appMajor < 1 || appMajor > 999) {
    return fail("appMajor: invalid");
  }
  if (typeof date !== "string" || !isCalendarDate(date)) return fail("date: invalid");
  const removed = validateParameters(input.removed, "removed");
  if (typeof removed === "string") return fail(removed);
  const kept = validateParameters(input.kept, "kept");
  if (typeof kept === "string") return fail(kept);
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
      kind: kind as Kind,
      host,
      appMajor,
      date,
      removed,
      kept,
      ...(note === undefined ? {} : { note }),
    },
  };
}
