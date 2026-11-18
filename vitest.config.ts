import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "schema", include: ["test/schema/**/*.test.ts", "test/triage/**/*.test.ts"], environment: "node" },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.json" },
            miniflare: {
              bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")) },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["./test/worker/apply-migrations.ts"],
        },
      },
    ],
  },
});
