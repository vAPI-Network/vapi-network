import { describe, expect, it } from "vitest";

import { secretStore, type SecretStoreOutcome, type SecretStoreRunner } from "./secret-store.js";

type Run = { file: string; args: string[]; input?: string };

/** A runner that answers from a script and records every command line. */
function recordingRunner(answers: Array<Partial<SecretStoreOutcome>>): {
  run: SecretStoreRunner;
  runs: Run[];
} {
  const runs: Run[] = [];
  const queue = [...answers];
  const run: SecretStoreRunner = async (file, args, input) => {
    runs.push({ file, args: [...args], ...(input === undefined ? {} : { input }) });
    const answer = queue.shift() ?? {};
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
  return { run, runs };
}

describe("the macOS keychain store", () => {
  it("stores the passphrase over stdin, never in an argument", async () => {
    const { run, runs } = recordingRunner([{ code: 0 }]);
    const store = secretStore({ platform: "darwin", run });

    await store.set("agent-claude", "test-only-passphrase");

    expect(store.available).toBe(true);
    expect(runs).toEqual([
      {
        file: "/usr/bin/security",
        args: [
          "add-generic-password",
          "-a",
          "agent-claude",
          "-s",
          "vapi-network",
          "-l",
          "vapi-network agent-claude",
          "-U",
          "-w",
        ],
        input: "test-only-passphrase\ntest-only-passphrase\n",
      },
    ]);
    expect(runs[0]!.args).not.toContain("test-only-passphrase");
  });

  it("reads the passphrase back without its trailing newline", async () => {
    const { run, runs } = recordingRunner([{ code: 0, stdout: "test-only-passphrase\n" }]);

    const value = await secretStore({ platform: "darwin", run }).get("main");

    expect(value).toBe("test-only-passphrase");
    expect(runs[0]).toEqual({
      file: "/usr/bin/security",
      args: ["find-generic-password", "-a", "main", "-s", "vapi-network", "-w"],
      input: undefined,
    });
  });

  it("reports a missing item as no passphrase rather than an error", async () => {
    const { run } = recordingRunner([
      { code: 44, stderr: "security: SecKeychainSearchCopyNext: The specified item could not" },
    ]);

    await expect(secretStore({ platform: "darwin", run }).get("main")).resolves.toBeUndefined();
  });

  it("asks whether an entry exists without reading the secret", async () => {
    const { run, runs } = recordingRunner([{ code: 0, stdout: "attributes:\n" }, { code: 44 }]);
    const store = secretStore({ platform: "darwin", run });

    expect(await store.has("main")).toBe(true);
    expect(await store.has("agent")).toBe(false);
    expect(runs[0]!.args).not.toContain("-w");
    expect(runs[0]!.args).toEqual(["find-generic-password", "-a", "main", "-s", "vapi-network"]);
  });

  it("removes an entry and says when there was none", async () => {
    const { run, runs } = recordingRunner([
      { code: 0, stdout: "test-only-passphrase\n" },
      { code: 0 },
      { code: 44 },
    ]);
    const store = secretStore({ platform: "darwin", run });

    expect(await store.remove("main")).toBe(true);
    expect(await store.remove("main")).toBe(false);
    expect(runs[1]!.args).toEqual(["delete-generic-password", "-a", "main", "-s", "vapi-network"]);
  });

  it("splits a value longer than the prompt limit over several items and joins it back", async () => {
    // `security -w` reads at most 128 characters from its prompt and silently
    // drops the rest, so a long value is stored in parts.
    const value = `{"accessToken":"${"a".repeat(60)}","refreshToken":"${"r".repeat(60)}","expiresAt":1,"scopes":["mcp:call","router.use"]}`;
    const items = new Map<string, string>();
    const run: SecretStoreRunner = async (_file, args, input) => {
      const account = args[args.indexOf("-a") + 1]!;
      if (args[0] === "add-generic-password") {
        const typed = input!.split("\n")[0]!;
        items.set(account, typed.slice(0, 128));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "find-generic-password") {
        const stored = items.get(account);
        return stored === undefined
          ? { code: 44, stdout: "", stderr: "" }
          : { code: 0, stdout: `${stored}\n`, stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        return items.delete(account)
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 44, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const store = secretStore({ platform: "darwin", run });

    await store.set("vapi.agent.main.tokens", value);
    expect([...items.values()].every((item) => item.length <= 128)).toBe(true);
    expect(await store.get("vapi.agent.main.tokens")).toBe(value);

    await store.set("vapi.agent.main.tokens", `${value}${"x".repeat(200)}`);
    expect(await store.get("vapi.agent.main.tokens")).toBe(`${value}${"x".repeat(200)}`);
    await store.set("vapi.agent.main.tokens", value);
    expect(await store.get("vapi.agent.main.tokens")).toBe(value);
    expect([...items.keys()].filter((key) => key.includes("#"))).toHaveLength(2);

    expect(await store.remove("vapi.agent.main.tokens")).toBe(true);
    expect(items.size).toBe(0);
  });

  it("turns any other failure into one sentence without the passphrase", async () => {
    const { run } = recordingRunner([{ code: 51, stderr: "User interaction is not allowed." }]);

    await expect(
      secretStore({ platform: "darwin", run }).set("main", "test-only-passphrase"),
    ).rejects.toThrow(
      "Could not store the passphrase of main in the macOS Keychain (exit 51). User interaction is not allowed.",
    );
  });
});

describe("the libsecret store", () => {
  it("stores the passphrase over stdin under the vapi-network service", async () => {
    const { run, runs } = recordingRunner([{ code: 0 }]);

    await secretStore({ platform: "linux", run }).set("agent-claude", "test-only-passphrase");

    expect(runs).toEqual([
      {
        file: "secret-tool",
        args: [
          "store",
          "--label=vapi-network agent-claude",
          "service",
          "vapi-network",
          "account",
          "agent-claude",
        ],
        input: "test-only-passphrase\n",
      },
    ]);
  });

  it("looks a passphrase up and treats a silent non-zero exit as absent", async () => {
    const { run, runs } = recordingRunner([
      { code: 0, stdout: "test-only-passphrase\n" },
      { code: 1 },
    ]);
    const store = secretStore({ platform: "linux", run });

    expect(await store.get("main")).toBe("test-only-passphrase");
    expect(await store.get("agent")).toBeUndefined();
    expect(runs[0]).toEqual({
      file: "secret-tool",
      args: ["lookup", "service", "vapi-network", "account", "main"],
      input: undefined,
    });
  });

  it("clears an entry and reports whether one was there", async () => {
    const { run, runs } = recordingRunner([
      { code: 0, stdout: "test-only-passphrase\n" },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const store = secretStore({ platform: "linux", run });

    expect(await store.remove("main")).toBe(true);
    expect(await store.remove("main")).toBe(false);
    expect(runs[1]).toEqual({
      file: "secret-tool",
      args: ["clear", "service", "vapi-network", "account", "main"],
      input: undefined,
    });
  });

  it("names the package to install when secret-tool is missing", async () => {
    const { run } = recordingRunner([{ code: null, notFound: true }]);

    await expect(secretStore({ platform: "linux", run }).get("main")).rejects.toThrow(
      /libsecret-tools/u,
    );
  });

  it("reports a failure that came with a message", async () => {
    const { run } = recordingRunner([{ code: 1, stderr: "Cannot autolaunch D-Bus" }]);

    await expect(
      secretStore({ platform: "linux", run }).set("main", "test-only-passphrase"),
    ).rejects.toThrow(
      "Could not store the passphrase of main in the secret service (exit 1). Cannot autolaunch D-Bus",
    );
  });
});

describe("every other platform", () => {
  it("says there is no store and points at the environment variable", async () => {
    const { run, runs } = recordingRunner([]);
    const store = secretStore({ platform: "win32", run });

    expect(store.available).toBe(false);
    expect(store.platform).toBe("win32");
    const message = "No OS secret store on this platform yet; use VAPI_KEYSTORE_PASSWORD.";
    await expect(store.get("main")).rejects.toThrow(message);
    await expect(store.has("main")).rejects.toThrow(message);
    await expect(store.set("main", "test-only-passphrase")).rejects.toThrow(message);
    await expect(store.remove("main")).rejects.toThrow(message);
    expect(runs).toEqual([]);
  });
});

describe("the wallet name it files an entry under", () => {
  it("refuses an empty name rather than reaching for a nameless entry", async () => {
    const { run } = recordingRunner([]);

    await expect(secretStore({ platform: "darwin", run }).get("  ")).rejects.toThrow(
      "A wallet name is needed to reach the OS secret store.",
    );
  });
});
