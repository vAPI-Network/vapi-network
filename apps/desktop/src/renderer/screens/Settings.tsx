// apps/desktop/src/renderer/screens/Settings.tsx
import type { ReactNode } from "react";

import type { Overview } from "../../shared/overview.js";
import { youRow } from "../link-flow.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Badge, Button } from "../ui/primitives.js";

/** Settings, grouped so later options (auto-lock, Touch ID) have a home. */
export function Settings({
  overview,
  onConnect,
  onLock,
  onKit,
  onBackup,
  version,
  crashReports,
  betaBusy,
  betaError,
  onFeedback,
  onCrashReports,
  onShowReports,
}: {
  overview: Overview;
  onConnect: () => void;
  onLock: () => void;
  onKit: () => void;
  onBackup: () => void;
  version: string | null;
  crashReports: boolean | null;
  betaBusy: boolean;
  betaError: string | null;
  onFeedback: () => void;
  onCrashReports: (on: boolean) => void;
  onShowReports: () => void;
}) {
  const you = youRow(overview.owner, overview.wallets);
  const recovery = overview.recovery;
  const backup = recovery?.backup;
  const backedUp = backup?.lastUploadAt
    ? `Backed up ${new Date(backup.lastUploadAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`
    : "Waiting for the first backup";
  return (
    <>
      <PageHeader title="Settings" />
      <Group title="vAPI account">
        <Row
          label={you.address ?? "No account connected"}
          hint="The wallet you sign in to the console with. It approves agent wallets and can revoke them."
        >
          {you.connect ? (
            <Button variant="secondary" size="compact" onClick={onConnect}>
              Connect
            </Button>
          ) : (
            <Badge tone="live">Connected</Badge>
          )}
        </Row>
      </Group>
      <Group title="Recovery">
        <Row
          label="Emergency Kit"
          hint={
            recovery === null
              ? "Not available right now."
              : recovery.kit
                ? "Made. Make it again if you lost the paper."
                : "Not made yet. The Kit works even without encrypted backup or vAPI."
          }
        >
          <Button variant="secondary" size="compact" disabled={recovery === null} onClick={onKit}>
            {recovery?.kit ? "Make again" : "Make the kit"}
          </Button>
        </Row>
        <Row
          label="Encrypted backup"
          hint={
            recovery === null
              ? "Not available right now."
              : backup?.enabled
                ? backedUp
                : "Connect your vAPI account, then turn it on."
          }
        >
          {backup?.enabled ? (
            <Badge tone={backup.failed ? "blocked" : "live"}>
              {backup.failed ? "Failed" : "On"}
            </Badge>
          ) : (
            <Button
              variant="secondary"
              size="compact"
              disabled={recovery === null || you.connect}
              onClick={onBackup}
            >
              Turn on
            </Button>
          )}
        </Row>
      </Group>
      <Group title="This Mac">
        <Row
          label="Lock vAPI Desktop"
          hint="Agents cannot pay while vAPI Desktop is locked. Your password unlocks it."
        >
          <Button variant="secondary" size="compact" onClick={onLock}>
            Lock now
          </Button>
        </Row>
        <Row label="Appearance" hint="Dark. A light theme comes in a later version.">
          <span className="text-fg-dim text-[13px]">Dark</span>
        </Row>
      </Group>
      <Group title="Beta">
        <Row
          label="Send feedback"
          hint="Opens an email with the app and macOS version. Add what happened."
        >
          <Button variant="secondary" size="compact" disabled={betaBusy} onClick={onFeedback}>
            Send feedback
          </Button>
        </Row>
        <Row
          label="Keep crash reports"
          hint="Off by default. Saved on this Mac only, with paths, addresses and words removed. Attach them to feedback if you want."
        >
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="compact"
              disabled={crashReports === null || betaBusy}
              onClick={() => onCrashReports(!crashReports)}
            >
              {crashReports ? "Turn off" : "Turn on"}
            </Button>
            {crashReports && (
              <Button
                variant="secondary"
                size="compact"
                disabled={betaBusy}
                onClick={onShowReports}
              >
                Show reports
              </Button>
            )}
          </div>
        </Row>
        {betaError && (
          <p className="text-pink-text m-0" role="alert">
            {betaError}
          </p>
        )}
      </Group>
      <Group title="About">
        <Row label="vAPI Desktop" hint="Keys stay on this Mac. vAPI cannot move your money.">
          <span className="text-fg-dim text-[13px] tabular-nums">{version ?? "Unavailable"}</span>
        </Row>
      </Group>
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-[18px] leading-6 font-medium">{title}</h2>
      <div className="border-line divide-line divide-y border">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">{label}</span>
        <span className="text-fg-dim text-[13px]">{hint}</span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
