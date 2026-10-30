// apps/desktop/src/renderer/relay-flow.ts
import type { BackupPollState, BackupStartResult } from "../signer/messages.js";

export type RelayView =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "code"; code: string; url: string }
  | { kind: "approved"; owner: `0x${string}` }
  | { kind: "enrolled" }
  | { kind: "error"; message: string };

export function relayView(result: BackupStartResult | BackupPollState): RelayView {
  if ("mode" in result) {
    switch (result.mode) {
      case "browser":
        return { kind: "code", code: result.code, url: result.url };
      case "error":
        return { kind: "error", message: result.message };
    }
  }
  switch (result.state) {
    case "none":
      return { kind: "idle" };
    case "pending":
      return { kind: "code", code: result.code, url: result.url };
    case "enrolled":
      return { kind: "enrolled" };
    case "approved":
      return { kind: "approved", owner: result.owner };
    case "failed":
      return { kind: "error", message: result.message };
  }
}

export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
