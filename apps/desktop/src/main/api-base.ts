import { DEFAULT_REGISTRY_URL } from "@vapi-network/core";

/** The vAPI server the app links to: `VAPI_REGISTRY_URL`, as the CLI reads it, or production. */
export function resolveApiBase(env: NodeJS.ProcessEnv): string {
  const configured = env.VAPI_REGISTRY_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Invalid configuration must not prevent main from starting.
    }
    console.warn(
      `Ignoring invalid VAPI_REGISTRY_URL ${JSON.stringify(env.VAPI_REGISTRY_URL)}; using ${DEFAULT_REGISTRY_URL}.`,
    );
  }
  return new URL(DEFAULT_REGISTRY_URL).origin;
}

/** The trusted page for entering a link code manually. */
export function consoleLinkPage(apiBase: string): string {
  return new URL("/link", new URL(apiBase).origin).href;
}

const CONSOLE_PATHS = new Set(["/link", "/agents"]);

/** Only the console's link and agents pages on the configured server open from the app. */
export function consoleLinkUrl(value: unknown, apiBase: string): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  // URL parsing drops empty userinfo. Require an explicit authority and check it
  // before parsing, after removing the tabs/newlines the URL parser ignores.
  const authority = value
    .replace(/[\t\r\n]/g, "")
    .trim()
    .match(/^https?:\/\/([^/\\?#]+)/i)?.[1];
  if (authority === undefined || authority.includes("@")) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== new URL(apiBase).origin ||
      !CONSOLE_PATHS.has(url.pathname) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
