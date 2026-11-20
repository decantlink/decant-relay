import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../../src/index";
import { runRetention } from "../../src/retention";
import { edge, invalid, valid } from "../fixtures";

const URL_ = "https://report.example/v1/report";
const base = valid["tracker-kept-typical"] as Record<string, unknown>;
let counter = 0;
const freshId = () => `3f2b8c1e-5a47-4d9e-8b06-${(++counter).toString(16).padStart(12, "0")}`;
const report = (patch: Record<string, unknown> = {}) => ({ ...base, reportId: freshId(), ...patch });

const post = (body: unknown, options: { headers?: Record<string, string>; env?: Partial<Env>; raw?: boolean } = {}) =>
  worker.fetch(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: options.raw ? (body as string) : JSON.stringify(body),
    }),
    { ...env, ...options.env } as Env,
  );

const rows = async (table: string) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;

beforeEach(async () => {
  await env.DB.batch(["reports", "daily_counter", "counts", "raw_total"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("accepts", () => {
  for (const [name, body] of Object.entries({ ...valid, ...edge })) {
    it(`valid fixture ${name}`, async () => {
      const response = await post(body);
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ status: "accepted" });
    });
  }
});

describe("stores", () => {
  it("each parameter with its outcome and flag, and the rules generation, as sent", async () => {
    const body = report({
      rulesGeneration: 42,
      parameters: [
        { name: "fbclid", shape: { length: 40, charset: "base64url" }, outcome: "removed-by-you", flagged: true },
        { name: "si", shape: { length: 22, charset: "base64url" }, outcome: "kept", flagged: false },
      ],
    });
    expect((await post(body)).status).toBe(201);
    const [row] = (await rows("reports")) as { rules_generation: number; parameters: string }[];
    expect(row.rules_generation).toBe(42);
    expect(JSON.parse(row.parameters)).toEqual([
      { name: "fbclid", length: 40, charset: "base64url", outcome: "removed-by-you", flagged: true },
      { name: "si", length: 22, charset: "base64url", outcome: "kept", flagged: false },
    ]);
  });
  it("migrates rows stored before outcomes existed: removed by the rules, kept, not flagged", async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0004"))!;
    const update = migration.queries.find((q) => q.includes("UPDATE reports SET parameters"))!;
    await env.DB.exec("CREATE TABLE old_reports (removed TEXT, kept TEXT, parameters TEXT NOT NULL DEFAULT '[]')");
    await env.DB.prepare("INSERT INTO old_reports (removed, kept) VALUES (?, ?), ('[]', '[]')")
      .bind('[{"name":"utm_source","length":7,"charset":"alpha"}]', '[{"name":"si","length":16,"charset":"base64url"}]')
      .run();
    await env.DB.prepare(update.replaceAll("reports", "old_reports")).run();
    const stored = (await env.DB.prepare("SELECT parameters FROM old_reports").all()).results as { parameters: string }[];
    await env.DB.exec("DROP TABLE old_reports");
    expect(stored.map((r) => JSON.parse(r.parameters))).toEqual([
      [
        { name: "utm_source", length: 7, charset: "alpha", outcome: "removed-by-rules", flagged: false },
        { name: "si", length: 16, charset: "base64url", outcome: "kept", flagged: false },
      ],
      [],
    ]);
  });
});

describe("rejects", () => {
  for (const [name, body] of Object.entries(invalid)) {
    it(`invalid fixture ${name}`, async () => {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { status: string }).status).toBe("rejected");
      expect(await rows("reports")).toHaveLength(0);
    });
  }

  it("a value present in a parameter", async () => {
    const response = await post(report({ parameters: [{ name: "si", value: "abc", shape: { length: 3, charset: "alpha" }, outcome: "kept", flagged: false }] }));
    expect(response.status).toBe(400);
  });

  it("a path or link present at the top level", async () => {
    expect((await post(report({ path: "/watch" }))).status).toBe(400);
    expect((await post(report({ url: "https://www.youtube.com/watch?v=1" }))).status).toBe(400);
  });

  it("an oversize body with a content-length", async () => {
    const response = await post(report({ note: "x".repeat(20_000) }));
    expect(response.status).toBe(413);
  });

  it("an oversize body without a content-length", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{" + " ".repeat(20_000)));
        controller.close();
      },
    });
    const response = await worker.fetch(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
      env as Env,
    );
    expect(response.status).toBe(413);
  });

  it("the wrong content type", async () => {
    expect((await post(report(), { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await post(report(), { headers: { "content-type": "" } })).status).toBe(415);
    expect(await rows("reports")).toHaveLength(0);
  });

  it("a body that is not JSON", async () => {
    expect((await post("{nope", { raw: true })).status).toBe(400);
  });

  it("a body that is not UTF-8", async () => {
    const response = await worker.fetch(
      new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0x7b, 0xff, 0x7d]) }),
      env as Env,
    );
    expect(response.status).toBe(400);
  });

  it("other methods and paths", async () => {
    expect((await worker.fetch(new Request(URL_), env as Env)).status).toBe(405);
    expect((await worker.fetch(new Request("https://report.example/"), env as Env)).status).toBe(404);
  });
});

