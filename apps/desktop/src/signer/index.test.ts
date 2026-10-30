import { afterEach, expect, it, vi } from "vitest";

import type { SignerDeps } from "./signer.js";

const mocks = vi.hoisted(() => ({
  createSigner: vi.fn(),
  baseBalanceReader: vi.fn(),
}));

vi.mock("./signer.js", () => ({ createSigner: mocks.createSigner }));
vi.mock("./desktop-secret-store.js", () => ({ desktopSecretStore: vi.fn() }));
vi.mock("./keychain.js", () => ({ keychainPasswordStore: vi.fn() }));
vi.mock("../main/overview.js", () => ({ baseBalanceReader: mocks.baseBalanceReader }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("retries failed balance reader initialization and reuses a successful reader", async () => {
  vi.stubEnv("VAPI_HOME", "/test/home");
  vi.stubEnv("VAPI_DESKTOP_SIGNER_LEDGER", "/test/home/ledger.json");
  vi.stubEnv("VAPI_DESKTOP_API_BASE", "https://api.vapinetwork.ai");
  vi.stubGlobal("process", { ...process, parentPort: { on: vi.fn() } });
  const readBalance = vi.fn(async () => 0n);
  mocks.baseBalanceReader
    .mockRejectedValueOnce(new Error("Base is not configured."))
    .mockResolvedValue(readBalance);

  await import("./index.js");
  const deps = mocks.createSigner.mock.calls[0]?.[0] as SignerDeps;
  const address = "0x0000000000000000000000000000000000000001";
  await expect(deps.readBalance!(address)).rejects.toThrow("Base is not configured.");
  await expect(deps.readBalance!(address)).resolves.toBe(0n);
  await expect(deps.readBalance!(address)).resolves.toBe(0n);
  expect(mocks.baseBalanceReader).toHaveBeenCalledTimes(2);
  expect(mocks.baseBalanceReader).toHaveBeenLastCalledWith("/test/home");
  expect(readBalance).toHaveBeenCalledTimes(2);
  expect(readBalance).toHaveBeenLastCalledWith(address);
});
