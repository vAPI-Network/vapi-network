// The vAPI mark is a 743x659 grid of nine rectangles in three rows of equal
// height. The coordinates below are copied from the source artwork so the
// terminal rendering stays in step with the web mark; only the scale is
// terminal-specific. Blocks are drawn as solid cells (background colour, or
// reverse video for `ink`), so the mark reads as rectangles rather than glyphs.

const MARK_SOURCE_WIDTH = 743;
const MARK_SOURCE_HEIGHT = 659;
const MARK_SOURCE_ROW_HEIGHT = 217;
/** Terminal cells are about twice as tall as wide; 28x12 keeps the 743x659 aspect. */
const MARK_COLUMNS = 28;
const MARK_ROWS = 12;
const PLAIN_BLOCK = "█";

export const MARK_STEP_MS = 70;
export const WORDMARK = "vAPI Network";
export const WELCOME = "Welcome to the vAPI Network";
export const TAGLINE = [
  "The trusted network where agents and humans do business.",
  "Search APIs, pay per call, keep receipts. More coming soon.",
] as const;

const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const REVERSE = `${ESC}[7m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

/** Design-token colours; `ink` renders in the terminal's foreground, like the black mark on paper. */
export const MARK_PALETTE = {
  orange: "#ff7300",
  pink: "#ff337c",
  lime: "#c3ff3d",
  cyan: "#97efff",
  blue: "#0041eb",
  purple: "#8a37fb",
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
  /** Emit ANSI colour. Defaults to false so output stays pipe-safe. */
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
 * complete mark and each frame is exactly `MARK_ROWS` lines of `MARK_COLUMNS`
 * visible cells.
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

/** The framed welcome banner: the mark on the left, the welcome text on the right. */
export function renderBanner(options: BannerOptions): string {
  const frames = renderMarkFrames(options);
  return renderBox(frames[frames.length - 1]!, options).join("\n");
}

/** Reveal the mark in place inside the frame, then leave the finished banner on screen. */
export async function animateBanner(options: AnimateBannerOptions): Promise<void> {
  const frames = renderMarkFrames({ color: options.color !== false });
  const sleep = options.sleep ?? defaultSleep;
  const stepMs = options.stepMs ?? MARK_STEP_MS;
  const boxes = frames.map((frame) => renderBox(frame, options));
  const height = boxes[0]!.length;
  options.write(HIDE_CURSOR);
  try {
    for (const [index, box] of boxes.entries()) {
      if (index > 0) options.write(`${ESC}[${height}A`);
      options.write(box.map((line) => `\r${ESC}[2K${line}\n`).join(""));
      if (index < boxes.length - 1) await sleep(stepMs);
    }
  } finally {
    options.write(SHOW_CURSOR);
  }
}

function renderBox(frame: string, options: BannerOptions): string[] {
  const color = options.color === true;
  const text: Array<{ value: string; style: string }> = [
    { value: WELCOME, style: BOLD },
    { value: "", style: "" },
    ...TAGLINE.map((line) => ({ value: line, style: "" })),
    { value: "", style: "" },
    { value: `${WORDMARK} v${options.version}`, style: DIM },
  ];
  const textWidth = Math.max(...text.map((line) => line.value.length));
  const gap = 3;
  const inner = 2 + MARK_COLUMNS + gap + textWidth + 2;
  const markLines = frame.split("\n");
  const textTop = Math.floor((MARK_ROWS - text.length) / 2);
  const lines: string[] = [];
  lines.push(`╭${"─".repeat(inner)}╮`);
  lines.push(`│${" ".repeat(inner)}│`);
  for (let row = 0; row < MARK_ROWS; row += 1) {
    const mark = markLines[row] ?? "";
    const markPad = " ".repeat(Math.max(0, MARK_COLUMNS - visibleLength(mark)));
    const entry = text[row - textTop];
    const raw = entry?.value ?? "";
    const styled = color && entry && entry.style && raw ? `${entry.style}${raw}${RESET}` : raw;
    const textPad = " ".repeat(textWidth - raw.length);
    lines.push(`│  ${mark}${markPad}${" ".repeat(gap)}${styled}${textPad}  │`);
  }
  lines.push(`│${" ".repeat(inner)}│`);
  lines.push(`╰${"─".repeat(inner)}╯`);
  return lines;
}

function renderFrame(blocks: readonly MarkBlock[], color: boolean): string {
  const rows: string[] = [];
  for (let row = 0; row < MARK_ROWS; row += 1) {
    const sourceY = (row * MARK_SOURCE_HEIGHT) / MARK_ROWS;
    const band = Math.min(2, Math.floor(sourceY / MARK_SOURCE_ROW_HEIGHT));
    rows.push(
      renderRow(
        blocks.filter((block) => block.row === band),
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
    line += color
      ? `${cellPrefix(block.color)}${" ".repeat(width)}${RESET}`
      : PLAIN_BLOCK.repeat(width);
    column += width;
  }
  return line + " ".repeat(Math.max(0, MARK_COLUMNS - column));
}

function scaleColumn(x: number): number {
  return Math.round((x * MARK_COLUMNS) / MARK_SOURCE_WIDTH);
}

function scaleWidth(width: number): number {
  return Math.max(1, Math.round((width * MARK_COLUMNS) / MARK_SOURCE_WIDTH));
}

function cellPrefix(color: MarkColorName): string {
  const hex = MARK_PALETTE[color];
  if (hex === null) return REVERSE;
  const value = Number.parseInt(hex.slice(1), 16);
  return `${ESC}[48;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}m`;
}

function visibleLength(line: string): number {
  return line.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "").length;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
