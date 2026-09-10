import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";

import { DEFAULT_REGISTRY_URL, getVapiPaths } from "./config.js";
import { createPublicFetch, type LookupFn } from "./net-guard.js";
import { readReceipts } from "./receipts.js";

export const VAPI_CLIENT_VERSION = "0.2.0-dev.3";

export type SupportSystemInfo = {
  platform: string;
  release: string;
  arch: string;
  node: string;
};

export type SupportReport = {
  message: string;
  clientVersion: string;
  os: {
    platform: string;
    release: string;
    arch: string;
  };
  node: string;
  receiptIds: string[];
  receiptAddresses?: Array<{
    receiptId: string;
    payer?: string;
    payTo?: string;
  }>;
};

export type CreateSupportReportOptions = {
  message: string;
  includeAddresses?: boolean;
  send?: boolean;
  reportsDirectory?: string;
  receiptsPath?: string;
  clientVersion?: string;
  now?: Date;
  systemInfo?: SupportSystemInfo;
  registryUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  allowPrivateNetwork?: boolean;
  lookup?: LookupFn;
};

export type CreateSupportReportResult = {
  path: string;
  issueUrl: string;
  report: SupportReport;
  responseCode?: number;
};

/** Write a privacy-preserving support report locally and optionally upload it. */
export async function createSupportReport(
  options: CreateSupportReportOptions,
): Promise<CreateSupportReportResult> {
  const message = options.message.trim();
  if (!message) throw new Error("Support report message must not be empty.");

  const paths = getVapiPaths();
  const reportsDirectory = options.reportsDirectory ?? join(paths.directory, "reports");
  const receipts = await readReceipts(options.receiptsPath ?? paths.receipts, { limit: 5 });
  const system = options.systemInfo ?? defaultSystemInfo();
  const report: SupportReport = {
    message,
    clientVersion: options.clientVersion ?? VAPI_CLIENT_VERSION,
    os: {
      platform: system.platform,
      release: system.release,
      arch: system.arch,
    },
    node: system.node,
    receiptIds: receipts.map(({ id }) => id),
    ...(options.includeAddresses
      ? {
          receiptAddresses: receipts.flatMap((receipt) => {
            const payer = receipt.payer;
            const payTo = receipt.quote?.payTo;
            if (payer === undefined && payTo === undefined) return [];
            return [
              {
                receiptId: receipt.id,
                ...(payer === undefined ? {} : { payer }),
                ...(payTo === undefined ? {} : { payTo }),
              },
            ];
          }),
        }
      : {}),
  };

  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const path = join(reportsDirectory, `${sanitizeTimestamp(timestamp)}.json`);
  await mkdir(reportsDirectory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(path, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });

  const issueUrl = buildSupportIssueUrl(message, report.clientVersion);
  if (!options.send) return { path, issueUrl, report };

  const env = options.env ?? process.env;
  const registryUrl =
    options.registryUrl?.trim() || env.VAPI_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL;
  const fetchImpl =
    options.fetchImpl ??
    createPublicFetch({
      allowPrivateNetwork: options.allowPrivateNetwork ?? false,
      ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    });
  const response = await fetchImpl(supportEndpoint(registryUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialized,
  });
  await response.body?.cancel().catch(() => undefined);
  return { path, issueUrl, report, responseCode: response.status };
}

export function buildSupportIssueUrl(message: string, version = VAPI_CLIENT_VERSION): string {
  return (
    "https://github.com/vAPI-Network/vapi-network/issues/new?template=bug.yml" +
    `&title=${encodeURIComponent(message)}` +
    `&version=${encodeURIComponent(version)}`
  );
}

function defaultSystemInfo(): SupportSystemInfo {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
  };
}

function sanitizeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

function supportEndpoint(registryUrl: string): URL {
  const endpoint = new URL(registryUrl);
  endpoint.search = "";
  endpoint.hash = "";
  const prefix = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/+$/, "");
  endpoint.pathname = `${prefix}/api/support/reports`;
  return endpoint;
}