describe("storage", () => {
  it("stores both reasons sorted as a JSON array, with the full version and build", async () => {
    const response = await post(report({ reasons: ["tracker-kept", "link-broke"], appVersion: "1.4.2", appBuild: 42 }));
    expect(response.status).toBe(201);
    const [row] = (await rows("reports")) as { reasons: string; app_version: string; app_build: number }[];
    expect(row.reasons).toBe('["link-broke","tracker-kept"]');
    expect([row.app_version, row.app_build]).toEqual(["1.4.2", 42]);
  });

  it("stores only report fields and the receive day, never network or header data", async () => {
    const response = await post(report({ note: "hello" }), {
      headers: {
        "cf-connecting-ip": "203.0.113.77",
        "x-forwarded-for": "203.0.113.77",
        "user-agent": "DecantTest/9.9 (iPhone)",
        "accept-language": "pt-PT",
        authorization: "Bearer secret-token",
      },
    });
    expect(response.status).toBe(201);
    const stored = await rows("reports");
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]).sort()).toEqual(
      ["app_build", "app_version", "day", "host", "id", "note", "parameters", "reasons", "report_id", "rules_generation"].sort(),
    );
    const dump = JSON.stringify([stored, await rows("daily_counter"), await rows("counts")]);
    for (const leak of ["203.0.113.77", "DecantTest", "pt-PT", "secret-token"]) expect(dump).not.toContain(leak);
    expect(stored[0].day).toBe(new Date().toISOString().slice(0, 10));
  });

  it("stores a repeated reportId once and answers success both times", async () => {
    const body = report();
    expect((await post(body)).status).toBe(201);
    expect((await post(body)).status).toBe(201);
    expect(await rows("reports")).toHaveLength(1);
    expect(await rows("daily_counter")).toEqual([expect.objectContaining({ n: 1 })]);
  });

  it("keeps a repeated send out of the daily cap", async () => {
    const first = report();
    expect((await post(first, { env: { DAILY_CAP: "1" } })).status).toBe(201);
    expect((await post(first, { env: { DAILY_CAP: "1" } })).status).toBe(201);
    expect((await post(report(), { env: { DAILY_CAP: "1" } })).status).toBe(429);
    expect(await rows("reports")).toHaveLength(1);
  });
});

