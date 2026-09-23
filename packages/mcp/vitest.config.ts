import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vapi-network/core/agent-link": fileURLToPath(
        new URL("../core/src/agent-link.ts", import.meta.url),
      ),
      "@vapi-network/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@vapi-network/sources": fileURLToPath(new URL("../sources/src/index.ts", import.meta.url)),
    },
  },
});
