// apps/desktop/src/renderer/screens/EmergencyKit.tsx
import { useState } from "react";
import { createPortal } from "react-dom";

import type { Overview } from "../../shared/overview.js";
import { checkIndexes, wordMatches } from "../kit.js";
import { PageHeader } from "../ui/PageHeader.js";
import { KitSheet } from "../ui/KitSheet.js";
import { Alert, Button, Field } from "../ui/primitives.js";
import { Mono } from "../ui/technical.js";

type Stage =
  | { kind: "password" }
  | { kind: "words"; words: string[] }
  | { kind: "check"; words: string[]; ask: [number, number] };

/**
 * Spec §8 Emergency Kit: password → the words → print (or save as PDF in the print dialog) or
 * write them down and type two of them back. The app never copies the words or writes them to a
 * file, and they leave memory when this page closes.
 */
export function EmergencyKit({
  overview,
  onDone,
}: {
  overview: Overview;
  onDone: () => Promise<void>;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "password" });
  const [password, setPassword] = useState("");
  const [answers, setAnswers] = useState<[string, string]>(["", ""]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function reveal() {
    setBusy(true);
    setError(undefined);
    const result = await window.desktop.signer({ type: "revealPhrase", password });
    setBusy(false);
    setPassword("");
    if (result.ok && result.type === "revealPhrase")
      setStage({ kind: "words", words: result.words });
    else if (!result.ok) setError(result.message);
  }

  async function finish() {
    const result = await window.desktop.signer({ type: "confirmKit" });
    if (!result.ok) return setError(result.message);
    setStage({ kind: "password" });
    await onDone();
  }

  async function print(words: string[]) {
    if (await window.desktop.printKit()) await finish();
    else setStage({ kind: "words", words });
  }

  const date = new Date().toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <>
      <PageHeader
        title="Your Emergency Kit"
        lead={`${stage.kind === "password" ? "The words" : `${stage.words.length} words`} that bring back your agent wallets if you forget your password or lose this Mac. Print them or write them down, and keep them offline.`}
      />
      <div className="flex max-w-[560px] flex-col gap-6">
        {stage.kind === "password" && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void reveal();
            }}
          >
            <Field
              label="Password"
              type="password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint="The password you unlock vAPI Desktop with."
            />
            <div>
              <Button type="submit" busy={busy} disabled={password.length === 0}>
                Show the words
              </Button>
            </div>
          </form>
        )}
        {stage.kind === "words" && (
          <>
            <Alert tone="warning">
              Anyone with these words can take the money. Do not take a photo or a screenshot.
            </Alert>
            <ol className="border-line m-0 grid list-none grid-cols-3 gap-px border p-0">
              {stage.words.map((word, index) => (
                <li key={index} className="bg-background flex gap-2 px-4 py-3 text-[15px]">
                  <Mono className="text-fg-dim tabular-nums">{index + 1}.</Mono>
                  <Mono>{word}</Mono>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void print(stage.words)}>Print or save as PDF</Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setAnswers(["", ""]);
                  setStage({
                    kind: "check",
                    words: stage.words,
                    ask: checkIndexes(stage.words.length),
                  });
                }}
              >
                I wrote them down
              </Button>
            </div>
            {/* A direct child of <body>, so printing can hide the whole app, scroll containers included. */}
            {createPortal(
              <KitSheet
                words={stage.words}
                date={date}
                wallets={overview.wallets.map(({ name, address }) => ({ name, address }))}
              />,
              document.body,
            )}
          </>
        )}
        {stage.kind === "check" && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const ok = stage.ask.every((index, slot) =>
                wordMatches(stage.words, index, answers[slot] ?? ""),
              );
              if (ok) void finish();
              else setError("One of the words is not right. Check your paper and try again.");
            }}
          >
            {stage.ask.map((index, slot) => (
              <Field
                key={index}
                label={`Word ${index + 1}`}
                value={answers[slot] ?? ""}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoFocus={slot === 0}
                onChange={(event) =>
                  setAnswers((current) => {
                    const next: [string, string] = [...current];
                    next[slot] = event.target.value;
                    return next;
                  })
                }
              />
            ))}
            <div className="flex gap-3">
              <Button type="submit">Check</Button>
              <Button
                variant="ghost"
                onClick={() => setStage({ kind: "words", words: stage.words })}
              >
                Show the words again
              </Button>
            </div>
          </form>
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </>
  );
}
