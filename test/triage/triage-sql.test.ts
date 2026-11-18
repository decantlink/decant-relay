import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnly, triageStatements } from "../../scripts/triage-sql";

describe("triage SQL", () => {
  it("builds only read-only statements", () => {
    for (const withNotes of [false, true]) for (const s of triageStatements("2026-11-01", withNotes)) expect(() => assertReadOnly(s.sql)).not.toThrow();
  });

  it("selects notes only when asked", () => {
    const names = (withNotes: boolean) => triageStatements("2026-11-01", withNotes).map((s) => s.name);
    expect(names(false)).not.toContain("notes");
    expect(names(true)).toContain("notes");
    for (const s of triageStatements("2026-11-01", false)) expect(s.sql).not.toMatch(/\bnote\b|report_id/i);
  });

  it("rejects anything but a single SELECT", () => {
    for (const sql of [
      "DELETE FROM reports",
      "UPDATE reports SET note = NULL",
      "INSERT INTO counts VALUES ('a','b','c','d',1)",
      "DROP TABLE reports",
      "PRAGMA table_info(reports)",
      "SELECT 1; DELETE FROM reports",
      "WITH x AS (SELECT 1) DELETE FROM reports",
      "SELECT 1 UNION SELECT 2; DROP TABLE reports;",
    ])
      expect(() => assertReadOnly(sql), sql).toThrow();
  });

  it("rejects a malformed day, so nothing is injected through --since", () => {
    expect(() => triageStatements("2026-11-01'; DROP TABLE reports; --", false)).toThrow("--since");
    expect(() => triageStatements("yesterday", false)).toThrow("--since");
  });

  it("agrees with the README saved queries on what is shown", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");
    for (const s of triageStatements("2026-11-01", false)) expect(readme.replace(/\s+/g, " ")).toContain(s.sql.replace(/\s+/g, " "));
  });
});
