import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileSecretStore,
  FILE_SECRET_STORE_MIN_PASSWORD,
  FILE_SECRET_STORE_PASSWORD_ENV,
  fileSecretStore,
} from "./file-secret-store.js";
import { KeystoreError } from "./keystore.js";

const PASSWORD = "correct horse battery";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function freshPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-file-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "secrets.json");
}

describe("file secret store", () => {
  it("round-trips entries and never writes them in plain text", async () => {
    const path = await freshPath();
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    await createFileSecretStore({ path, env });
    const store = fileSecretStore({ path, env });

    await store.set("vault-key", "c2VjcmV0LWRldmljZS1rZXk=");
    expect(await store.get("vault-key")).toBe("c2VjcmV0LWRldmljZS1rZXk=");
    expect(await store.has("vault-key")).toBe(true);
    expect(await readFile(path, "utf8")).not.toContain("c2VjcmV0LWRldmljZS1rZXk=");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.remove("vault-key")).toBe(true);
    expect(await store.remove("vault-key")).toBe(false);
    expect(await store.get("vault-key")).toBeUndefined();
  });

  it("refuses a wrong password before reading", async () => {
    const path = await freshPath();
    await createFileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: PASSWORD } });
    const store = fileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: "wrong password here" } });
    await expect(store.get("vault-key")).rejects.toThrow("Wrong VAPI_VAULT_PASSWORD");
  });

  it("refuses without a password and never falls back to plain text", async () => {
    const path = await freshPath();
    await createFileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: PASSWORD } });
    const store = fileSecretStore({ path, env: {} });
    expect(store.available).toBe(false);
    await expect(store.set("vault-key", "x")).rejects.toThrow("VAPI_VAULT_PASSWORD");
  });

  it("refuses to create with a short password", async () => {
    const path = await freshPath();
    await expect(
      createFileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: "short" } }),
    ).rejects.toThrow("at least 12 characters");
  });

  it("keeps both writers' entries when two run at once", async () => {
    const path = await freshPath();
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    await createFileSecretStore({ path, env });
    await Promise.all([
      fileSecretStore({ path, env }).set("a", "1"),
      fileSecretStore({ path, env }).set("b", "2"),
    ]);
    const store = fileSecretStore({ path, env });
    expect([await store.get("a"), await store.get("b")]).toEqual(["1", "2"]);
  });

  it("creates a private directory and keeps file permissions after rewrites", async () => {
    const path = join(dirname(await freshPath()), "nested", "secrets.json");
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    await createFileSecretStore({ path, env });
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const store = fileSecretStore({ path, env });
    await store.set("vault-key", "private device key");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await store.remove("vault-key");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("never includes passwords or stored values in wrong-password or missing-password errors", async () => {
    const path = await freshPath();
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    const wrongPassword = "wrong password here";
    const value = "private device key redaction sentinel";
    await createFileSecretStore({ path, env });
    await fileSecretStore({ path, env }).set("vault-key", value);
    const original = await readFile(path, "utf8");

    for (const password of [wrongPassword, undefined]) {
      const store = fileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: password } });
      const failures = [
        () => store.get("vault-key"),
        () => store.has("vault-key"),
        () => store.set("vault-key", value),
        () => store.remove("vault-key"),
      ];
      for (const fail of failures) {
        const result = fail();
        await expect(result).rejects.toBeInstanceOf(KeystoreError);
        await expect(result).rejects.toThrow("VAPI_VAULT_PASSWORD");
        for (const secret of [PASSWORD, wrongPassword, value]) {
          await expect(result).rejects.not.toThrow(secret);
        }
      }
    }
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("does not create a file with a missing or short password or echo it in an error", async () => {
    const path = await freshPath();
    const password = "pw-9xq";
    const result = createFileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: password } });
    await expect(result).rejects.toBeInstanceOf(KeystoreError);
    await expect(result).rejects.toThrow("at least 12 characters");
    await expect(result).rejects.not.toThrow(password);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(createFileSecretStore({ path, env: {} })).rejects.toThrow("VAPI_VAULT_PASSWORD");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports damaged JSON without echoing file contents", async () => {
    const path = await freshPath();
    const contents = "not json";
    await writeFile(path, contents, { mode: 0o600 });
    const result = fileSecretStore({ path, env: { VAPI_VAULT_PASSWORD: PASSWORD } }).get(
      "vault-key",
    );
    await expect(result).rejects.toBeInstanceOf(KeystoreError);
    await expect(result).rejects.toThrow("damaged");
    await expect(result).rejects.not.toThrow(contents);
    await expect(result).rejects.not.toHaveProperty("cause");
  });

  it("seals every entry and includes an encrypted password check", async () => {
    const path = await freshPath();
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    await createFileSecretStore({ path, env });
    const store = fileSecretStore({ path, env });
    const entries = {
      "vault-key": "device-key-plaintext-sentinel",
      "agent-link": "agent-link-plaintext-sentinel",
      "api-key": "api-key-plaintext-sentinel",
    };
    for (const [name, value] of Object.entries(entries)) await store.set(name, value);

    const raw = await readFile(path, "utf8");
    const file = JSON.parse(raw) as {
      salt: string;
      check: { nonce: string; ciphertext: string; tag: string };
      entries: Record<string, { nonce: string; ciphertext: string; tag: string }>;
    };
    expect(Buffer.from(file.salt, "base64")).toHaveLength(32);
    expect(file.check).toEqual({
      nonce: expect.any(String),
      ciphertext: expect.any(String),
      tag: expect.any(String),
    });
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain("vapi-network file secret store");
    for (const [name, value] of Object.entries(entries)) {
      expect(raw).not.toContain(value);
      expect(file.entries[name]).toEqual({
        nonce: expect.any(String),
        ciphertext: expect.any(String),
        tag: expect.any(String),
      });
      expect(await store.get(name)).toBe(value);
    }
    expect(new Set(Object.values(file.entries).map((entry) => entry.nonce)).size).toBe(3);
  });

  it("reads the password from the environment on every call", async () => {
    const path = await freshPath();
    const env: NodeJS.ProcessEnv = {};
    const store = fileSecretStore({ path, env });
    expect(store.available).toBe(false);
    expect(store.platform).toBe(process.platform);
    expect(store.description).toBe("the encrypted vAPI secrets file");
    expect(FILE_SECRET_STORE_PASSWORD_ENV).toBe("VAPI_VAULT_PASSWORD");
    expect(FILE_SECRET_STORE_MIN_PASSWORD).toBe(12);

    env.VAPI_VAULT_PASSWORD = PASSWORD;
    await createFileSecretStore({ path, env });
    await store.set("vault-key", "lazy password sentinel");
    expect(fileSecretStore({ path, env }).available).toBe(true);
    env.VAPI_VAULT_PASSWORD = "wrong password here";
    await expect(store.get("vault-key")).rejects.toThrow("Wrong VAPI_VAULT_PASSWORD");
    delete env.VAPI_VAULT_PASSWORD;
    await expect(store.get("vault-key")).rejects.toThrow("VAPI_VAULT_PASSWORD");
    env.VAPI_VAULT_PASSWORD = PASSWORD;
    expect(await store.get("vault-key")).toBe("lazy password sentinel");
  });

  it("keeps a concurrent set when removing another entry", async () => {
    const path = await freshPath();
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    await createFileSecretStore({ path, env });
    const store = fileSecretStore({ path, env });
    await store.set("a", "old secret");
    await Promise.all([store.remove("a"), fileSecretStore({ path, env }).set("b", "new secret")]);
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBe("new secret");
  });

  it("does not mistake inherited object properties for stored entries", async () => {
    const path = await freshPath();
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    await createFileSecretStore({ path, env });
    const store = fileSecretStore({ path, env });
    for (const name of ["constructor", "toString"]) {
      expect(await store.get(name)).toBeUndefined();
      expect(await store.has(name)).toBe(false);
      expect(await store.remove(name)).toBe(false);
      await store.set(name, "stored property name sentinel");
      expect(await store.get(name)).toBe("stored property name sentinel");
      expect(await store.remove(name)).toBe(true);
    }
  });

  it("refuses the reserved prototype name instead of silently losing a secret", async () => {
    const path = await freshPath();
    const env = { VAPI_VAULT_PASSWORD: PASSWORD };
    await createFileSecretStore({ path, env });
    const store = fileSecretStore({ path, env });
    const original = await readFile(path, "utf8");
    await expect(store.set("__proto__", "prototype sentinel")).rejects.toThrow(KeystoreError);
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
