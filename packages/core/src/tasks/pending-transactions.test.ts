import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createPendingTransactions } from "./pending-transactions.js";
import { tasksResponseSchemas } from "./types.js";

const directories: string[] = [];
const OPERATION = "11111111-1111-4111-8111-111111111111";
const KEY = "22222222-2222-4222-8222-222222222222";
const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const HASH = `0x${"ab".repeat(32)}` as const;

async function store() {
  const home = await mkdtemp(join(tmpdir(), "vapi-pending-"));
  directories.push(home);
  return { home, pending: createPendingTransactions(home) };
}

afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

it("persists transactions privately and refuses replacement calldata", async () => {
  const { home, pending } = await store();
  const entry = {
    chainId: 84532,
    txHash: HASH,
    raw: "0x1234" as const,
    signer: ADDRESS,
    nonce: 4,
    createdAt: "2026-10-09T12:00:00.000Z",
  };
  await pending.put(OPERATION, "approve-usdc", entry);
  expect(await pending.get(OPERATION, "approve-usdc")).toEqual(entry);
  await expect(pending.put(OPERATION, "approve-usdc", { ...entry, raw: "0x5678" })).rejects.toThrow(
    "immutable",
  );
  expect((await stat(join(home, "tasks", "pending.json"))).mode & 0o777).toBe(0o600);
});

it("retains reservation IDs after transaction removal", async () => {
  const { home, pending } = await store();
  expect(await pending.reservationId(OPERATION, () => KEY)).toBe(KEY);
  expect(
    await pending.reservationId(OPERATION, () => {
      throw new Error("must not generate");
    }),
  ).toBe(KEY);
  await pending.remove(OPERATION, "approve-usdc");
  expect(
    JSON.parse(await readFile(join(home, "tasks", "pending.json"), "utf8")).reservations[OPERATION],
  ).toBe(KEY);
});

it("generates one authorization while holding the store lock", async () => {
  const { pending } = await store();
  let calls = 0;
  const generate = async () => {
    calls += 1;
    return { validAfter: "0", validBefore: "10", nonce: HASH, signature: "0x1234" as const };
  };
  const [first, second] = await Promise.all([
    pending.fundingAuthorization(OPERATION, KEY, generate),
    pending.fundingAuthorization(OPERATION, KEY, generate),
  ]);
  expect(first).toEqual(second);
  expect(calls).toBe(1);
  expect(await pending.savedFundingAuthorization(OPERATION, KEY)).toEqual(first);
  expect(await pending.exposure(OPERATION)).toBe(true);
});

it("stores immutable preparations and completes them", async () => {
  const { pending } = await store();
  const preparation = { idempotencyKey: KEY, inputs: { amount: "10" } };
  await pending.putPreparation(OPERATION, "fund", preparation);
  await pending.putPreparation(OPERATION, "fund", preparation);
  expect(await pending.preparation(OPERATION, "fund")).toEqual(preparation);
  expect(await pending.exposure(OPERATION)).toBe(false);
  await expect(
    pending.putPreparation(OPERATION, "fund", {
      idempotencyKey: KEY,
      inputs: { amount: "11" },
    }),
  ).rejects.toThrow("immutable");
  await pending.completePreparation(OPERATION, "fund");
  expect(await pending.preparation(OPERATION, "fund")).toBeUndefined();
});

it("binds a preparation to its first server operation", async () => {
  const { pending } = await store();
  const otherOperation = "33333333-3333-4333-8333-333333333333";
  await pending.putPreparation(OPERATION, "release", { idempotencyKey: KEY, inputs: {} });
  await pending.bindPreparationOperation(OPERATION, "release", OPERATION);
  await pending.bindPreparationOperation(OPERATION, "release", OPERATION);
  await pending.putPreparation(OPERATION, "release", { idempotencyKey: KEY, inputs: {} });
  expect(await pending.preparation(OPERATION, "release")).toMatchObject({
    operationId: OPERATION,
  });
  await expect(
    pending.bindPreparationOperation(OPERATION, "release", otherOperation),
  ).rejects.toMatchObject({ broadcast: true });
  expect(await pending.preparation(OPERATION, "release")).toMatchObject({
    operationId: OPERATION,
  });
});

