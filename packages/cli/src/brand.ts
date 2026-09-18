// The vAPI mark is a 743x659 grid of nine rectangles in three rows of equal
// height. The coordinates below are copied from the source artwork so the
// terminal rendering stays in step with the web mark; only the horizontal scale
// is terminal-specific.

const MARK_SOURCE_WIDTH = 743;
const MARK_COLUMNS = 34;
const MARK_ROWS = 3;
const BLOCK = "█";

export const MARK_STEP_MS = 70;
export const WORDMARK = "vAPI Network";

const RESET = "\u001b[0m";
const DEFAULT_FOREGROUND = "\u001b[39m";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";

/** `ink` renders in the terminal's default foreground, like the black mark on paper. */
export const MARK_PALETTE = {
  orange: "#FF6A1A",
  pink: "#FF3D8B",
  lime: "#B8F32D",
  cyan: "#22D3EE",
  blue: "#0052FF",
  purple: "#8B5CF6",
  ink: null,
} as const;

export type MarkColorName = keyof typeof MARK_PALETTE;

export type MarkBlock = {
  row: number;
  x: number;
  width: number;
  color: MarkColorName;
  /** Reveal step; blocks that share a delay appear in the same frame. */
  delay: number;
};

export const MARK_BLOCKS: readonly MarkBlock[] = [
  { row: 0, x: 2, width: 90, color: "orange", delay: 0 },
  { row: 0, x: 94, width: 35, color: "pink", delay: 1 },
  { row: 0, x: 131, width: 16, color: "lime", delay: 2 },
  { row: 0, x: 522, width: 219, color: "ink", delay: 1 },
  { row: 1, x: 124, width: 50, color: "cyan", delay: 3 },
  { row: 1, x: 176, width: 24, color: "blue", delay: 4 },
  { row: 1, x: 202, width: 17, color: "purple", delay: 5 },
  { row: 1, x: 402, width: 219, color: "blue", delay: 4 },
  { row: 2, x: 282, width: 219, color: "ink", delay: 7 },
];

export type MarkRenderOptions = {
  /** Emit 24-bit ANSI colour. Defaults to false so output stays pipe-safe. */
  color?: boolean;
};

export type BannerOptions = MarkRenderOptions & {
  version: string;
};

export type AnimateBannerOptions = BannerOptions & {
  write(chunk: string): void;
  stepMs?: number;
  sleep?(milliseconds: number): Promise<void>;
};

export type AnimationEnvironment = {
  isTty?: boolean;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
};

/** Colour is off whenever `NO_COLOR` is set or stdout is not a terminal. */
export function markColorEnabled(environment: AnimationEnvironment = {}): boolean {
  const env = environment.env ?? process.env;
  const isTty = environment.isTty ?? Boolean(process.stdout.isTTY);
  return isTty && !env.NO_COLOR;
}

/** Animate only in an interactive, colour-capable, human-facing terminal. */
export function shouldAnimateMark(environment: AnimationEnvironment = {}): boolean {
  const env = environment.env ?? process.env;
  if (environment.json) return false;
  if (env.NO_COLOR || env.CI) return false;
  return markColorEnabled(environment);
}

/**
 * Every reveal step of the mark, oldest first. Pure: the last frame is the
 * complete mark and each frame is exactly `MARK_ROWS` lines.
 */
export function renderMarkFrames(options: MarkRenderOptions = {}): string[] {
  const steps = [...new Set(MARK_BLOCKS.map((block) => block.delay))].sort(
    (left, right) => left - right,
  );
  return steps.map((step) =>
    renderFrame(
      MARK_BLOCKS.filter((block) => block.delay <= step),
      options.color === true,
    ),
  );
}

/** The complete mark with the wordmark and version beneath it. */
export function renderBanner(options: BannerOptions): string {
  const frames = renderMarkFrames(options);
  return [frames[frames.length - 1]!, WORDMARK, `v${options.version}`].join("\n");
}

/** Reveal the mark in place, then print the wordmark and version. */
export async function animateBanner(options: AnimateBannerOptions): Promise<void> {
  const frames = renderMarkFrames({ color: options.color !== false });
  const sleep = options.sleep ?? defaultSleep;
  const stepMs = options.stepMs ?? MARK_STEP_MS;
  options.write(HIDE_CURSOR);
  try {
    for (const [index, frame] of frames.entries()) {
      if (index > 0) options.write(`\u001b[${MARK_ROWS}A`);
      options.write(
        frame
          .split("\n")
          .map((line) => `\r\u001b[2K${line}\n`)
          .join(""),
      );
      if (index < frames.length - 1) await sleep(stepMs);
    }
  } finally {
    options.write(SHOW_CURSOR);
  }
  options.write(`${WORDMARK}\n`);
  options.write(`v${options.version}\n`);
}

function renderFrame(blocks: readonly MarkBlock[], color: boolean): string {
  const rows: string[] = [];
  for (let row = 0; row < MARK_ROWS; row += 1) {
    rows.push(
      renderRow(
        blocks.filter((block) => block.row === row),
        color,
      ),
    );
  }
  return rows.join("\n");
}

function renderRow(blocks: readonly MarkBlock[], color: boolean): string {
  const ordered = [...blocks].sort((left, right) => left.x - right.x);
  let column = 0;
  let line = "";
  for (const block of ordered) {
    const start = Math.max(column, scaleColumn(block.x));
    if (start > column) {
      line += " ".repeat(start - column);
      column = start;
    }
    const width = scaleWidth(block.width);
    const glyphs = BLOCK.repeat(width);
    line += color ? `${ansiPrefix(block.color)}${glyphs}${RESET}` : glyphs;
    column += width;
  }
  return line;
}

function scaleColumn(x: number): number {
  return Math.round((x * MARK_COLUMNS) / MARK_SOURCE_WIDTH);
}

function scaleWidth(width: number): number {
  return Math.max(1, Math.round((width * MARK_COLUMNS) / MARK_SOURCE_WIDTH));
}

function ansiPrefix(color: MarkColorName): string {
  const hex = MARK_PALETTE[color];
  if (hex === null) return DEFAULT_FOREGROUND;
  const value = Number.parseInt(hex.slice(1), 16);
  return `\u001b[38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}m`;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
