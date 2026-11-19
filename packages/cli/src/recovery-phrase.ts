import { getPrompts, type CliDependencies, type CliIo } from "./cli-context.js";
import { secretsDecision } from "./wallet-session.js";

export const CUSTODY_NOTICE = [
  "This wallet is yours. vAPI has no copy of the key and cannot recover it.",
  "If you lose this machine and your recovery phrase, the funds are gone.",
].join("\n");

const PHRASE_GATE = "Write these 12 words down, then press Enter.";

const PHRASE_HIDDEN = "Recovery phrase: run vapi backup yourself in a terminal to see it.";

/**
 * The phrase is shown once, to a person, and waits until they say they have it.
 * A script, a piped run or anything an agent drives gets the pointer to
 * `vapi backup` instead: the wallet is still created, but nothing here may end
 * up in a transcript or a log file.
 */
export async function showRecoveryPhrase(
  phrase: string,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<void> {
  if (!secretsDecision(dependencies).allowed) {
    io.stdout(PHRASE_HIDDEN);
    return;
  }
  io.stdout("");
  io.stdout("Recovery phrase. These 12 words restore this wallet, and nothing else does:");
  io.stdout(formatRecoveryPhrase(phrase));
  io.stdout("");
  await getPrompts(dependencies).secret(`${PHRASE_GATE} `);
}

/** One numbered word per line: the shape people copy onto paper without slips. */
export function formatRecoveryPhrase(phrase: string): string {
  return phrase
    .split(" ")
    .map((word, index) => `${String(index + 1).padStart(2, " ")}. ${word}`)
    .join("\n");
}