it("tracks exposure and invalidates retained reservation proof", async () => {
  const { pending } = await store();
  await pending.bindReservation?.(OPERATION, {
    id: KEY,
    wallet: "main",
    amountAtomic: "10",
    date: "2026-10-08",
  });
  expect(await pending.exposure(OPERATION)).toBe(false);
  await pending.markExposure(OPERATION);
  expect(await pending.exposure(OPERATION)).toBe(true);
  expect(await pending.retainedReservation?.(OPERATION)).toMatchObject({ exposed: true });
  await pending.invalidateReservation?.(OPERATION);
  expect(await pending.retainedReservation?.(OPERATION)).toMatchObject({ invalidated: true });
});

it("returns one plus the highest persisted signer nonce", async () => {
  const { pending } = await store();
  const entry = {
    chainId: 84532,
    txHash: HASH,
    raw: "0x1234" as const,
    signer: ADDRESS,
    nonce: 7,
    createdAt: "2026-10-09T12:00:00.000Z",
  };
  await pending.put(OPERATION, "approve-usdc", entry);
  await pending.put(KEY, "release-funds", { ...entry, nonce: 9 });
  expect(await pending.nextNonce(84532, ADDRESS)).toBe(10);
  expect(await pending.nextNonce(1, ADDRESS)).toBe(0);
});

