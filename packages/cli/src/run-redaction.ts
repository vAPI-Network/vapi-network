import { redactRunText, redactRunValue } from "@vapi-network/mcp";

export function redactDetachedRunValue<T>(value: T, environment: NodeJS.ProcessEnv): T {
  return redactRunValue(value, environment);
}

/** Redacts one output line of a detached child; a JSON line stays valid JSON. */
export function redactDetachedRunText(value: string, environment: NodeJS.ProcessEnv): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify(redactRunValue(parsed, environment));
    }
  } catch {
    // Not a JSON line: redact it as text.
  }
  return redactRunText(value, environment);
}
