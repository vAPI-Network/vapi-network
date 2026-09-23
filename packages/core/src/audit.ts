import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isMissingFile } from "./config.js";

/**
 * The local trail of everything that touched a key or a wallet: one JSON line
 * per event in `<home>/audit.log`, mode 0600. It exists so a person can answer
 * "did anything export my phrase while the agent was running" without trusting
 * the agent's own account of it.
 *
 * A line never contains a secret. It records what happened, to which wallet,
 * its linked owner, whether a terminal was attached, and which agent marker
 * was set — nothing that could help someone spend the wallet.
 */
export const AUDIT_EVENTS = [
  "secret.export.phrase",
  "secret.export.key",
  "wallet.create",
  "wallet.import",
  "wallet.remove",
  "wallet.restore",
  "wallet.rename",
  "wallet.default",
  "wallet.caps",
  // A wallet's passphrase entering or leaving the OS secret store. The
  // passphrase itself is never here; only that an agent can now use it.
  "wallet.unlock",
  "wallet.lock",
  // An MCP session switching its active wallet. Nothing on disk changes, but
  // the wallet the agent pays from does, so the line has to be there.
  "wallet.use.session",
  "passphrase.change",
  // The registry API key a provider publishes with entering or leaving this
  // machine. The key itself is never in the line; only that one is now here.
  "auth.key.set",
  "auth.key.clear",
  "agent.linked",
  "agent.unlinked",
  // Agent run lifecycle only. These lines must never contain secrets.
  "agent.run.start",
  "agent.run.step",
  "agent.run.pay",
  "agent.run.declined",
  "agent.run.end",
  // Router balance purchases and automatic refills. These lines record only
  // the tier/network or a safe refusal class, never an access token or key.
  "router.buy",
  "router.refill.declined",
  // A listing this machine created or moved through the registry's states.
  // The slug is not a secret, so it is worth having in the trail.
  "listing.publish",
  "listing.status",
  // The wallet proving it is the payee of indexed listings, to own them.
  "listing.claim",
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export type AuditRecord = {
  event: AuditEvent;
  /** The wallet the event acted on, when one was selected. */
  wallet?: string;
  /** The owner wallet of a linked agent. Never an access token or Router key. */
  owner?: string;
  /** Whether a real terminal was attached when the event happened. */
  tty: boolean;
  /** The agent or CI variable that was set, if any. */
  agentMarker?: string;
  /** A short human note, such as a refusal or a new name. Never a secret. */
  detail?: string;
};

export type AuditEntry = AuditRecord & { time: string };

export const AUDIT_FILE = "audit.log";

export type AuditOptions = {
  /** Injected clock, so tests get a fixed timestamp. */
  now?: () => Date;
};

export function auditLogPath(home: string): string {
  return join(home, AUDIT_FILE);
}

/**
 * Appends one line. Append-only from the client's point of view: nothing in
 * vAPI ever rewrites or truncates this file, and a failure to write it must
 * never be swallowed by the caller, since a missing line is the interesting
 * case.
 */
export async function appendAudit(
  home: string,
  record: AuditRecord,
  options: AuditOptions = {},
): Promise<AuditEntry> {
  const entry: AuditEntry = {
    time: (options.now?.() ?? new Date()).toISOString(),
    event: record.event,
    ...(record.wallet === undefined ? {} : { wallet: record.wallet }),
    ...(record.owner === undefined ? {} : { owner: record.owner }),
    tty: record.tty,
    ...(record.agentMarker === undefined ? {} : { agentMarker: record.agentMarker }),
    ...(record.detail === undefined ? {} : { detail: record.detail }),
  };
  const path = auditLogPath(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  // A file that already existed keeps its own mode, so tighten it every time.
  await chmod(path, 0o600);
  return entry;
}

/** The lines written so far, oldest first. An absent log reads as empty. */
export async function readAuditLog(home: string): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await readFile(auditLogPath(home), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}
