import { describe, expect, it } from "vitest";

import { safeTasksChainError } from "./chain-error.js";
import { TasksClientError } from "./client.js";

describe("safeTasksChainError", () => {
  it.each([
    [
      new TasksClientError("http", "Scope is closed", 422, "scope.closed"),
      "scope.closed: Scope is closed",
    ],
    [new TasksClientError("http", "upstream failed", 500), "http_500: upstream failed"],
    [
      new TasksClientError("http", "secret bearer", 401, "token_expired"),
      "token_expired (status 401)",
    ],
    [new TasksClientError("http", "secret bearer", 403), "http_403 (status 403)"],
  ])("normalizes client errors", (error, message) => {
    expect(safeTasksChainError(error, false, false).message).toBe(message);
  });

  it.each([
    [`failed 0x${"ab".repeat(8)}`, "http_500: failed [redacted]"],
    ['failed {"secret":true}', "http_500: failed [redacted]"],
    ["first line\nsecret second line", "http_500: first line"],
  ])("redacts unsafe normalized detail", (detail, expected) => {
    expect(
      safeTasksChainError(new TasksClientError("http", detail, 500), false, false).message,
    ).toBe(expected);
  });
});
