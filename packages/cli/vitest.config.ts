import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The more specific entry point has to come first: an alias key also
      // matches every import that starts with it.
      "@vapi-network/core/secrets": fileURLToPath(
        new URL("../core/src/secrets.ts", import.meta.url),
      ),
      "@vapi-network/core/api-key": fileURLToPath(
        new URL("../core/src/api-key.ts", import.meta.url),
      ),
      "@vapi-network/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@vapi-network/sources": fileURLToPath(new URL("../sources/src/index.ts", import.meta.url)),
      "@vapi-network/mcp": fileURLToPath(new URL("../mcp/src/index.ts", import.meta.url)),
    },
  },
});
