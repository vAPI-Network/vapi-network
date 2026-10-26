import { expect, it } from "vitest";
import { createTasksClient, type TasksClient } from "./client.js";
import { requireTaskMethod } from "./operation-support.js";

// Compile-time fixture: an adapter implementing only the public interface before Tasks v2.
const factory = createTasksClient({
  baseUrl: "https://tasks.example",
  fetch: async () => {
    throw new Error("No network in compatibility fixture");
  },
});
const previousImplementation: TasksClient = {
  listOrders: factory.listOrders,
  getOrder: factory.getOrder,
  createOrder: factory.createOrder,
  propose: factory.propose,
  submit: factory.submit,
  events: factory.events,
  board: factory.board,
  feed: factory.feed,
  publicTask: factory.publicTask,
  receipt: factory.receipt,
  earn: factory.earn,
  acceptProposal: factory.acceptProposal,
  getScopes: factory.getScopes,
  proposeScope: factory.proposeScope,
  signScope: factory.signScope,
  listMessages: factory.listMessages,
  sendMessage: factory.sendMessage,
  createEscrow: factory.createEscrow,
  fundEscrow: factory.fundEscrow,
  deliverEscrow: factory.deliverEscrow,
  releaseEscrow: factory.releaseEscrow,
  refundEscrow: factory.refundEscrow,
  disputeEscrow: factory.disputeEscrow,
  counterEvidenceEscrow: factory.counterEvidenceEscrow,
  resolveUnmatchedEscrow: factory.resolveUnmatchedEscrow,
  chainState: factory.chainState,
  createUpload: factory.createUpload,
  finalizeUpload: factory.finalizeUpload,
  uploadFile: factory.uploadFile,
  deployment: factory.deployment,
  recordTransaction: factory.recordTransaction,
  reconcileOperation: factory.reconcileOperation,
  recoverOperation: factory.recoverOperation,
  abandonOperation: factory.abandonOperation,
  finalizeEscrow: factory.finalizeEscrow,
  finalizeOrder: factory.finalizeOrder,
  configureWebhook: factory.configureWebhook,
};
it("accepts the previous SDK interface and reports unsupported v2 verbs clearly", () => {
  expect(previousImplementation.getOrder).toBe(factory.getOrder);
  for (const name of ["post", "pending", "checkin"] as const)
    expect(() => requireTaskMethod(previousImplementation, name)).toThrowError(
      expect.objectContaining({ code: "not_supported" }),
    );
});
