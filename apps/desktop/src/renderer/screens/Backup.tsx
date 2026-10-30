// apps/desktop/src/renderer/screens/Backup.tsx
import { formatCode } from "../relay-flow.js";
import { Alert, Button, Waiting } from "../ui/primitives.js";
import { useBackupRelay } from "../useBackupRelay.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Mono } from "../ui/technical.js";

export function Backup({ onDone }: { onDone: () => Promise<void> }) {
  const { view, start } = useBackupRelay("enroll");

  return (
    <>
      <PageHeader
        title="Encrypted backup"
        lead="vAPI keeps a locked copy of your agent wallets. Only your vAPI account can open it, so a new Mac can get your wallets back after you approve it in the console. vAPI cannot read the copy."
      />
      <div className="flex max-w-[560px] flex-col gap-6">
        {(view.kind === "idle" || view.kind === "starting") && (
          <div>
            <Button busy={view.kind === "starting"} onClick={() => void start()}>
              Turn on
            </Button>
          </div>
        )}
        {view.kind === "code" && (
          <>
            <p className="m-0">In the console, open My agents and enter this code:</p>
            <p className="m-0 text-[32px] tracking-[0.1em] tabular-nums">
              <Mono>{formatCode(view.code)}</Mono>
            </p>
            <Waiting label="Waiting for your approval in the console" />
            <div>
              <Button variant="secondary" onClick={() => void window.desktop.openConsole(view.url)}>
                Open the console again
              </Button>
            </div>
          </>
        )}
        {view.kind === "enrolled" && (
          <>
            <Alert tone="success">
              Encrypted backup is on. vAPI Desktop updates it after every change.
            </Alert>
            <div>
              <Button onClick={() => void onDone()}>Done</Button>
            </div>
          </>
        )}
        {view.kind === "error" && (
          <>
            <Alert tone="error">{view.message}</Alert>
            <div>
              <Button onClick={() => void start()}>Start again</Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
