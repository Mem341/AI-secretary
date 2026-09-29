import { defineConfig } from "vitest/config";

// `npm run eval:models` — compares OpenRouter models on real bot requests. Not part of `npm test`: it calls the
// real OpenRouter API with OPENROUTER_API_KEY (Google is not touched, the tools answer with sample data).
export default defineConfig({
  test: {
    environment: "node",
    include: ["eval/**/*.eval.ts"],
    testTimeout: 30 * 60_000,
  },
});
