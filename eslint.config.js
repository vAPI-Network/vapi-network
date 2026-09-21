import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/coverage/**", "**/dist/**", "**/node_modules/**", "**/publish/**", "_import/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    // The MCP server is the surface an agent drives, so it may never reach a
    // recovery phrase, a private key, or the registry key a provider publishes
    // with. See plan 001, "Safety model". There is no publish tool on purpose.
    files: ["packages/mcp/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@vapi-network/core/secrets",
              message:
                "The MCP server must never import a secret-returning function. Secrets stay in the CLI, in front of a person.",
            },
            {
              name: "@vapi-network/core/api-key",
              message:
                "The MCP server must never reach the registry API key. Publishing is a human act, in the CLI.",
            },
          ],
          patterns: [
            {
              group: ["**/core/src/secrets", "**/core/src/secrets.js"],
              message:
                "The MCP server must never import a secret-returning function. Secrets stay in the CLI, in front of a person.",
            },
            {
              group: ["**/core/src/api-key", "**/core/src/api-key.js"],
              message:
                "The MCP server must never reach the registry API key. Publishing is a human act, in the CLI.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    rules: {
      "no-undef": "off",
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
