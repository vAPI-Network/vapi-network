// apps/desktop/src/renderer/screens/Restore.tsx
import { useState } from "react";

import { phraseProblem, phraseWords } from "../kit.js";
import { strength } from "../password.js";
import { formatCode } from "../relay-flow.js";
import { Alert, Button, Waiting } from "../ui/primitives.js";
import { Mono } from "../ui/technical.js";
import { useBackupRelay } from "../useBackupRelay.js";
import { NewPasswordFields } from "../ui/NewPasswordFields.js";
import { Frame, Title } from "./Frame.js";

export function RestoreFromKit({
  onBack,
  onRestored,
}: {
  onBack: () => void;
  onRestored: () => void;
}) {
  const [text, setText] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState<string[] | undefined>();
  const words = phraseWords(text);
  const ready = phraseProblem(words) === undefined && strength(password).ok && confirm === password;

  async function submit() {
    setBusy(true);
    setError(undefined);
    const result = await window.desktop.signer({
      type: "restorePhrase",
      phrase: words.join(" "),
      password,
    });
    setBusy(false);
    if (result.ok && result.type === "restorePhrase") {
      setText("");
      setRestored(result.wallets);
    } else if (!result.ok) setError(result.message);
  }

  if (restored !== undefined) {
    return (
      <Frame actions={<Button onClick={onRestored}>Continue</Button>}>
        <Title lead="Their names, limits and app connections were not in the kit. Rename them, check the limits and connect your apps again.">
          {restored.length} agent wallet{restored.length === 1 ? "" : "s"} back
        </Title>
      </Frame>
    );
  }

  return (
    <Frame
      actions={
        <>
          <Button type="submit" form="restore-kit" busy={busy} disabled={!ready}>
            Restore
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        </>
      }
    >
      <Title lead="Type the 12 or 24 words from your Emergency Kit in order. vAPI Desktop checks Base for the agent wallets they hold.">
        Restore from Emergency Kit
      </Title>
      <form
        id="restore-kit"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) void submit();
        }}
      >
        <label className="flex flex-col gap-2">
          <span className="text-[13px] font-medium">The words</span>
          <Mono className="flex">
            <textarea
              className="border-line bg-background min-h-[120px] w-full border px-3 py-2 text-[15px]"
              value={text}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              onChange={(event) => setText(event.target.value)}
            />
          </Mono>
          <span className="text-fg-dim text-[13px]">{words.length} words</span>
        </label>
        <NewPasswordFields
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
        />
      </form>
      {error && <Alert tone="error">{error}</Alert>}
    </Frame>
  );
}

export function RestoreFromBackup({
  onBack,
  onRestored,
}: {
  onBack: () => void;
  onRestored: () => void;
}) {
  const { view, start, fail } = useBackupRelay("restore");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function finish() {
    setBusy(true);
    try {
      const result = await window.desktop.signer({ type: "restoreBackup", password });
      if (result.ok) onRestored();
      else fail(result.message);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const ready = strength(password).ok && confirm === password;
  return (
    <Frame
      actions={
        view.kind === "approved" ? (
          <Button type="submit" form="restore-backup" busy={busy} disabled={!ready}>
            Restore
          </Button>
        ) : view.kind === "idle" || view.kind === "starting" || view.kind === "error" ? (
          <>
            <Button busy={view.kind === "starting"} onClick={() => void start()}>
              {view.kind === "error" ? "Start again" : "Get a code"}
            </Button>
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        )
      }
    >
      <Title lead="Your encrypted backup comes back after you approve this Mac in the console with your vAPI account.">
        Restore from backup
      </Title>
      {view.kind === "code" && (
        <>
          <p className="m-0">
            In the console, open My agents, choose the backup to restore and enter this code:
          </p>
          <p className="m-0 text-[32px] tracking-[0.1em] tabular-nums">
            <Mono>{formatCode(view.code)}</Mono>
          </p>
          <Waiting label="Waiting for your approval in the console" />
        </>
      )}
      {view.kind === "approved" && (
        <form
          id="restore-backup"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) void finish();
          }}
        >
          <Alert tone="info">
            Approved by {view.owner.slice(0, 6)}…{view.owner.slice(-4)}. Choose a password for vAPI
            Desktop on this Mac.
          </Alert>
          <NewPasswordFields
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
          />
        </form>
      )}
      {view.kind === "error" && <Alert tone="error">{view.message}</Alert>}
    </Frame>
  );
}
