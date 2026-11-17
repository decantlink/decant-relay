declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PAUSED?: string;
    DAILY_CAP?: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
