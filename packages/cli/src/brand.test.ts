import { describe, expect, it } from "vitest";

import {
  MARK_BLOCKS,
  WELCOME,
  WORDMARK,
  animateBanner,
  renderBanner,
  renderMarkFrames,
  shouldAnimateMark,
} from "./brand.js";

const BLOCK = "█";
const ESCAPE = "\u001b";
const MARK_ROWS = 12;
const ROWS_PER_BLOCK = 4;
// Built from ESCAPE so the literal control character never reaches the source.
// A cell run is a background colour (or reverse video for ink) around spaces.
const SEGMENT = new RegExp(
  `${ESCAPE}\\[(?:48;2;\\d{1,3};\\d{1,3};\\d{1,3}|7)m +${ESCAPE}\\[0m`,
  "g",
);

function blocksPainted(frame: string): number {
  return (frame.match(SEGMENT)?.length ?? 0) / ROWS_PER_BLOCK;
}

describe("renderMarkFrames", () => {
  it("returns one frame per reveal step, each exactly twelve rows tall", () => {
    const frames = renderMarkFrames({ color: true });

    expect(frames).toHaveLength(new Set(MARK_BLOCKS.map((block) => block.delay)).size);
    expect(frames).toHaveLength(7);
    for (const frame of frames) expect(frame.split("\n")).toHaveLength(MARK_ROWS);
  });

  it("paints all nine mark blocks as solid cell runs in the final frame", () => {
    const frames = renderMarkFrames({ color: true });

    expect(MARK_BLOCKS).toHaveLength(9);
    expect(blocksPainted(frames[frames.length - 1]!)).toBe(MARK_BLOCKS.length);
  });

  it("reveals blocks cumulatively, never removing one that already appeared", () => {
    const frames = renderMarkFrames({ color: true });

    expect(frames.map(blocksPainted)).toEqual([1, 3, 4, 5, 7, 8, 9]);
  });

  it("scales the source geometry into a 28x12 mark without colour", () => {
    const frames = renderMarkFrames();
    const band0 = `${BLOCK.repeat(3)} ${BLOCK.repeat(2)}${" ".repeat(14)}${BLOCK.repeat(8)}`;
    const band1 = `${" ".repeat(5)}${BLOCK.repeat(4)}${" ".repeat(6)}${BLOCK.repeat(8)}${" ".repeat(5)}`;
    const band2 = `${" ".repeat(11)}${BLOCK.repeat(8)}${" ".repeat(9)}`;

    for (const frame of frames) expect(frame).not.toContain(ESCAPE);
    expect(frames[frames.length - 1]!.split("\n")).toEqual([
      band0,
      band0,
      band0,
      band0,
      band1,
      band1,
      band1,
      band1,
      band2,
      band2,
      band2,
      band2,
    ]);
    for (const line of frames[frames.length - 1]!.split("\n")) expect(line).toHaveLength(28);
  });
});

describe("renderBanner", () => {
  it("frames the mark with the welcome text and the version", () => {
    const lines = renderBanner({ version: "9.9.9" }).split("\n");

    expect(lines).toHaveLength(MARK_ROWS + 4);
    expect(lines[0]!.startsWith("╭")).toBe(true);
    expect(lines[lines.length - 1]!.startsWith("╰")).toBe(true);
    expect(lines.some((line) => line.includes(WELCOME))).toBe(true);
    expect(lines.some((line) => line.includes(`${WORDMARK} v9.9.9`))).toBe(true);
    const widths = new Set(lines.map((line) => line.length));
    expect(widths.size).toBe(1);
  });
});

describe("shouldAnimateMark", () => {
  it("animates in a plain interactive terminal", () => {
    expect(shouldAnimateMark({ isTty: true, env: {} })).toBe(true);
  });

  it("never animates for --json, a redirected stdout, NO_COLOR, or CI", () => {
    expect(shouldAnimateMark({ isTty: true, json: true, env: {} })).toBe(false);
    expect(shouldAnimateMark({ isTty: false, env: {} })).toBe(false);
    expect(shouldAnimateMark({ isTty: true, env: { NO_COLOR: "1" } })).toBe(false);
    expect(shouldAnimateMark({ isTty: true, env: { CI: "true" } })).toBe(false);
  });
});

describe("animateBanner", () => {
  it("redraws the framed banner in place and leaves the finished banner on screen", async () => {
    const chunks: string[] = [];
    const waits: number[] = [];

    await animateBanner({
      version: "0.2.1",
      write: (chunk) => chunks.push(chunk),
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    const output = chunks.join("");
    expect(waits).toEqual([70, 70, 70, 70, 70, 70]);
    expect(output).toContain(`${ESCAPE}[${MARK_ROWS + 4}A`);
    expect(output).toContain(`${ESCAPE}[2K`);
    expect(output).toContain(`${ESCAPE}[?25l`);
    expect(output.endsWith(`${ESCAPE}[?25h`)).toBe(true);
    expect(output).toContain(WELCOME);
    expect(output).toContain(`${WORDMARK} v0.2.1`);
  });
});