describe("daily cap", () => {
  it("answers 429 once the cap is reached and stores nothing more", async () => {
    const options = { env: { DAILY_CAP: "2" } };
    expect((await post(report(), options)).status).toBe(201);
    expect((await post(report(), options)).status).toBe(201);
    const over = await post(report(), options);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ status: "capped" });
    expect(await rows("reports")).toHaveLength(2);
  });

  it("counts only accepted reports, not rejected ones", async () => {
    await post({ nope: true }, { env: { DAILY_CAP: "1" } });
    expect((await post(report(), { env: { DAILY_CAP: "1" } })).status).toBe(201);
  });
});

describe("storage ceiling", () => {
  it("answers 429 once the raw reports reach the ceiling, repeats still succeed", async () => {
    const options = { env: { MAX_RAW_REPORTS: "2" } };
    const first = report();
    expect((await post(first, options)).status).toBe(201);
    expect((await post(report(), options)).status).toBe(201);
    const over = await post(report(), options);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ status: "capped" });
    expect((await post(first, options)).status).toBe(201);
    expect(await rows("reports")).toHaveLength(2);
    expect(await rows("raw_total")).toEqual([{ id: 1, n: 2 }]);
  });
});

describe("kill switch", () => {
  it("answers 503 paused and stores nothing", async () => {
    const response = await post(report(), { env: { PAUSED: "1" } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "paused" });
    expect(await rows("reports")).toHaveLength(0);
  });

  it("answers paused even for a bad payload, so the app sees one clear state", async () => {
    expect((await post({ nope: true }, { env: { PAUSED: "1" } })).status).toBe(503);
  });

  it("treats any setting other than unset, empty or 0 as paused, so a typo fails safe", async () => {
    for (const value of ["1", "true", "yes", " 1 ", "paused"]) {
      expect((await post(report(), { env: { PAUSED: value } })).status).toBe(503);
    }
    for (const value of [undefined, "", "0", " 0 "]) {
      expect((await post(report(), { env: { PAUSED: value } })).status).toBe(201);
    }
  });
});

