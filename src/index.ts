import { type DigestEnv, sendDigest } from "./digest";
import { runRetention } from "./retention";
import { storeReport } from "./store";
import { validateReport } from "./validate";

export type Env = DigestEnv;

const MAX_BODY_BYTES = 16_384;
const DEFAULT_DAILY_CAP = 5000;
const DEFAULT_MAX_RAW_REPORTS = 50_000;

const reply = (status: number, body: Record<string, string>, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });

async function readBounded(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const isPaused = (env: Env) => env.PAUSED !== undefined && env.PAUSED.trim() !== "" && env.PAUSED.trim() !== "0";

const positiveInteger = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/v1/report") return reply(404, { status: "not-found" });
    if (request.method !== "POST") return reply(405, { status: "method-not-allowed" }, { allow: "POST" });
    if (isPaused(env)) return reply(503, { status: "paused" });

    const mediaType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (mediaType !== "application/json") return reply(415, { status: "unsupported-media-type" });

    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) return reply(413, { status: "too-large" });
    const bytes = await readBounded(request);
    if (bytes === null) return reply(413, { status: "too-large" });

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      return reply(400, { status: "rejected", reason: "payload: not valid JSON" });
    }
    const checked = validateReport(payload);
    if (!checked.ok) return reply(400, { status: "rejected", reason: checked.error });

    const day = new Date().toISOString().slice(0, 10);
    let result;
    try {
      result = await storeReport(
        env.DB,
        checked.report,
        day,
        positiveInteger(env.DAILY_CAP, DEFAULT_DAILY_CAP),
        positiveInteger(env.MAX_RAW_REPORTS, DEFAULT_MAX_RAW_REPORTS),
      );
    } catch {
      return reply(500, { status: "error" });
    }
    return result === "capped" ? reply(429, { status: "capped" }) : reply(201, { status: "accepted" });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    let failure: unknown;
    try {
      await runRetention(env.DB, now);
    } catch (error) {
      failure = error;
    }
    try {
      await sendDigest(env, now, failure !== undefined);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  },
} satisfies ExportedHandler<Env>;
