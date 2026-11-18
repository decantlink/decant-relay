declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PAUSED?: string;
    DAILY_CAP?: string;
    MAX_RAW_REPORTS?: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
