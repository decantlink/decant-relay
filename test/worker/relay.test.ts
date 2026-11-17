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
  await env.DB.batch(["reports", "daily_counter", "counts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
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
    const response = await post(report({ kept: [{ name: "si", value: "abc", shape: { length: 3, charset: "alpha" } }] }));
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
      ["app_major", "day", "host", "id", "kept", "kind", "note", "removed", "report_id"].sort(),
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
});

describe("retention", () => {
  const NOW = new Date("2026-11-17T12:00:00Z");
  const insert = (day: string, host: string, removed: string[], kept: string[], kind = "tracker-kept") =>
    env.DB.prepare(
      "INSERT INTO reports (report_id, day, kind, host, app_major, note, removed, kept) VALUES (?, ?, ?, ?, 1, 'private note', ?, ?)",
    ).bind(
      freshId(),
      day,
      kind,
      host,
      JSON.stringify(removed.map((name) => ({ name, length: 3, charset: "alpha" }))),
      JSON.stringify(kept.map((name) => ({ name, length: 3, charset: "alpha" }))),
    );

  it("deletes raw reports older than 180 days and keeps counts per host, parameter and kind", async () => {
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
    const counts = (await rows("counts")) as { host: string; param: string; kind: string; outcome: string; n: number }[];
    const pick = (host: string, param: string, kind: string, outcome: string) =>
      counts.find((c) => c.host === host && c.param === param && c.kind === kind && c.outcome === outcome)?.n;
    expect(pick("www.youtube.com", "utm_source", "tracker-kept", "removed")).toBe(2);
    expect(pick("www.youtube.com", "si", "tracker-kept", "kept")).toBe(2);
    expect(pick("www.youtube.com", "si", "link-broke", "kept")).toBe(1);
    expect(counts).toHaveLength(3);
  });

  it("keeps no report ID or note in the counts and does not double count on a second run", async () => {
    await env.DB.batch([insert("2026-01-01", "example.com", ["utm_source"], [])]);
    await runRetention(env.DB, NOW);
    await runRetention(env.DB, NOW);
    expect(await rows("reports")).toHaveLength(0);
    const counts = await rows("counts");
    expect(counts).toEqual([{ host: "example.com", param: "utm_source", kind: "tracker-kept", outcome: "removed", n: 1 }]);
    expect(JSON.stringify(counts)).not.toContain("private note");
  });

  it("runs from the scheduled handler", async () => {
    await env.DB.batch([insert("2026-01-01", "example.com", ["a"], [])]);
    await worker.scheduled({ scheduledTime: NOW.getTime(), cron: "17 3 * * *", noRetry() {} } as ScheduledController, env as Env);
    expect(await rows("reports")).toHaveLength(0);
    expect(await rows("counts")).toHaveLength(1);
  });
});
