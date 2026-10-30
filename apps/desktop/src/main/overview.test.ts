import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readOverview } from "./overview.js";
import type { AppStatus } from "../shared/apps.js";
import type { WalletSummary } from "../signer/messages.js";

const wallet: WalletSummary = {
  name: "claude",
  address: "0x9467C22197110Cb2cBEE9b62C5d8424B130035f5",
  publicKey: "0x",
  caps: { perCallAtomic: "1000000", perDayAtomic: "5000000" },
  spentTodayAtomic: "0",
};

function receipt(id: string, outcome: string, amountAtomic: string) {
  return JSON.stringify({
    id,
    timestamp: "2026-10-26T14:02:00.000Z",
    wallet: "claude",
    resourceUrl: "https://weather.cyberwarex.com/forecast?q=Amsterdam",
    quote: { network: "eip155:8453", amountAtomic },
    outcome,
  });
}

describe("readOverview", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "overview-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("joins balances, newest-first activity and app statuses", async () => {
    await writeFile(
      join(home, "receipts.jsonl"),
      `${receipt("r1", "paid", "2000")}\n${receipt("r2", "declined_policy", "2000")}\n`,
    );
    const apps: AppStatus[] = [
      { id: "claude-desktop", state: "connected", wallet: "research" },
      { id: "codex", state: "conflict", path: "/config/codex.toml" },
    ];
    const recovery = { kit: false, backup: { enabled: false, failed: false } };

    const overview = await readOverview({
      home,
      wallets: [wallet],
      readBalance: async () => 2_000_000n,
      apps: async () => apps,
      owner: null,
      recovery,
    });

    expect(overview.wallets[0]?.balanceAtomic).toBe("2000000");
    expect(overview.activity.map((item) => [item.id, item.outcome, item.host])).toEqual([
      ["r2", "blocked", "weather.cyberwarex.com"],
      ["r1", "paid", "weather.cyberwarex.com"],
    ]);
    expect(overview.apps).toEqual(apps);
    expect(overview.recovery).toBe(recovery);
  });

  it("reports an unreadable balance as unknown, not zero, and survives missing files", async () => {
    const overview = await readOverview({
      home,
      wallets: [wallet],
      readBalance: async () => {
        throw new Error("rpc down");
      },
      apps: async () => [],
      owner: null,
      recovery: null,
    });
    expect(overview.wallets[0]?.balanceAtomic).toBeNull();
    expect(overview.activity).toEqual([]);
    expect(overview.apps).toEqual([]);
    expect(overview.recovery).toBeNull();
  });

  it.each(["throw", "reject"])("survives app detection %s", async (failure) => {
    const overview = await readOverview({
      home,
      wallets: [wallet],
      readBalance: async () => 0n,
      apps: () => {
        if (failure === "throw") throw new Error("detection failed");
        return Promise.reject(new Error("detection failed"));
      },
      owner: null,
      recovery: null,
    });
    expect(overview.apps).toEqual([]);
    expect(overview.wallets[0]?.name).toBe(wallet.name);
  });

  it("passes the owner and each wallet's link state through", async () => {
    const owner = "0x8617E340B3D01FA5F11F306F4090FD50E238070D" as const;
    const overview = await readOverview({
      home,
      wallets: [{ ...wallet, link: "linked" }],
      readBalance: async () => 0n,
      apps: async () => [],
      owner,
      recovery: null,
    });
    expect(overview.owner).toBe(owner);
    expect(overview.wallets[0]?.link).toBe("linked");
  });
});
