import { describe, expect, it } from "vitest";

import {
  MARK_BLOCKS,
  WORDMARK,
  animateBanner,
  renderBanner,
  renderMarkFrames,
  shouldAnimateMark,
} from "./brand.js";

const BLOCK = "\u2588";
const ESCAPE = "\u001b";
// Built from ESCAPE so the literal control character never reaches the source.
const SEGMENT = new RegExp(
  `${ESCAPE}\\[(?:38;2;\\d{1,3};\\d{1,3};\\d{1,3}|39)m${BLOCK}+${ESCAPE}\\[0m`,
  "g",
);

describe("renderMarkFrames", () => {
  it("returns one frame per reveal step, each exactly three rows tall", () => {
    const frames = renderMarkFrames({ color: true });

    expect(frames).toHaveLength(new Set(MARK_BLOCKS.map((block) => block.delay)).size);
    expect(frames).toHaveLength(7);
    for (const frame of frames) expect(frame.split("\n")).toHaveLength(3);
  });

  it("paints all nine mark blocks as separate coloured segments in the final frame", () => {
    const frames = renderMarkFrames({ color: true });

    expect(MARK_BLOCKS).toHaveLength(9);
    expect(frames[frames.length - 1]!.match(SEGMENT)).toHaveLength(MARK_BLOCKS.length);
  });

  it("reveals blocks cumulatively, never removing one that already appeared", () => {
    const frames = renderMarkFrames({ color: true });

    expect(frames.map((frame) => frame.match(SEGMENT)?.length ?? 0)).toEqual([1, 3, 4, 5, 7, 8, 9]);
  });

  it("scales the source geometry into a 34-column mark without colour", () => {
    const frames = renderMarkFrames();

    for (const frame of frames) expect(frame).not.toContain(ESCAPE);
    expect(frames[frames.length - 1]).toBe(
      [
        `${BLOCK.repeat(7)}${" ".repeat(17)}${BLOCK.repeat(10)}`,
        `${" ".repeat(6)}${BLOCK.repeat(4)}${" ".repeat(8)}${BLOCK.repeat(10)}`,
        `${" ".repeat(13)}${BLOCK.repeat(10)}`,
      ].join("\n"),
    );
  });
});

describe("renderBanner", () => {
  it("prints the plain mark above the wordmark and version", () => {
    const lines = renderBanner({ version: "9.9.9" }).split("\n");

    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe(WORDMARK);
    expect(lines[4]).toBe("v9.9.9");
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
  it("redraws in place and closes with the wordmark and version", async () => {
    const chunks: string[] = [];
    const waits: number[] = [];

    await animateBanner({
      version: "0.2.0",
      write: (chunk) => chunks.push(chunk),
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    const output = chunks.join("");
    expect(waits).toEqual([70, 70, 70, 70, 70, 70]);
    expect(output).toContain(`${ESCAPE}[3A`);
    expect(output).toContain(`${ESCAPE}[2K`);
    expect(output).toContain(`${ESCAPE}[?25l`);
    expect(output).toContain(`${ESCAPE}[?25h`);
    expect(output.endsWith(`${WORDMARK}\nv0.2.0\n`)).toBe(true);
  });
});