describe("failure", () => {
  it("answers a plain 500 without detail when the database fails", async () => {
    const broken = {
      batch: () => Promise.reject(new Error("D1 exploded with secret detail")),
      prepare: () => ({ bind: () => ({}) }),
    } as unknown as D1Database;
    const response = await post(report(), { env: { DB: broken } });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"status":"error"}');
  });

  it("sends nosniff and no-store on every answer", async () => {
    for (const response of [await post(report()), await post({ nope: true }), await post(report(), { env: { PAUSED: "1" } })]) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("retention", () => {
  const NOW = new Date("2026-11-17T12:00:00Z");
  type Stored = { name: string; outcome: string; flagged: boolean };
  const insertParameters = (day: string, host: string, parameters: Stored[], kind = "tracker-kept") =>
    env.DB.prepare(
      "INSERT INTO reports (report_id, day, reasons, host, app_version, app_build, note, rules_generation, parameters) VALUES (?, ?, ?, ?, '1.4.2', 42, 'private note', 17, ?)",
    ).bind(freshId(), day, JSON.stringify(kind.split(",")), host, JSON.stringify(parameters.map((p) => ({ ...p, length: 3, charset: "alpha" }))));
  const insert = (day: string, host: string, removed: string[], kept: string[], kind = "tracker-kept") =>
    insertParameters(day, host, [
      ...removed.map((name) => ({ name, outcome: "removed-by-rules", flagged: false })),
      ...kept.map((name) => ({ name, outcome: "kept", flagged: false })),
    ], kind);

  it("deletes raw reports older than 180 days and keeps counts per host, parameter and reason", async () => {
    await env.DB.batch([
      insert("2026-05-01", "www.youtube.com", ["utm_source"], ["si"]),
      insert("2026-05-02", "www.youtube.com", ["utm_source"], ["si"]),
      insert("2026-05-02", "www.youtube.com", [], ["si"], "link-broke"),
      insert("2026-05-21", "www.youtube.com", ["fbclid"], []),
      insert("2026-05-22", "example.com", ["utm_source"], []),
      insert("2026-11-17", "example.com", ["utm_source"], []),
    ]);

    await runRetention(env.DB, NOW);

    const left = (await rows("reports")) as { day: string }[];
    expect(left.map((r) => r.day).sort()).toEqual(["2026-05-21", "2026-05-22", "2026-11-17"]);
    const counts = (await rows("counts")) as { host: string; param: string; reason: string; outcome: string; n: number }[];
    const pick = (host: string, param: string, reason: string, outcome: string) =>
      counts.find((c) => c.host === host && c.param === param && c.reason === reason && c.outcome === outcome)?.n;
    expect(pick("www.youtube.com", "utm_source", "tracker-kept", "removed-by-rules")).toBe(2);
    expect(pick("www.youtube.com", "si", "tracker-kept", "kept")).toBe(2);
    expect(pick("www.youtube.com", "si", "link-broke", "kept")).toBe(1);
    expect(counts).toHaveLength(3);
  });

  it("counts a report with both reasons under each reason", async () => {
    await env.DB.batch([insert("2026-01-01", "example.com", [], ["si"], "link-broke,tracker-kept")]);
    await runRetention(env.DB, NOW);
    const counts = (await rows("counts")) as { reason: string; n: number }[];
    expect(counts.map((c) => [c.reason, c.n]).sort()).toEqual([["link-broke", 1], ["tracker-kept", 1]]);
  });

  it("counts each outcome separately, with how many of them the person flagged", async () => {
    await env.DB.batch([
      insertParameters("2026-01-01", "example.com", [{ name: "ref", outcome: "removed-by-you", flagged: true }]),
      insertParameters("2026-01-02", "example.com", [{ name: "ref", outcome: "removed-by-you", flagged: false }]),
      insertParameters("2026-01-03", "example.com", [{ name: "ref", outcome: "restored-by-you", flagged: true }]),
      insertParameters("2026-01-04", "example.com", [{ name: "ref", outcome: "kept", flagged: false }]),
    ]);
    await runRetention(env.DB, NOW);
    const counts = (await rows("counts")) as { outcome: string; n: number; flagged_n: number }[];
    const by = Object.fromEntries(counts.map((c) => [c.outcome, [c.n, c.flagged_n]]));
    expect(by).toEqual({ "removed-by-you": [2, 1], "restored-by-you": [1, 1], kept: [1, 0] });
  });
  it("keeps no report ID or note in the counts and does not double count on a second run", async () => {
    await env.DB.batch([insert("2026-01-01", "example.com", ["utm_source"], [])]);
    await runRetention(env.DB, NOW);
    await runRetention(env.DB, NOW);
    expect(await rows("reports")).toHaveLength(0);
    const counts = await rows("counts");
    expect(counts).toEqual([{ host: "example.com", param: "utm_source", reason: "tracker-kept", outcome: "removed-by-rules", n: 1, flagged_n: 0 }]);
    expect(JSON.stringify(counts)).not.toContain("private note");
  });

  it("resyncs the raw total so room opens up after old reports are deleted", async () => {
    const options = { env: { MAX_RAW_REPORTS: "2" } };
    await env.DB.batch([insert("2026-01-01", "example.com", ["a"], []), insert("2026-01-02", "example.com", ["a"], [])]);
    await env.DB.prepare("INSERT INTO raw_total (id, n) VALUES (1, 2)").run();
    expect((await post(report(), options)).status).toBe(429);
    await runRetention(env.DB, NOW);
    expect(await rows("raw_total")).toEqual([{ id: 1, n: 0 }]);
    expect((await post(report(), options)).status).toBe(201);
  });

  it("runs from the scheduled handler", async () => {
    await env.DB.batch([insert("2026-01-01", "example.com", ["a"], [])]);
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "17 3 * * *", noRetry() {} } as ScheduledController, env as Env);
    expect(await rows("reports")).toHaveLength(0);
    expect(await rows("counts")).toHaveLength(1);
  });
});
