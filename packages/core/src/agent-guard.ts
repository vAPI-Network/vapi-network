/**
 * Whether this run may put a secret on the screen.
 *
 * A recovery phrase, a private key and a passphrase are the only secrets vAPI
 * has, and an agent never needs one to pay for an API. So they are shown only
 * when a person is demonstrably present: stdin and stdout are both a real
 * terminal, and no environment variable says an agent or a CI job is driving
 * the command. Addresses, balances, receipts and wallet names are not secrets
 * and are never gated here.
 */

/**
 * The variables that mean "something other than a person is reading this".
 * `VAPI_NO_SECRETS` is the documented way to lock down a machine's agent
 * configuration; the rest are set by the agents and CI systems themselves.
 */
export const AGENT_MARKER_VARIABLES = [
  "VAPI_NO_SECRETS",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CURSOR_AGENT",
  "CODEX_SANDBOX",
  "OPENAI_CODEX",
  "AGENT",
  "CI",
] as const;

export type AgentMarker = (typeof AGENT_MARKER_VARIABLES)[number];

/** Whether each standard stream is attached to a terminal. */
export type SecretsStreams = {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
};

/**
 * The verdict. `reason` is written to be shown to a person directly after the
 * refusal line, so it names the stream or the variable that decided it.
 */
export type SecretsDecision = {
  allowed: boolean;
  reason?: string;
  marker?: AgentMarker;
};

/** The first marker variable this environment sets to a non-empty value. */
export function activeAgentMarker(env: NodeJS.ProcessEnv): AgentMarker | undefined {
  return AGENT_MARKER_VARIABLES.find((name) => (env[name] ?? "").trim().length > 0);
}

/**
 * Decides whether a secret may be printed. Both streams must be a terminal,
 * because a redirected stdout writes the secret into a file and a piped stdin
 * means the answers are scripted; then no agent marker may be set.
 */
export function secretsAllowed(env: NodeJS.ProcessEnv, streams: SecretsStreams): SecretsDecision {
  if (!streams.stdinIsTTY) {
    return { allowed: false, reason: "stdin is not a terminal." };
  }
  if (!streams.stdoutIsTTY) {
    return { allowed: false, reason: "stdout is not a terminal." };
  }
  const marker = activeAgentMarker(env);
  if (marker !== undefined) {
    return { allowed: false, reason: `${marker} is set.`, marker };
  }
  return { allowed: true };
}
