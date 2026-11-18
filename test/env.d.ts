declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PAUSED?: string;
    DAILY_CAP?: string;
    MAX_RAW_REPORTS?: string;
    EMAIL?: import("../src/digest").EmailSender;
    DIGEST_TO?: string;
    DIGEST_FROM?: string;
    DIGEST_LABEL?: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
