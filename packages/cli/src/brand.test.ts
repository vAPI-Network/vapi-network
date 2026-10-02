import { describe, expect, it } from "vitest";

import {
  MARK_BLOCKS,
  MARK_COLUMNS,
  MARK_ROWS,
  WELCOME,
  WORDMARK,
  bannerWidth,
  detectColorLevel,
  renderBanner,
  renderMark,
  rgbToAnsi256,
} from "./brand.js";

const BLOCK = "█";
// Built from the char code so the literal control character never reaches the source.
const ESCAPE = String.fromCharCode(27);
const ROWS_PER_BLOCK = 3;
const RUN = new RegExp(`${ESCAPE}\\[[0-9;]+m${BLOCK}+${ESCAPE}\\[0m`, "g");

function blocksPainted(mark: string): number {
  return (mark.match(RUN)?.length ?? 0) / ROWS_PER_BLOCK;
}

function visibleWidth(line: string): number {
  return line.replace(new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g"), "").length;
}

describe("renderMark", () => {
  it("paints all nine blocks as coloured glyph runs at every colour level", () => {
    expect(MARK_BLOCKS).toHaveLength(9);
    expect(blocksPainted(renderMark(3))).toBe(MARK_BLOCKS.length);
    expect(blocksPainted(renderMark(2))).toBe(MARK_BLOCKS.length);
    expect(blocksPainted(renderMark(1))).toBe(MARK_BLOCKS.length);
  });

  it("uses truecolour, 256-colour or 16-colour codes to match the terminal", () => {
    expect(renderMark(3)).toContain(`${ESCAPE}[38;2;255;115;0m`);
    expect(renderMark(2)).toContain(`${ESCAPE}[38;5;${rgbToAnsi256(255, 115, 0)}m`);
    expect(renderMark(2)).not.toContain("38;2;");
    expect(renderMark(1)).toContain(`${ESCAPE}[33m`);
    expect(renderMark(1)).not.toContain("38;");
    // Ink blocks take the terminal's own foreground so they work on light and dark themes.
    expect(renderMark(3)).toContain(`${ESCAPE}[39m${BLOCK}`);
  });

  it("scales the source geometry into a 21x9 mark without colour", () => {
    const band0 = `${BLOCK.repeat(5)}${" ".repeat(10)}${BLOCK.repeat(6)}`;
    const band1 = `${" ".repeat(4)}${BLOCK.repeat(3)}${" ".repeat(4)}${BLOCK.repeat(6)}${" ".repeat(4)}`;
    const band2 = `${" ".repeat(8)}${BLOCK.repeat(6)}${" ".repeat(7)}`;
    const lines = renderMark().split("\n");

    expect(renderMark()).not.toContain(ESCAPE);
    expect(lines).toEqual([band0, band0, band0, band1, band1, band1, band2, band2, band2]);
    expect(lines).toHaveLength(MARK_ROWS);
    for (const line of lines) expect(line).toHaveLength(MARK_COLUMNS);
  });
});

describe("renderBanner", () => {
  it("frames the mark with the welcome text and the version, inside 80 columns", () => {
    const lines = renderBanner({ version: "9.9.9" }).split("\n");

    expect(lines).toHaveLength(MARK_ROWS + 4);
    expect(lines[0]!.startsWith("╭")).toBe(true);
    expect(lines[lines.length - 1]!.startsWith("╰")).toBe(true);
    expect(lines.some((line) => line.includes(WELCOME))).toBe(true);
    expect(lines.some((line) => line.includes(`${WORDMARK} v9.9.9`))).toBe(true);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines[0]!.length).toBe(bannerWidth());
    expect(bannerWidth()).toBeLessThanOrEqual(78);
  });

  it("keeps every framed line the same visible width when coloured", () => {
    const lines = renderBanner({ version: "9.9.9", colorLevel: 3 }).split("\n");

    expect(new Set(lines.map(visibleWidth)).size).toBe(1);
    expect(lines.some((line) => line.includes(`${ESCAPE}[1m${WELCOME}${ESCAPE}[0m`))).toBe(true);
  });

  it("drops the frame and the mark when the terminal is narrower than the frame", () => {
    const narrow = renderBanner({ version: "9.9.9", columns: bannerWidth() - 1 });

    expect(narrow).not.toContain("╭");
    expect(narrow).not.toContain(BLOCK);
    expect(narrow.startsWith(WELCOME)).toBe(true);
    expect(narrow).toContain(`${WORDMARK} v9.9.9`);
    expect(renderBanner({ version: "9.9.9", columns: bannerWidth() })).toContain("╭");
  });
});

describe("detectColorLevel", () => {
  it("disables colour for a redirected stdout, NO_COLOR, or a dumb terminal", () => {
    expect(detectColorLevel({ isTty: false, env: { COLORTERM: "truecolor" } })).toBe(0);
    expect(detectColorLevel({ isTty: true, env: { NO_COLOR: "1", COLORTERM: "truecolor" } })).toBe(
      0,
    );
    expect(detectColorLevel({ isTty: true, env: { TERM: "dumb" } })).toBe(0);
  });

  it("reads the level the terminal advertises", () => {
    const tty = (env: NodeJS.ProcessEnv) => detectColorLevel({ isTty: true, env });

    expect(tty({ TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe(3);
    expect(tty({ TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" })).toBe(3);
    expect(tty({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" })).toBe(2);
    expect(tty({ TERM: "xterm-256color" })).toBe(2);
    expect(tty({ TERM: "xterm" })).toBe(1);
  });

  it("lets FORCE_COLOR override the terminal", () => {
    expect(detectColorLevel({ isTty: false, env: { FORCE_COLOR: "1" } })).toBe(1);
    expect(detectColorLevel({ isTty: false, env: { FORCE_COLOR: "3" } })).toBe(3);
    expect(
      detectColorLevel({ isTty: true, env: { FORCE_COLOR: "0", COLORTERM: "truecolor" } }),
    ).toBe(0);
  });
});
