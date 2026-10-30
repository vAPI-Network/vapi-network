import type { ConnectableAppId, ConnectResult } from "../shared/apps.js";
import type { Overview } from "../shared/overview.js";
import type { SignerRequest, SignerResponse } from "../signer/messages.js";
import type { Preferences } from "../main/preferences.js";

export type OverviewResult = ({ ok: true } & Overview) | { ok: false; message: string };

declare global {
  interface Window {
    desktop: {
      signer(request: SignerRequest): Promise<SignerResponse>;
      appSnippet(id: ConnectableAppId, wallet: string): Promise<string | null>;
      connectApp(id: ConnectableAppId, wallet: string): Promise<ConnectResult>;
      openAppPage(key: "grok-connectors"): Promise<void>;
      overview(): Promise<OverviewResult>;
      custodyAccepted(): Promise<boolean>;
      acceptCustody(version: string): Promise<void>;
      copyText(text: string): Promise<void>;
      openExplorer(url: string): Promise<void>;
      openConsole(url: string): Promise<{ opened: true } | { opened: false; page: string }>;
      printKit(): Promise<boolean>;
      appInfo(): Promise<{ version: string }>;
      preferences(): Promise<Preferences>;
      setCrashReports(on: boolean): Promise<Preferences>;
      sendFeedback(): Promise<void>;
      showCrashReports(): Promise<void>;
    };
  }
}
export {};
