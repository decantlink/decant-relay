// Read-only triage of the report relay. Usage: npm run triage -- [--staging] [--since YYYY-MM-DD] [--notes]
// Notes are free text from users: only the maintainer runs --notes, personally; agents never do.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { assertReadOnly, triageStatements } from "./triage-sql.ts";

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    staging: { type: "boolean", default: false },
    since: { type: "string" },
    notes: { type: "boolean", default: false },
    local: { type: "boolean", default: false },
  },
});

const envName = values.staging ? "staging" : "production";
const since = values.since ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "../wrangler.json"), "utf8")).env[envName];
const dailyCap = Number(config.vars.DAILY_CAP);
const maxRaw = Number(config.vars.MAX_RAW_REPORTS);
const host: string = config.routes[0].pattern;

const printable = (text: string) => text.replace(new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", "g"), "?");

async function query(sql: string): Promise<Record<string, unknown>[]> {
  assertReadOnly(sql);
  const args = ["--no-install", "wrangler", "d1", "execute", "DB", "--env", envName, values.local ? "--local" : "--remote", "--json", "--command", sql];
  const { stdout } = await run("npx", args, { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout)[0].results;
}

/** A text/plain POST is answered 503 while paused and 415 while running; nothing is stored either way. */
async function relayState(): Promise<string> {
  try {
    const response = await fetch(`https://${host}/v1/report`, { method: "POST", headers: { "content-type": "text/plain" }, body: "." });
    return response.status === 503 ? "PAUSED" : response.status === 415 ? "running" : `unknown (HTTP ${response.status})`;
  } catch {
    return "unknown (unreachable)";
  }
}

const statements = triageStatements(since, values.notes);
const rows: Record<string, Record<string, unknown>[]> = {};
for (const s of statements) rows[s.name] = await query(s.sql);

const out: string[] = [`Decant relay triage: ${envName}, since ${since}`, ""];
const reasons = rows.reasons.map((r) => `${printable(String(r.reason))} ${r.n}`);
const total = Number(rows.total[0].n);
const overlap = rows.reasons.reduce((sum, r) => sum + Number(r.n), 0) > total;
out.push(`New reports since ${since}: ${total}${reasons.length ? ` (${reasons.join(", ")}${overlap ? "; a report with several reasons counts under each" : ""})` : ""}`, "", "Site and parameter groups, flagged first, then newest:");
if (rows.groups.length === 0) out.push("  none");
for (const g of rows.groups) out.push(`  ${printable(String(g.host))} / ${printable(String(g.param))}: ${g.n}, flagged ${g.flagged} (latest ${g.latest})`);
out.push("", "Parameter outcomes (flagged by the person):");
if (rows.outcomes.length === 0) out.push("  none");
for (const o of rows.outcomes) out.push(`  ${printable(String(o.outcome))}: ${o.n} (flagged ${o.flagged})`);
out.push("", "Reports by rules generation:");
if (rows.generations.length === 0) out.push("  none");
for (const g of rows.generations) out.push(`  ${g.rules_generation === null ? "unknown (stored before generations)" : g.rules_generation}: ${g.n}`);
const oldest = rows.oldest[0]?.oldest as string | null | undefined;
const age = oldest ? Math.floor((Date.now() - Date.parse(oldest)) / 86_400_000) : null;
out.push(
  "",
  `Oldest raw report: ${oldest ? `${oldest}, ${age} days old${age! > 181 ? "  WARNING: retention should keep it under 181" : ""}` : "none stored"}`,
  `Accepted today (UTC ${rows.today[0].day}): ${rows.today[0].accepted} of ${dailyCap}`,
  `Stored raw reports: ${rows.stored[0].raw_total} of ${maxRaw}`,
  `Relay: ${values.local ? "not checked (--local)" : await relayState()}`,
);
if (values.notes) {
  out.push("", "NOTES (terminal only, user free text; do not paste anywhere):");
  if (rows.notes.length === 0) out.push("  none");
  for (const n of rows.notes) out.push(`  ${n.day} ${printable(String(n.reasons))} ${printable(String(n.host))}: ${printable(String(n.note))}`);
}
console.log(out.join("\n"));
