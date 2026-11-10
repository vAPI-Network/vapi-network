import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KeystoreError } from "./keystore.js";
import {
  chooseSecretBackend,
  readSecretBackend,
  secretBackendPath,
  secretsFilePath,
} from "./secret-backend.js";
import { memorySecretStore, type SecretStore } from "./secret-store.js";

const brokenOs: SecretStore = {
  ...memorySecretStore(),
  available: true,
  platform: "linux",
  set: async () => {
    throw new KeystoreError("Cannot autolaunch D-Bus without X11 $DISPLAY");
  },
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vapi-backend-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("secret backend", () => {
  it("reads os when nothing is pinned", async () => {
    expect(readSecretBackend(await home())).toBe("os");
  });

  it("pins os when the OS store round-trips", async () => {
    const dir = await home();
    const memory = memorySecretStore();
    const os = {
      ...memory,
      platform: "linux" as const,
      set: vi.fn(memory.set),
      get: vi.fn(memory.get),
      remove: vi.fn(memory.remove),
    };
    expect(await chooseSecretBackend({ home: dir, os, env: {} })).toBe("os");
    expect(readSecretBackend(dir)).toBe("os");
    expect(os.set).toHaveBeenCalledExactlyOnceWith("setup-probe", "ok");
    expect(os.get).toHaveBeenCalledExactlyOnceWith("setup-probe");
    expect(os.remove).toHaveBeenCalledExactlyOnceWith("setup-probe");
    expect(JSON.parse(await readFile(secretBackendPath(dir), "utf8"))).toEqual({
      v: 1,
      backend: "os",
    });
    await expect(stat(secretsFilePath(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins file when the OS store fails and a password is set", async () => {
    const dir = await home();
    const env = { VAPI_VAULT_PASSWORD: "correct horse battery" };
    expect(await chooseSecretBackend({ home: dir, os: brokenOs, env })).toBe("file");
    expect(JSON.parse(await readFile(secretBackendPath(dir), "utf8"))).toEqual({
      v: 1,
      backend: "file",
    });
    expect(readSecretBackend(dir)).toBe("file");
  });

  it("explains both ways out when the OS store fails and no password is set", async () => {
    const dir = await home();
    const result = chooseSecretBackend({ home: dir, os: brokenOs, env: {} });
    await expect(result).rejects.toBeInstanceOf(KeystoreError);
    await expect(result).rejects.toThrow(/VAPI_VAULT_PASSWORD[\s\S]*own computer/u);
    await expect(result).rejects.toThrow("at least 12 characters");
    await expect(result).rejects.toThrow("Codespaces secret");
    await expect(result).rejects.toThrow("https://api.vapinetwork.ai/connect");
    await expect(stat(secretBackendPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(secretsFilePath(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no throwaway entry in a working OS store", async () => {
    const os = { ...memorySecretStore(), platform: "linux" as const };
    await chooseSecretBackend({ home: await home(), os, env: {} });
    expect(await os.has("setup-probe")).toBe(false);
  });

  it.each(["darwin", "win32", "freebsd"] as const)(
    "pins os on %s without inspecting availability or calling the store",
    async (platform) => {
      const dir = await home();
      const fail = async () => {
        throw new Error("The OS store must not be probed.");
      };
      const os = {
        ...memorySecretStore(),
        platform,
        get available(): boolean {
          throw new Error("OS availability must not be inspected.");
        },
        set: vi.fn(fail),
        get: vi.fn(fail),
        remove: vi.fn(fail),
      };

      expect(
        await chooseSecretBackend({ home: dir, os, env: { VAPI_VAULT_PASSWORD: "pw-9xq" } }),
      ).toBe("os");
      expect(os.set).not.toHaveBeenCalled();
      expect(os.get).not.toHaveBeenCalled();
      expect(os.remove).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(secretBackendPath(dir), "utf8"))).toEqual({
        v: 1,
        backend: "os",
      });
      await expect(stat(secretsFilePath(dir))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("uses the file store on Linux without probing an unavailable OS store", async () => {
    const dir = await home();
    const fail = async () => {
      throw new Error("An unavailable store must not be probed.");
    };
    const os = {
      ...memorySecretStore(),
      platform: "linux" as const,
      available: false,
      set: vi.fn(fail),
      get: vi.fn(fail),
      remove: vi.fn(fail),
    };
    const env = { VAPI_VAULT_PASSWORD: "correct horse battery" };

    expect(await chooseSecretBackend({ home: dir, os, env })).toBe("file");
    expect(os.set).not.toHaveBeenCalled();
    expect(os.get).not.toHaveBeenCalled();
    expect(os.remove).not.toHaveBeenCalled();
  });

  it("refuses a short password without creating a pin or secrets file or echoing it", async () => {
    const dir = await home();
    const password = "pw-9xq";
    const result = chooseSecretBackend({
      home: dir,
      os: brokenOs,
      env: { VAPI_VAULT_PASSWORD: password },
    });
    await expect(result).rejects.toBeInstanceOf(KeystoreError);
    await expect(result).rejects.toThrow("at least 12 characters");
    await expect(result).rejects.not.toThrow(password);
    await expect(stat(secretBackendPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(secretsFilePath(dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["os", "file"] as const)("creates a private home and %s pin", async (backend) => {
    const dir = join(await home(), "nested");
    const os = backend === "os" ? { ...memorySecretStore(), platform: "linux" as const } : brokenOs;
    const env = { VAPI_VAULT_PASSWORD: "correct horse battery" };
    expect(await chooseSecretBackend({ home: dir, os, env })).toBe(backend);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(secretBackendPath(dir))).mode & 0o777).toBe(0o600);
    if (backend === "file") {
      expect((await stat(secretsFilePath(dir))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects a Linux probe that reads back the wrong value", async () => {
    const dir = await home();
    const os = {
      ...memorySecretStore(),
      platform: "linux" as const,
      get: async () => "unexpected probe result",
    };
    const env = { VAPI_VAULT_PASSWORD: "correct horse battery" };
    expect(await chooseSecretBackend({ home: dir, os, env })).toBe("file");
    expect(await os.has("setup-probe")).toBe(false);
  });

  it("does not include raw probe errors in the setup failure", async () => {
    const secret = "probe-error-secret-sentinel";
    const os = {
      ...brokenOs,
      set: async () => {
        throw new KeystoreError(secret);
      },
    };
    const result = chooseSecretBackend({ home: await home(), os, env: {} });
    await expect(result).rejects.toThrow("VAPI_VAULT_PASSWORD");
    await expect(result).rejects.not.toThrow(secret);
  });

  it("removes the throwaway entry even when the probe cannot read it back", async () => {
    const memory = memorySecretStore();
    const os = {
      ...memory,
      platform: "linux" as const,
      get: async () => {
        throw new KeystoreError("probe read failed");
      },
      remove: vi.fn(memory.remove),
    };
    const env = { VAPI_VAULT_PASSWORD: "correct horse battery" };

    expect(await chooseSecretBackend({ home: await home(), os, env })).toBe("file");
    expect(os.remove).toHaveBeenCalledExactlyOnceWith("setup-probe");
    expect(await os.has("setup-probe")).toBe(false);
  });
});

describe("reading a secret backend pin", () => {
  it.each([
    "not json",
    '{"v":1,"backend":"weird"}',
    '{"v":2,"backend":"file"}',
    '{"backend":"file"}',
    "null",
    "[]",
    '{"v":1,"backend":"os","secret":"pin-secret-sentinel"}',
  ])("refuses a damaged pin containing %s", async (contents) => {
    const dir = await home();
    const path = secretBackendPath(dir);
    await writeFile(path, contents, { mode: 0o600 });

    const read = () => readSecretBackend(dir);
    expect(read).toThrow(KeystoreError);
    expect(read).toThrow("damaged");
    expect(read).toThrow(path);
    expect(read).not.toThrow(contents);
    expect(read).not.toThrow("pin-secret-sentinel");
  });

  it("refuses a pin that exists but cannot be read as a file", async () => {
    const dir = await home();
    const path = secretBackendPath(dir);
    await mkdir(path, { mode: 0o700 });

    expect(() => readSecretBackend(dir)).toThrow(KeystoreError);
    expect(() => readSecretBackend(dir)).toThrow("damaged");
    expect(() => readSecretBackend(dir)).toThrow(path);
  });

  it("uses the configured vAPI home when no home is supplied", async () => {
    const dir = await home();
    vi.stubEnv("VAPI_HOME", dir);
    expect(secretBackendPath()).toBe(join(dir, "secret-store.json"));
    expect(secretsFilePath()).toBe(join(dir, "secrets.json"));
    expect(readSecretBackend()).toBe("os");
    await writeFile(secretBackendPath(), JSON.stringify({ v: 1, backend: "file" }), {
      mode: 0o600,
    });
    expect(readSecretBackend()).toBe("file");
  });
});
