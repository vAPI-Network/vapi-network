import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { HELP, runCli, type CliIo } from "./cli.js";

/**
 * The help text is the CLI's public contract. A command that `runCli` accepts
 * but never lists is undiscoverable, and a command the help promises but never
 * dispatches is a lie. These tests keep the two in step, in both directions.
 */

/** Commands `runCli` answers before its switch, so they have no `case` label. */
const PRE_SWITCH_COMMANDS = ["version", "help"] as const;

/** An option no command defines, used to prove a command name is routed at all. */
const UNKNOWN_OPTION = "--vapi-alignment-probe";

const source = await readFile(new URL("./cli.ts", import.meta.url), "utf8");

/**
 * The `case "…"` labels of one switch, told apart by indentation: `runCli`'s
 * switch sits two blocks deep, `walletCommand`'s one. Prettier fixes the
 * indentation of this file, so the depth is stable.
 */
function caseLabels(indent: number): Set<string> {
  const pattern = new RegExp(`^ {${indent}}case "([a-z-]+)":$`, "gm");
  return new Set([...source.matchAll(pattern)].map((match) => match[1]!));
}

/** Every `vapi <command> …` usage line the help text lists. */
function usageLines(): { command: string; subcommand?: string }[] {
  const lines = [...HELP.matchAll(/^ {2}vapi ([a-z-]+)(?: ([a-z-]+))?/gm)];
  return lines.map((match) => ({
    command: match[1]!,
    ...(match[2] === undefined ? {} : { subcommand: match[2] }),
  }));
}

const helpCommands = new Set(usageLines().map(({ command }) => command));
const helpWalletSubcommands = new Set(
  usageLines()
    .filter(({ command }) => command === "wallet")
    .map(({ subcommand }) => subcommand!),
);

describe("the help text and runCli list the same commands", () => {
  it("dispatches every command the help text promises", () => {
    const dispatched = new Set([...caseLabels(6), ...PRE_SWITCH_COMMANDS]);
    expect([...helpCommands].sort()).toEqual([...dispatched].sort());
  });

  it("documents every wallet subcommand walletCommand dispatches", () => {
    expect([...helpWalletSubcommands].sort()).toEqual([...caseLabels(4)].sort());
  });

  it("finds no command in the help text that runCli rejects as unknown", async () => {
    for (const command of helpCommands) {
      const errors: string[] = [];
      const io: CliIo = { stdout: () => {}, stderr: (message) => errors.push(message) };
      // The probe option is never valid, so a routed command fails on the
      // option while an unrouted one fails on its own name.
      await runCli([command, UNKNOWN_OPTION], io, { interactive: false, env: {} });
      expect(errors.join("\n")).not.toContain(`Unknown command ${JSON.stringify(command)}`);
    }
  });

  it("still reports a command nobody defined as unknown", async () => {
    const errors: string[] = [];
    const io: CliIo = { stdout: () => {}, stderr: (message) => errors.push(message) };

    const code = await runCli(["nonsense"], io, { interactive: false, env: {} });

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain('Unknown command "nonsense"');
  });
});