it("refuses to reuse an ambiguous legacy signer nonce", async () => {
  const { home, pending } = await store();
  await pending.put(OPERATION, "approve-usdc", {
    chainId: 84532,
    txHash: HASH,
    raw: "0x1234",
    signer: ADDRESS,
    nonce: 7,
    createdAt: "2026-10-09T12:00:00.000Z",
  });
  const path = join(home, "tasks", "pending.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  delete state.transactions[`${OPERATION}:approve-usdc`].nonce;
  await writeFile(path, JSON.stringify(state));
  await expect(pending.nextNonce(84532, ADDRESS)).rejects.toThrow("no safe nonce");
});

it("serializes funding and signer actions across store instances", async () => {
  const { home, pending } = await store();
  const other = createPendingTransactions(home);
  let active = 0;
  let highest = 0;
  const action = async () => {
    active += 1;
    highest = Math.max(highest, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  };
  await Promise.all([
    pending.withFundingLock(OPERATION, action),
    other.withFundingLock(OPERATION, action),
  ]);
  await Promise.all([
    pending.withSignerLock(84532, ADDRESS, action),
    other.withSignerLock(84532, ADDRESS, action),
  ]);
  expect(highest).toBe(1);
});

it("atomically checkpoints reconciliation and removes the signed transaction", async () => {
  const { pending } = await store();
  const entry = {
    chainId: 84532,
    txHash: HASH,
    raw: "0x1234" as const,
    signer: ADDRESS,
    nonce: 4,
    createdAt: "2026-10-09T12:00:00.000Z",
  };
  await pending.put(OPERATION, "release-funds", entry);
  const response = tasksResponseSchemas.reconcileOperation.parse({
    operation: {
      id: OPERATION,
      kind: "escrow-release",
      state: "confirmed",
      step: "release-funds",
      expectedActor: null,
      transactionHash: HASH,
      plan: null,
    },
    milestone: { id: KEY, workOrderId: OPERATION },
  });
  await pending.complete(OPERATION, "release-funds", response);
  expect(await pending.get(OPERATION, "release-funds")).toBeUndefined();
  expect(await pending.reconciled(OPERATION, "release-funds")).toEqual(response);
});

it("advances recovery cursors monotonically across store instances", async () => {
  const { home, pending } = await store();
  expect(await pending.recoveryCursor(OPERATION, "release-funds")).toBe(0);
  await pending.advanceRecovery(OPERATION, "release-funds", 3);
  await pending.advanceRecovery(OPERATION, "release-funds", 1);
  expect(await createPendingTransactions(home).recoveryCursor(OPERATION, "release-funds")).toBe(4);
});

it("checkpoints only the approval-to-deposit prepared transition", async () => {
  const { pending } = await store();
  const deposit = tasksResponseSchemas.reconcileOperation.parse({
    operation: {
      id: OPERATION,
      kind: "escrow-funding",
      state: "prepared",
      step: "deposit-funds",
      expectedActor: ADDRESS,
      transactionHash: HASH,
      plan: {
        version: "work-transaction-plan-v2",
        operationId: OPERATION,
        step: "deposit-funds",
        chainId: 84532,
        network: "eip155:84532",
        from: ADDRESS,
        to: ADDRESS,
        data: "0xe2c41dbc",
        value: "0",
      },
    },
    milestone: { id: KEY, workOrderId: OPERATION },
  });
  await pending.complete(OPERATION, "approve-usdc", deposit);
  expect((await pending.reconciled(OPERATION, "approve-usdc"))?.operation.step).toBe(
    "deposit-funds",
  );
  await expect(pending.complete(OPERATION, "release-funds", deposit)).rejects.toThrow(
    "does not match",
  );
});

it.each([
  ["escrow-dispute", "raise-dispute"],
  ["escrow-counter-evidence", "submit-counter-evidence"],
] as const)("persists a V2 %s approval checkpoint across process instances", async (kind, step) => {
  const { home, pending } = await store();
  const response = tasksResponseSchemas.reconcileOperation.parse({
    operation: {
      id: OPERATION,
      kind,
      state: "prepared",
      step,
      expectedActor: ADDRESS,
      transactionHash: null,
      plan: {
        version: "work-transaction-plan-v2",
        operationId: OPERATION,
        step,
        chainId: 84532,
        network: "eip155:84532",
        from: ADDRESS,
        to: ADDRESS,
        data: "0x12345678",
        value: "0",
      },
    },
    milestone: { id: KEY, workOrderId: OPERATION },
  });
  await pending.put(OPERATION, "approve-usdc", {
    chainId: 84532,
    txHash: HASH,
    raw: "0x1234",
    signer: ADDRESS,
    nonce: 0,
    createdAt: "2026-10-09T12:00:00.000Z",
  });
  await pending.complete(OPERATION, "approve-usdc", response);
  const restarted = createPendingTransactions(home);
  expect(await restarted.get(OPERATION, "approve-usdc")).toBeUndefined();
  expect(await restarted.reconciled(OPERATION, "approve-usdc")).toEqual(response);
});

it("persists an unmatched resolution transaction and confirmation across process instances", async () => {
  const { home, pending } = await store();
  await pending.put(OPERATION, "resolve-unmatched-dispute", {
    chainId: 84532,
    txHash: HASH,
    raw: "0x1234",
    signer: ADDRESS,
    nonce: 0,
    createdAt: "2026-10-09T12:00:00.000Z",
  });
  const restarted = createPendingTransactions(home);
  expect(await restarted.get(OPERATION, "resolve-unmatched-dispute")).toMatchObject({
    txHash: HASH,
  });
  const response = tasksResponseSchemas.reconcileOperation.parse({
    operation: {
      id: OPERATION,
      kind: "escrow-unmatched-resolution",
      state: "confirmed",
      step: "resolve-unmatched-dispute",
      expectedActor: null,
      transactionHash: HASH,
      plan: null,
    },
    milestone: { id: KEY, workOrderId: OPERATION },
  });
  await restarted.complete(OPERATION, "resolve-unmatched-dispute", response);
  expect(
    await createPendingTransactions(home).reconciled(OPERATION, "resolve-unmatched-dispute"),
  ).toEqual(response);
});
