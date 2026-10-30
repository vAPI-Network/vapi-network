import { useEffect, useState } from "react";

import { HOSTED_MCP_URL, type ConnectResult } from "../../shared/apps.js";
import type { Overview } from "../../shared/overview.js";
import { appCards, type AppCard } from "../apps.js";
import { Alert, Badge, Button } from "./primitives.js";
import { useCopyText } from "../useCopyText.js";
import { Mono } from "./technical.js";

const GROUPS = [
  { id: "chat", title: "Chat and editors" },
  { id: "developer", title: "For developers" },
  { id: "later", title: "Coming later" },
] as const;

export function AppCards({
  wallet,
  overview,
  onChanged,
}: {
  wallet: string;
  overview: Overview;
  onChanged: () => void | Promise<void>;
}) {
  const cards = appCards(overview.apps, wallet, overview.wallets[0]?.name);
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {GROUPS.map((group) => (
        <section key={group.id} className="flex min-w-0 flex-col gap-3">
          <h2 className="text-fg-dim m-0 text-[13px] font-medium">{group.title}</h2>
          {cards
            .filter((card) => card.group === group.id)
            .map((card) => (
              <AppCardRow
                key={`${wallet}:${card.id}`}
                card={card}
                wallet={wallet}
                onChanged={onChanged}
              />
            ))}
        </section>
      ))}
    </div>
  );
}

function AppCardRow({
  card,
  wallet,
  onChanged,
}: {
  card: AppCard;
  wallet: string;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    if (busy || card.id === "grok-apps" || card.id === "chatgpt") return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      setResult(await window.desktop.connectApp(card.id, wallet));
      await onChanged();
    } catch {
      setError("Could not connect the app. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function openGrok() {
    setError(null);
    try {
      await window.desktop.openAppPage("grok-connectors");
    } catch {
      setError("Could not open Grok. Try again.");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="border-line flex min-w-0 flex-col gap-4 border px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
            <h3 className="m-0 text-[14px] font-medium">{card.title}</h3>
            <p className="text-fg-dim m-0 text-[13px] break-words">{card.blurb}</p>
            {card.paysFrom && <p className="text-fg-dim m-0 text-[13px]">{card.paysFrom}</p>}
          </div>
          {card.badge && (
            <Badge tone={card.badge === "Connected" ? "live" : "neutral"}>{card.badge}</Badge>
          )}
          {card.action && (
            <Button
              variant={card.action === "reinstall" ? "secondary" : "default"}
              busy={busy}
              onClick={() => void connect()}
            >
              {card.actionLabel}
            </Button>
          )}
        </div>
        {(card.id === "codex" || card.id === "grok-cli") && (
          <AppSnippet id={card.id} wallet={wallet} />
        )}
        {card.id === "grok-apps" && (
          <div className="flex min-w-0 flex-col items-start gap-3">
            <Mono className="block max-w-full overflow-x-auto text-[12px] whitespace-pre">
              {HOSTED_MCP_URL}
            </Mono>
            <div className="flex flex-wrap gap-3">
              <Button variant="secondary" onClick={() => void openGrok()}>
                Open Grok
              </Button>
              <CopyButton text={HOSTED_MCP_URL} label="Copy URL" />
            </div>
          </div>
        )}
        {card.conflict && <Alert tone="error">{card.conflict}</Alert>}
      </div>
      <div aria-live="polite">
        {result?.ok &&
          result.kind === "opened" &&
          (card.id === "claude-desktop" ? (
            <ClaudeSteps />
          ) : (
            <p className="text-fg-dim m-0">Confirm the install in {card.title}.</p>
          ))}
        {result?.ok && result.kind === "written" && (
          <div className="text-fg-dim flex flex-col gap-1 break-words">
            <p className="m-0">
              Added to <Mono>{result.path}</Mono>.
            </p>
            {result.backup !== null && (
              <p className="m-0">
                Your previous file is saved as <Mono>{result.backup}</Mono>.
              </p>
            )}
            <p className="m-0">Start a new {card.title} session to load vAPI.</p>
          </div>
        )}
      </div>
      {result?.ok === false && <Alert tone="error">{result.message}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}

function AppSnippet({ id, wallet }: { id: "codex" | "grok-cli"; wallet: string }) {
  const [snippet, setSnippet] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void window.desktop
      .appSnippet(id, wallet)
      .then((text) => {
        if (active) setSnippet(text);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [id, wallet]);

  if (error)
    return <Alert tone="error">Could not load the config preview. Open Apps again to retry.</Alert>;
  if (snippet === null) return null;
  return (
    <div className="flex min-w-0 flex-col items-start gap-3">
      <Mono className="bg-surface-2 block w-full overflow-x-auto p-3 text-[12px] whitespace-pre">
        {snippet}
      </Mono>
      <CopyButton text={snippet} label="Copy" />
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copy, copied, error } = useCopyText();
  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="secondary" size="compact" onClick={() => void copy(text)}>
        {copied ? "Copied" : label}
      </Button>
      {error && <Alert tone="error">Could not copy. Try again.</Alert>}
    </div>
  );
}

function ClaudeSteps() {
  return (
    <ol className="text-fg-dim m-0 flex list-decimal flex-col gap-1 pl-5">
      <li>
        In Claude, click <span className="text-foreground font-medium">Install</span>. Claude warns
        that extensions can access your computer. This one only forwards messages to vAPI Desktop.
      </li>
      <li>
        Quit Claude with <span className="text-foreground font-medium">⌘Q</span> and open it again.
      </li>
      <li>
        Ask Claude: <span className="text-foreground">"Search vAPI for a weather API."</span>
      </li>
    </ol>
  );
}
