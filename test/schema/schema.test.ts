import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { validateReport } from "../../src/validate";
import { edge, invalid, valid } from "../fixtures";

const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../schema/report.schema.json"), "utf8"));
const ajv = addFormats(new Ajv2020({ strict: true, allErrors: false }));
const matchesSchema = ajv.compile(schema);

describe("schema fixtures", () => {
  for (const [name, body] of Object.entries({ ...valid, ...edge })) {
    it(`valid: ${name}`, () => {
      expect(matchesSchema(body)).toBe(true);
      expect(validateReport(body).ok).toBe(true);
    });
  }
  for (const [name, body] of Object.entries(invalid)) {
    it(`invalid: ${name}`, () => {
      expect(matchesSchema(body)).toBe(false);
      expect(validateReport(body).ok).toBe(false);
    });
  }
});

describe("validator", () => {
  it("never echoes a submitted value in its error", () => {
    const secret = "SECRET-VALUE-123";
    const result = validateReport({ ...(valid["tracker-kept-typical"] as object), url: secret });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("wrangler.json", () => {
  const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../wrangler.json"), "utf8"));
  const scopes: [string, Record<string, unknown>][] = [
    ["top level", config],
    ...Object.entries<Record<string, unknown>>(config.env ?? {}).map(([n, c]): [string, Record<string, unknown>] => [`env.${n}`, c]),
  ];
  for (const [label, scope] of scopes) {
    it(`${label}: logging off, no public preview URL`, () => {
      expect(scope.observability).toEqual({ enabled: false });
      expect(scope.logpush).toBe(false);
      expect(scope.tail_consumers).toBeUndefined();
      expect(scope.workers_dev).toBe(false);
      expect(scope.preview_urls).toBe(false);
    });
    it(`${label}: the kill switch is not a config variable, so a deploy cannot reset it`, () => {
      expect(Object.keys((scope.vars as object) ?? {})).not.toContain("PAUSED");
    });
  }
});

describe("wrangler.json kill switch", () => {
  it("keeps dashboard variables on deploy (keep_vars is valid only at the top level)", () => {
    const config = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../wrangler.json"), "utf8"));
    expect(config.keep_vars).toBe(true);
    for (const scope of Object.values<Record<string, unknown>>(config.env)) expect(scope.keep_vars).toBeUndefined();
  });
});

describe("source", () => {
  const sources = ["index", "store", "retention", "validate"].map((f) =>
    readFileSync(resolve(import.meta.dirname, `../../src/${f}.ts`), "utf8"),
  );
  it("does not log and never reads IP or client header data", () => {
    for (const text of sources) {
      expect(text).not.toMatch(/console\./);
      expect(text.toLowerCase()).not.toMatch(/cf-connecting-ip|x-forwarded-for|user-agent|request\.cf\b/);
    }
  });
});
