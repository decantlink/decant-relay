import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDigest, type DigestEnv, type DigestInput, sendDigest } from "../../src/digest";
import worker from "../../src/index";

const WED = new Date("2026-11-18T03:17:00Z");
const MON = new Date("2026-11-23T03:17:00Z");
const NOTE = "private words the sender typed";
const param = (name: string) => JSON.stringify([{ name, length: 10, charset: "base64url" }]);

let seq = 0;
const seed = async (day: string, host: string, name: string, kind = "tracker-kept", note: string | null = NOTE) => {
  const reportId = `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
  await env.DB.prepare("INSERT INTO reports (report_id, day, kind, host, app_major, note, removed, kept) VALUES (?1,?2,?3,?4,1,?5,?6,'[]')")
    .bind(reportId, day, kind, host, note, param(name))
    .run();
  await env.DB.prepare("INSERT INTO raw_total (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = n + 1").run();
  return reportId;
};

const mailbox = () => {
  const sent: { to: string; from: string; subject: string; text: string }[] = [];
  return { sent, EMAIL: { send: async (m: (typeof sent)[number]) => void sent.push(m) } };
};
const configured = (extra: Partial<DigestEnv> = {}): DigestEnv & ReturnType<typeof mailbox> => {
  const box = mailbox();
  return { ...env, ...box, DIGEST_TO: "alias@example.test", DIGEST_FROM: "relay@example.test", ...extra } as never;
};
const marker = async () => (await env.DB.prepare("SELECT last_day FROM digest_state").first<{ last_day: string }>())?.last_day ?? null;

const quiet: DigestInput = {
  label: "",
  newByKind: {},
  pairs: [],
  pairsOmitted: false,
  otherReports: 0,
  oldestAgeDays: 12,
  peakAccepted: 10,
  dailyCap: 5000,
  rawTotal: 100,
  maxRawReports: 50_000,
  paused: false,
  retentionFailed: false,
  heartbeat: false,
};

beforeEach(async () => {
  await env.DB.batch(["reports", "daily_counter", "counts", "raw_total", "digest_state"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("buildDigest", () => {
  it("sends nothing on a quiet day", () => expect(buildDigest(quiet)).toBeNull());

  it("sends a heartbeat on a quiet day", () => {
    const digest = buildDigest({ ...quiet, heartbeat: true });
    expect(digest?.subject).toBe("Decant reports: 0 new");
    expect(digest?.text).toContain("Relay: running");
  });

  it("warns when retention looks failed", () => {
    expect(buildDigest({ ...quiet, oldestAgeDays: 181 })).toBeNull();
    const digest = buildDigest({ ...quiet, oldestAgeDays: 182 });
    expect(digest?.subject).toContain("warning");
    expect(digest?.text).toContain("WARNING: The oldest raw report is 182 days old");
  });

  it("warns near the daily cap and the storage ceiling", () => {
    expect(buildDigest({ ...quiet, peakAccepted: 3999 })).toBeNull();
    expect(buildDigest({ ...quiet, peakAccepted: 4000 })?.text).toContain("daily cap of 5000");
    expect(buildDigest({ ...quiet, rawTotal: 40_000 })?.text).toContain("ceiling of 50000");
  });

  it("does not treat a paused relay as a warning by itself", () => {
    expect(buildDigest({ ...quiet, paused: true })).toBeNull();
    expect(buildDigest({ ...quiet, paused: true, heartbeat: true })?.text).toContain("Relay: paused");
  });

  it("flags a failed retention run and prefixes the label", () => {
    const digest = buildDigest({ ...quiet, retentionFailed: true, label: "staging" });
    expect(digest?.subject).toBe("[staging] Decant reports: 0 new, warning");
    expect(digest?.text).toContain("retention job failed");
  });

  it("lists pairs and the rest as a count, and strips non-printable characters", () => {
    const digest = buildDigest({
      ...quiet,
      newByKind: { "link-broke": 1, "tracker-kept": 5 },
      pairs: [{ host: "a.example", param: "si\nBcc: x", n: 4 }],
      otherReports: 2,
    });
    expect(digest?.text).toContain("New since the last digest: 6 (link-broke 1, tracker-kept 5)");
    expect(digest?.text).toContain("- a.example / si?Bcc: x: 4");
    expect(digest?.text).toContain("2 reports from other sites.");
  });
});

describe("sendDigest", () => {
  it("lists a pair at 3 reports, counts a pair at 2 as other sites, and never shows notes or report IDs", async () => {
    const ids = [
      await seed("2026-11-17", "a.example", "si"),
      await seed("2026-11-17", "a.example", "si"),
      await seed("2026-11-16", "a.example", "si", "link-broke"),
      await seed("2026-11-17", "b.example", "fbclid"),
      await seed("2026-11-17", "b.example", "fbclid"),
    ];
    const e = configured();
    await sendDigest(e, WED, false);
    expect(e.sent).toHaveLength(1);
    const { text, subject, to, from } = e.sent[0];
    expect([to, from]).toEqual(["alias@example.test", "relay@example.test"]);
    expect(subject).toBe("Decant reports: 5 new");
    expect(text).toContain("New since the last digest: 5 (link-broke 1, tracker-kept 4)");
    expect(text).toContain("- a.example / si: 3");
    expect(text).not.toContain("b.example");
    expect(text).toContain("2 reports from other sites.");
    expect(text).not.toContain(NOTE);
    for (const id of ids) expect(text).not.toContain(id);
    expect(await marker()).toBe("2026-11-17");
  });

  it("leaves out the current day and anything already covered", async () => {
    await seed("2026-11-18", "a.example", "si");
    const e = configured();
    await sendDigest(e, WED, false);
    expect(e.sent).toHaveLength(0);

    await seed("2026-11-17", "a.example", "si");
    await sendDigest(e, WED, false);
    expect(e.sent).toHaveLength(1);
    await sendDigest(e, WED, false);
    expect(e.sent).toHaveLength(1);
    await sendDigest(e, new Date("2026-11-19T03:17:00Z"), false);
    expect(e.sent).toHaveLength(2);
    expect(e.sent[1].text).toContain("New since the last digest: 1");
  });

  it("sends nothing on a quiet day and sends the weekly heartbeat on Monday", async () => {
    const e = configured();
    await sendDigest(e, WED, false);
    expect(e.sent).toHaveLength(0);
    expect(await marker()).toBeNull();
    await sendDigest(e, MON, false);
    expect(e.sent).toHaveLength(1);
    expect(e.sent[0].subject).toBe("Decant reports: 0 new");
  });

  it("keeps the marker when the send fails, so the next night covers those reports", async () => {
    await seed("2026-11-17", "a.example", "si");
    const failing = configured({
      EMAIL: {
        send: async () => {
          throw new Error("send failed");
        },
      },
    });
    await expect(sendDigest(failing, WED, false)).rejects.toThrow("send failed");
    expect(await marker()).toBeNull();

    const e = configured();
    await sendDigest(e, new Date("2026-11-19T03:17:00Z"), false);
    expect(e.sent[0].text).toContain("New since the last digest: 1");
    expect(await marker()).toBe("2026-11-18");
  });

  it("is a no-op until the email binding and both addresses are configured", async () => {
    await seed("2026-11-17", "a.example", "si");
    for (const missing of ["EMAIL", "DIGEST_TO", "DIGEST_FROM"] as const) {
      const e = configured({ [missing]: undefined });
      await sendDigest(e, WED, false);
      expect(e.sent).toHaveLength(0);
    }
    expect(await marker()).toBeNull();
  });

  it("a purge cannot move the marker backwards or skip reports", async () => {
    await seed("2026-11-17", "a.example", "si");
    const e = configured();
    await sendDigest(e, WED, false);
    await env.DB.batch(["reports", "raw_total"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    for (let i = 0; i < 4; i++) await seed("2026-11-18", "c.example", "ref");
    await sendDigest(e, new Date("2026-11-19T03:17:00Z"), false);
    expect(e.sent[1].text).toContain("New since the last digest: 4");
  });
});

describe("scheduled", () => {
  const controller = (when: Date) => ({ scheduledTime: when.getTime(), cron: "17 3 * * *", noRetry() {} }) as ScheduledController;

  it("runs retention, then sends the digest", async () => {
    await seed("2025-01-01", "old.example", "si");
    await seed("2026-11-17", "a.example", "si");
    const e = configured();
    await worker.scheduled(controller(WED), e);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>())?.n).toBe(1);
    expect(e.sent).toHaveLength(1);
  });

  it("still sends the digest, with the warning, when retention fails, then fails the run", async () => {
    await seed("2026-11-17", "a.example", "si");
    let batches = 0;
    const failFirstBatch = new Proxy(env.DB, {
      get: (target, key) => {
        if (key === "batch") return (statements: D1PreparedStatement[]) => (batches++ === 0 ? Promise.reject(new Error("retention down")) : target.batch(statements));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const e = configured({ DB: failFirstBatch as D1Database });
    await expect(worker.scheduled(controller(WED), e)).rejects.toThrow("retention down");
    expect(e.sent).toHaveLength(1);
    expect(e.sent[0].text).toContain("WARNING: The retention job failed");
  });
});
