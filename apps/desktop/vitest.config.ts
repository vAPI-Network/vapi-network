import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __VAPI_DESKTOP_SIGNED__: false },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
