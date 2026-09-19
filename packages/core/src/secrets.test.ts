import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as index from "./index.js";
import * as secrets from "./secrets.js";

const SECRET_RETURNING = [
  "createKeystoreWithPhrase",
  "decryptPrivateKey",
  "exportKeystoreKeys",
  "exportRecoveryPhrase",
] as const;

describe("@vapi-network/core/secrets", () => {
  it("is the only entry point that returns a phrase or a private key", () => {
    for (const name of SECRET_RETURNING) {
      expect(typeof Reflect.get(secrets, name)).toBe("function");
      expect(Reflect.has(index, name)).toBe(false);
    }
  });

  it("leaves the account-only creation path on the main entry point", () => {
    expect(typeof index.createKeystore).toBe("function");
    expect(typeof index.createKeystoreFromPrivateKey).toBe("function");
    expect(typeof index.unlockKeystore).toBe("function");
    expect(typeof index.KeystoreError).toBe("function");
  });

  it("is declared as a package entry point with its own build output", async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as {
      exports: Record<string, { types: string; import: string }>;
      scripts: { build: string };
    };

    expect(manifest.exports["./secrets"]).toEqual({
      types: "./dist/secrets.d.ts",
      import: "./dist/secrets.js",
    });
    expect(manifest.scripts.build).toContain("secrets=src/secrets.ts");
  });
});
