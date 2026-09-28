import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PUBLIC_URL: "https://bot.test",
            ADMIN_TG_IDS: "1000",
            TELEGRAM_BOT_TOKEN: "tg-token",
            TELEGRAM_WEBHOOK_SECRET: "tg-secret",
            GOOGLE_CLIENT_ID: "gid",
            GOOGLE_CLIENT_SECRET: "gsecret",
            OPENROUTER_API_KEY: "or-key",
            ELEVENLABS_API_KEY: "el-key",
            ENCRYPTION_KEY: "test-encryption-key",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
