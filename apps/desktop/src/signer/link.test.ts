// apps/desktop/src/signer/link.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  memorySecretStore,
  WalletStore,
  type AccountLinkOutcome,
  type startAccountLink,
} from "@vapi-network/core";

import { createLinkService } from "./link.js";
import type { WalletLinkState } from "./messages.js";

type StartArgs = Parameters<typeof startAccountLink>[0];
const API_BASE = "https://api.vapinetwork.ai";
const OWNER = "0x8617E340B3D01FA5F11F306F4090FD50E238070D" as const;
const BROWSER_LINK = {
  userCode: "ABCD-EFGH",
  verificationUri: `${API_BASE}/link`,
  verificationUriComplete: `${API_BASE}/link?code=ABCD-EFGH`,
  expiresInSeconds: 1200,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createLinkService", () => {
  let home: string;
  let store: WalletStore;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "link-service-"));
    store = await WalletStore.open(home, { secrets: memorySecretStore() });
    await store.create("claude", "");
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function service(core: Parameters<typeof createLinkService>[0]["core"], now = () => 1_000) {
    return createLinkService({
      secrets: memorySecretStore(),
      apiBase: API_BASE,
      hostname: "Ada-MacBook-Pro.local",
      core,
      now,
    });
  }

  it("links silently on a trusted Mac and asks core as vAPI Desktop on this Mac", async () => {
    const calls: StartArgs[] = [];
    const links = service({
      startAccountLink: async (args) => {
        calls.push(args);
        return { linked: true, autoApproved: true };
      },
    });
    expect(await links.start(store, "claude")).toEqual({ mode: "silent" });
    expect(calls[0]).toMatchObject({
      account: "claude",
      label: "claude",
      apiBase: API_BASE,
      env: { VAPI_DEVICE: "vapi-desktop-ada-macbook-pro" },
    });
  });

  it("hands out the code for a browser approval and reports the outcome once", async () => {
    let finish: (outcome: AccountLinkOutcome) => void = () => undefined;
    const completion = new Promise<AccountLinkOutcome>((resolve) => {
      finish = resolve;
    });
    const links = service({
      startAccountLink: async () => ({
        linked: false,
        autoApproved: false,
        link: BROWSER_LINK,
        completion,
      }),
    });
    expect(await links.start(store, "claude")).toEqual({
      mode: "browser",
      userCode: "ABCD-EFGH",
      url: `${API_BASE}/link?code=ABCD-EFGH`,
      expiresAt: 1_201_000,
    });
    expect(links.poll("claude")).toMatchObject({ state: "pending", userCode: "ABCD-EFGH" });
    finish({ linked: true, owner: OWNER });
    await completion;
    expect(links.poll("claude")).toEqual({ state: "linked", owner: OWNER });
    expect(links.poll("claude")).toEqual({ state: "none" });
  });

  it("reports a declined link with its reason", async () => {
    const links = service({
      startAccountLink: async () => ({
        linked: false,
        autoApproved: false,
        link: BROWSER_LINK,
        completion: Promise.resolve<AccountLinkOutcome>({
          linked: false,
          reason: "denied",
          message: "The owner denied the agent link.",
        }),
      }),
    });
    await links.start(store, "claude");
    await Promise.resolve();
    expect(links.poll("claude")).toEqual({
      state: "denied",
      message: "The owner denied the agent link.",
    });
  });

  it("reports an error when core could not start the link", async () => {
    const links = service({
      startAccountLink: async () => ({
        linked: false,
        autoApproved: false,
        linkError: "The vAPI agent link could not be started.",
      }),
    });
    expect(await links.start(store, "claude")).toEqual({
      mode: "error",
      message: "The vAPI agent link could not be started.",
    });
  });

  it("abandons the previous code when a new one is asked for", async () => {
    const calls: StartArgs[] = [];
    const links = service({
      startAccountLink: async (args) => {
        calls.push(args);
        return {
          linked: false,
          autoApproved: false,
          link: BROWSER_LINK,
          completion: new Promise<AccountLinkOutcome>(() => undefined),
        };
      },
    });
    await links.start(store, "claude");
    await links.start(store, "claude");
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls[1]?.signal?.aborted).toBe(false);
  });

  it("cancels a link while core is still starting it", async () => {
    const started = deferred<Awaited<ReturnType<typeof startAccountLink>>>();
    const calls: StartArgs[] = [];
    const links = service({
      startAccountLink: (args) => {
        calls.push(args);
        return started.promise;
      },
    });
    const result = links.start(store, "claude");
    links.cancelAll();
    started.resolve({
      linked: false,
      autoApproved: false,
      link: BROWSER_LINK,
      completion: new Promise<AccountLinkOutcome>(() => undefined),
    });

    expect(await result).toEqual({ mode: "error", message: "The link was cancelled." });
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(links.poll("claude")).toEqual({ state: "none" });
  });

  it("cancels a registered pending link", async () => {
    const calls: StartArgs[] = [];
    const links = service({
      startAccountLink: async (args) => {
        calls.push(args);
        return {
          linked: false,
          autoApproved: false,
          link: BROWSER_LINK,
          completion: new Promise<AccountLinkOutcome>(() => undefined),
        };
      },
    });
    await links.start(store, "claude");
    expect(links.poll("claude").state).toBe("pending");

    links.cancelAll();

    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(links.poll("claude")).toEqual({ state: "none" });
  });

  it.each(["earlier", "latest"] as const)(
    "keeps only the latest concurrent start when the %s start resolves first",
    async (resolvesFirst) => {
      const earlier = deferred<Awaited<ReturnType<typeof startAccountLink>>>();
      const latest = deferred<Awaited<ReturnType<typeof startAccountLink>>>();
      const calls: StartArgs[] = [];
      const links = service({
        startAccountLink: (args) => {
          calls.push(args);
          return calls.length === 1 ? earlier.promise : latest.promise;
        },
      });
      const earlierResult = links.start(store, "claude");
      const latestResult = links.start(store, "claude");
      const earlierLink = {
        linked: false,
        autoApproved: false,
        link: BROWSER_LINK,
        completion: new Promise<AccountLinkOutcome>(() => undefined),
      };
      const latestLink = {
        ...earlierLink,
        link: {
          ...BROWSER_LINK,
          userCode: "WXYZ-1234",
          verificationUriComplete: `${API_BASE}/link?code=WXYZ-1234`,
        },
      };
      if (resolvesFirst === "earlier") {
        earlier.resolve(earlierLink);
        await earlierResult;
        latest.resolve(latestLink);
        await latestResult;
      } else {
        latest.resolve(latestLink);
        await latestResult;
        earlier.resolve(earlierLink);
        await earlierResult;
      }

      expect(calls[0]?.signal?.aborted).toBe(true);
      expect(calls[1]?.signal?.aborted).toBe(false);
      expect(await earlierResult).toEqual({ mode: "error", message: "The link was cancelled." });
      expect(await latestResult).toEqual({
        mode: "browser",
        userCode: "WXYZ-1234",
        url: `${API_BASE}/link?code=WXYZ-1234`,
        expiresAt: 1_201_000,
      });
      expect(links.poll("claude")).toEqual({
        state: "pending",
        userCode: "WXYZ-1234",
        url: `${API_BASE}/link?code=WXYZ-1234`,
        expiresAt: 1_201_000,
      });
      links.cancelAll();
      expect(calls[1]?.signal?.aborted).toBe(true);
      expect(links.poll("claude")).toEqual({ state: "none" });
    },
  );

  it("reuses the server's link states for a minute", async () => {
    let time = 0;
    let asked = 0;
    const links = service(
      {
        linkStates: async () => {
          asked += 1;
          return new Map([["claude", "linked" as const]]);
        },
      },
      () => time,
    );
    await links.states(store);
    await links.states(store);
    expect(asked).toBe(1);
    time = 60_001;
    expect((await links.states(store)).get("claude")).toBe("linked");
    expect(asked).toBe(2);
    links.invalidate();
    await links.states(store);
    expect(asked).toBe(3);
  });

  it("shares one in-flight link-state request between overlapping callers", async () => {
    const answer = deferred<Map<string, WalletLinkState>>();
    let asked = 0;
    const links = service({
      linkStates: () => {
        asked += 1;
        return answer.promise;
      },
    });
    const first = links.states(store);
    const second = links.states(store);
    const expected = new Map<string, WalletLinkState>([["claude", "linked"]]);
    answer.resolve(expected);

    expect(await Promise.all([first, second])).toEqual([expected, expected]);
    expect(asked).toBe(1);
    expect(first).toBe(second);
  });

  it.each(["invalidate", "silent link", "browser completion"] as const)(
    "does not cache an in-flight state answer after %s",
    async (trigger) => {
      const stale = deferred<Map<string, WalletLinkState>>();
      const completion = deferred<AccountLinkOutcome>();
      const fresh = new Map<string, WalletLinkState>([["claude", "linked"]]);
      let asked = 0;
      const links = service({
        linkStates: async () => {
          asked += 1;
          return asked === 1 ? stale.promise : fresh;
        },
        startAccountLink: async () =>
          trigger === "silent link"
            ? { linked: true, autoApproved: true }
            : {
                linked: false,
                autoApproved: false,
                link: BROWSER_LINK,
                completion: completion.promise,
              },
      });
      const beforeInvalidation = links.states(store);
      if (trigger === "invalidate") {
        links.invalidate();
      } else {
        await links.start(store, "claude");
        if (trigger === "browser completion") {
          completion.resolve({ linked: true, owner: OWNER });
          await completion.promise;
        }
      }
      const oldStates = new Map<string, WalletLinkState>([["claude", "not_linked"]]);
      stale.resolve(oldStates);
      expect(await beforeInvalidation).toEqual(oldStates);

      expect(await links.states(store)).toEqual(fresh);
      expect(asked).toBe(2);
      expect(await links.states(store)).toEqual(fresh);
      expect(asked).toBe(2);
    },
  );

  it.each(["cached", "in-flight"] as const)(
    "invalidates %s link states when all links are cancelled",
    async (cacheState) => {
      const stale = deferred<Map<string, WalletLinkState>>();
      const fresh = new Map<string, WalletLinkState>([["claude", "not_linked"]]);
      let asked = 0;
      const links = service({
        linkStates: async () => {
          asked += 1;
          return asked === 1 ? stale.promise : fresh;
        },
      });
      const first = links.states(store);
      if (cacheState === "cached") {
        stale.resolve(new Map([["claude", "linked"]]));
        await first;
      }

      links.cancelAll();
      if (cacheState === "in-flight") {
        stale.resolve(new Map([["claude", "linked"]]));
        await first;
      }

      expect(await links.states(store)).toEqual(fresh);
      expect(asked).toBe(2);
    },
  );

  it("reads the owner from the stored link for this server only, without the network", async () => {
    const links = service({});
    expect(links.owner(store)).toBeUndefined();
    await store.setLink("claude", {
      apiBase: "https://staging-api.vapinetwork.ai",
      clientId: "agent_claude",
      owner: OWNER,
      label: "claude",
      scopes: ["mcp:call"],
      linkedAt: "2026-10-26T10:00:00.000Z",
    });
    expect(links.owner(store)).toBeUndefined();
    await store.setLink("claude", {
      apiBase: API_BASE,
      clientId: "agent_claude",
      owner: OWNER,
      label: "claude",
      scopes: ["mcp:call"],
      linkedAt: "2026-10-26T10:00:00.000Z",
    });
    expect(links.owner(store)).toBe(OWNER);
  });
});
