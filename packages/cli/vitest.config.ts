import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vapi-network/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@vapi-network/sources": fileURLToPath(new URL("../sources/src/index.ts", import.meta.url)),
      "@vapi-network/mcp": fileURLToPath(new URL("../mcp/src/index.ts", import.meta.url)),
    },
  },
});
