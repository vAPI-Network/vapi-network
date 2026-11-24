import { getAddress, type Address } from "viem";
import { TaskOperationError } from "./operation-support.js";
import { describe, expect, it, vi } from "vitest";
import { getTrustedTasksV2Deployment, TRUSTED_TASKS_V2_DEPLOYMENTS } from "./v2-trust.js";

const env = {
  VAPI_TASKS_V2_ESCROW_FACTORY_84532: `0x${"11".repeat(20)}`,
  VAPI_TASKS_V2_DISPUTE_RESOLVER_V3_84532: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  VAPI_TASKS_V2_POOL_FACTORY_84532: `0x${"22".repeat(20)}`,
  VAPI_TASKS_V2_USDC_84532: `0x${"33".repeat(20)}`,
  VAPI_TASKS_V2_USDC_NAME_84532: "USD Coin",
  VAPI_TASKS_V2_USDC_VERSION_84532: "2",
};
describe("local V2 trust anchors", () => {
  it("resolves the verified Base mainnet deployment without overrides or notices", () => {
    const notice = vi.fn();
    expect(getTrustedTasksV2Deployment(8453, { env: {}, notice })).toEqual({
      escrowFactoryV2: getAddress("0x3586A4C92b55a83175D911aBA9B50329319E34BD"),
      disputeResolverV3: getAddress("0xEe36F3B19dcC38B6b5676B6cdcDd63a6d7Fbb435"),
      bountyPoolFactoryV1: getAddress("0xD03264c27AE3900834d6C5ba85cd15C56B21452f"),
      usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
      usdcName: "USD Coin",
      usdcVersion: "2",
      offerTtlSeconds: 604800,
      reviewWindowSeconds: 604800,
      evidenceWindowSeconds: 172800,
      choiceWindowSeconds: 604800,
    });
    expect(notice).not.toHaveBeenCalled();
    expect(Object.keys(TRUSTED_TASKS_V2_DEPLOYMENTS)).toEqual(["8453"]);
  });
  it("requires an explicit override for Base Sepolia and unknown chains", () => {
    for (const chainId of [84532, 1]) {
      expect(() => getTrustedTasksV2Deployment(chainId, { env: {} })).toThrow(
        "No locally pinned V2 deployment",
      );
    }
  });
  it("accepts only a complete chain-specific staging override and logs it", () => {
    const notice = vi.fn();
    expect(getTrustedTasksV2Deployment(84532, { env, notice })).toMatchObject({
      disputeResolverV3: getAddress(env.VAPI_TASKS_V2_DISPUTE_RESOLVER_V3_84532),
      usdc: env.VAPI_TASKS_V2_USDC_84532,
      usdcName: "USD Coin",
      usdcVersion: "2",
    });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("untrusted override"));
    expect(getTrustedTasksV2Deployment(8453, { env, notice })).toEqual(
      TRUSTED_TASKS_V2_DEPLOYMENTS[8453],
    );
    expect(notice).toHaveBeenCalledTimes(1);
  });
  it.each(Object.keys(env))("refuses an override missing %s", (key) => {
    const incomplete: NodeJS.ProcessEnv = { ...env };
    delete incomplete[key];
    expect(() => getTrustedTasksV2Deployment(84532, { env: incomplete, notice: vi.fn() })).toThrow(
      "requires both factories",
    );
  });
  it("refuses zero or malformed override addresses", () => {
    for (const value of [`0x${"00".repeat(20)}`, "https://attacker.example"]) {
      expect(() =>
        getTrustedTasksV2Deployment(84532, {
          env: { ...env, VAPI_TASKS_V2_USDC_84532: value },
          notice: vi.fn(),
        }),
      ).toThrow();
    }
  });
  it("accepts explicit local prediction windows without consulting readiness", () => {
    expect(
      getTrustedTasksV2Deployment(84532, {
        env: {
          ...env,
          VAPI_TASKS_V2_EVIDENCE_WINDOW_SECONDS_84532: "3600",
          VAPI_TASKS_V2_OFFER_TTL_SECONDS_84532: "86400",
          VAPI_TASKS_V2_REVIEW_WINDOW_SECONDS_84532: "172800",
          VAPI_TASKS_V2_CHOICE_WINDOW_SECONDS_84532: "172800",
        },
        notice: vi.fn(),
      }),
    ).toMatchObject({
      offerTtlSeconds: 86400,
      reviewWindowSeconds: 172800,
      choiceWindowSeconds: 172800,
      evidenceWindowSeconds: 3600,
    });
  });
  it.each(["0", "-1", "1.5", "invalid", "9007199254740992"])(
    "refuses invalid local prediction window %s",
    (value) => {
      expect(() =>
        getTrustedTasksV2Deployment(84532, {
          env: { ...env, VAPI_TASKS_V2_CHOICE_WINDOW_SECONDS_84532: value },
          notice: vi.fn(),
        }),
      ).toThrow();
    },
  );
  it("requires a resolver even when the other environment values are complete", () => {
    const incomplete: NodeJS.ProcessEnv = { ...env };
    delete incomplete.VAPI_TASKS_V2_DISPUTE_RESOLVER_V3_84532;
    expect(() => getTrustedTasksV2Deployment(84532, { env: incomplete })).toThrow(
      expect.objectContaining({ code: "v2_trust_unavailable" }),
    );
  });
  it.each([`0x${"00".repeat(20)}`, "invalid", undefined])(
    "wraps invalid object resolver %s as a trust error",
    (resolver) => {
      const invoke = () =>
        getTrustedTasksV2Deployment(84532, {
          env: {},
          overrides: {
            84532: {
              escrowFactoryV2: env.VAPI_TASKS_V2_ESCROW_FACTORY_84532 as Address,
              bountyPoolFactoryV1: env.VAPI_TASKS_V2_POOL_FACTORY_84532 as Address,
              usdc: env.VAPI_TASKS_V2_USDC_84532 as Address,
              usdcName: "USD Coin",
              usdcVersion: "2",
              disputeResolverV3: resolver as Address,
            },
          },
          notice: vi.fn(),
        });
      expect(invoke).toThrow(TaskOperationError);
      expect(invoke).toThrow(expect.objectContaining({ code: "v2_trust_unavailable" }));
    },
  );
  it.each(["0", "1.5", "invalid", "9007199254740992"])("rejects evidence window %s", (value) => {
    expect(() =>
      getTrustedTasksV2Deployment(84532, {
        env: { ...env, VAPI_TASKS_V2_EVIDENCE_WINDOW_SECONDS_84532: value },
        notice: vi.fn(),
      }),
    ).toThrow(expect.objectContaining({ code: "v2_trust_unavailable" }));
  });
  it.each(["0", "-1", "1.5", "invalid", "9007199254740992"])(
    "refuses invalid review window %s",
    (value) => {
      expect(() =>
        getTrustedTasksV2Deployment(84532, {
          env: { ...env, VAPI_TASKS_V2_REVIEW_WINDOW_SECONDS_84532: value },
          notice: vi.fn(),
        }),
      ).toThrow(expect.objectContaining({ code: "v2_trust_unavailable" }));
    },
  );
  it("treats an evidence window alone as an incomplete override", () => {
    expect(() =>
      getTrustedTasksV2Deployment(84532, {
        env: { VAPI_TASKS_V2_EVIDENCE_WINDOW_SECONDS_84532: "3600" },
      }),
    ).toThrow("requires both factories");
  });
});
