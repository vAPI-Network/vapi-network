// The vAPI mark is a 743x659 grid of nine rectangles in three rows of equal
// height. The coordinates below are copied from the source artwork so the
// terminal rendering stays in step with the web mark; only the scale is
// terminal-specific.
//
// The banner is printed once, statically, the way create-astro, Vercel and
// Gemini CLI print theirs: no in-place redraws (they break as soon as a line
// wraps), a layout picked from the terminal width, and colour downgraded to
// what the terminal advertises (truecolour, 256 colours, 16 colours, or none).

const MARK_SOURCE_WIDTH = 743;
const MARK_SOURCE_HEIGHT = 659;
const MARK_SOURCE_ROW_HEIGHT = 217;
/** Terminal cells are about twice as tall as wide; 21x9 keeps the 743x659 aspect. */
export const MARK_COLUMNS = 21;
export const MARK_ROWS = 9;
const BLOCK = "█";

export const WORDMARK = "vAPI Network";
export const WELCOME = "Welcome to the vAPI Network";
export const TAGLINE = [
  "The trusted network where agents",
  "and humans do business.",
  "",
  "Search APIs, pay per call, keep",
  "receipts. More coming soon.",
] as const;

// Built from the char code so no raw control character sits in the source.
const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const DEFAULT_FOREGROUND = `${ESC}[39m`;

/** Design-token colours; `ink` renders in the terminal's own foreground colour. */
export const MARK_PALETTE = {
  orange: { hex: "#ff7300", ansi16: 33 },
  pink: { hex: "#ff337c", ansi16: 95 },
  lime: { hex: "#c3ff3d", ansi16: 92 },
  cyan: { hex: "#97efff", ansi16: 96 },
  blue: { hex: "#0041eb", ansi16: 34 },
  purple: { hex: "#8a37fb", ansi16: 35 },
  ink: null,
} as const;

export type MarkColorName = keyof typeof MARK_PALETTE;

export type MarkBlock = {
  row: number;
  x: number;
  width: number;
  color: MarkColorName;
};

export const MARK_BLOCKS: readonly MarkBlock[] = [
  { row: 0, x: 2, width: 90, color: "orange" },
  { row: 0, x: 94, width: 35, color: "pink" },
  { row: 0, x: 131, width: 16, color: "lime" },
  { row: 0, x: 522, width: 219, color: "ink" },
  { row: 1, x: 124, width: 50, color: "cyan" },
  { row: 1, x: 176, width: 24, color: "blue" },
  { row: 1, x: 202, width: 17, color: "purple" },
  { row: 1, x: 402, width: 219, color: "blue" },
  { row: 2, x: 282, width: 219, color: "ink" },
];

/** 0 = no colour, 1 = 16 colours, 2 = 256 colours, 3 = truecolour (the supports-color scale). */
export type ColorLevel = 0 | 1 | 2 | 3;

export type TerminalEnvironment = {
  isTty?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type BannerOptions = {
  version: string;
  /** Defaults to 0 so output stays pipe-safe. */
  colorLevel?: ColorLevel;
  /** Terminal width; below the framed width the banner falls back to plain text. */
  columns?: number;
};

/**
 * Colour capability the way chalk's supports-color decides it: NO_COLOR and
 * a redirected stdout disable colour, FORCE_COLOR overrides, and otherwise
 * the terminal's own advertisement (COLORTERM, TERM, TERM_PROGRAM) picks
 * the level. Apple Terminal advertises 256 colours, not truecolour.
 */
export function detectColorLevel(environment: TerminalEnvironment = {}): ColorLevel {
  const env = environment.env ?? process.env;
  const isTty = environment.isTty ?? Boolean(process.stdout.isTTY);
  if (env.NO_COLOR) return 0;
  const forced = env.FORCE_COLOR;
  if (forced !== undefined) {
    if (forced === "0" || forced === "false") return 0;
    if (forced === "2") return 2;
    if (forced === "3") return 3;
    return 1;
  }
  if (!isTty) return 0;
  const term = env.TERM ?? "";
  const program = env.TERM_PROGRAM ?? "";
  if (term === "dumb") return 0;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return 3;
  if (/kitty|wezterm|ghostty|alacritty/i.test(term)) return 3;
  if (/^(iTerm\.app|vscode|Hyper|WezTerm|ghostty)$/i.test(program)) return 3;
  if (/-256(?:color)?$/i.test(term) || program === "Apple_Terminal") return 2;
  return 1;
}

/** The complete mark: `MARK_ROWS` lines of exactly `MARK_COLUMNS` visible cells. */
export function renderMark(colorLevel: ColorLevel = 0): string {
  const rows: string[] = [];
  for (let row = 0; row < MARK_ROWS; row += 1) {
    const sourceY = (row * MARK_SOURCE_HEIGHT) / MARK_ROWS;
    const band = Math.min(2, Math.floor(sourceY / MARK_SOURCE_ROW_HEIGHT));
    rows.push(
      renderRow(
        MARK_BLOCKS.filter((block) => block.row === band),
        colorLevel,
      ),
    );
  }
  return rows.join("\n");
}

/** Width in columns of the framed banner. */
export function bannerWidth(): number {
  return frameInnerWidth() + 2;
}

/**
 * The welcome banner: the mark on the left, the welcome text on the right,
 * inside a rounded frame. When the terminal is narrower than the frame, the
 * text alone is printed so nothing wraps.
 */
export function renderBanner(options: BannerOptions): string {
  const colorLevel = options.colorLevel ?? 0;
  const columns = options.columns ?? Number.POSITIVE_INFINITY;
  const text = bannerText(options.version, colorLevel);
  if (columns < bannerWidth()) {
    return text.map((line) => line.styled).join("\n");
  }
  const inner = frameInnerWidth();
  const markLines = renderMark(colorLevel).split("\n");
  const lines: string[] = [];
  lines.push(`╭${"─".repeat(inner)}╮`);
  lines.push(`│${" ".repeat(inner)}│`);
  for (let row = 0; row < MARK_ROWS; row += 1) {
    const entry = text[row];
    const value = entry?.value ?? "";
    const styled = entry?.styled ?? "";
    const pad = " ".repeat(TEXT_WIDTH - value.length);
    lines.push(`│  ${markLines[row]}${" ".repeat(GAP)}${styled}${pad}  │`);
  }
  lines.push(`│${" ".repeat(inner)}│`);
  lines.push(`╰${"─".repeat(inner)}╯`);
  return lines.join("\n");
}

const GAP = 3;
const TEXT_WIDTH = Math.max(WELCOME.length, ...TAGLINE.map((line) => line.length));

function frameInnerWidth(): number {
  return 2 + MARK_COLUMNS + GAP + TEXT_WIDTH + 2;
}

function bannerText(
  version: string,
  colorLevel: ColorLevel,
): Array<{ value: string; styled: string }> {
  const style = (value: string, code: string) =>
    colorLevel > 0 && value ? `${code}${value}${RESET}` : value;
  const rows = [
    { value: WELCOME, styled: style(WELCOME, BOLD) },
    { value: "", styled: "" },
    ...TAGLINE.map((line) => ({ value: line, styled: line })),
    { value: "", styled: "" },
    { value: `${WORDMARK} v${version}`, styled: style(`${WORDMARK} v${version}`, DIM) },
  ];
  if (rows.length > MARK_ROWS) throw new Error("banner text is taller than the mark");
  return rows;
}

function renderRow(blocks: readonly MarkBlock[], colorLevel: ColorLevel): string {
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
    const cells = BLOCK.repeat(width);
    line += colorLevel > 0 ? `${foreground(block.color, colorLevel)}${cells}${RESET}` : cells;
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

function foreground(color: MarkColorName, colorLevel: ColorLevel): string {
  const entry = MARK_PALETTE[color];
  if (entry === null) return DEFAULT_FOREGROUND;
  const value = Number.parseInt(entry.hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  if (colorLevel === 3) return `${ESC}[38;2;${red};${green};${blue}m`;
  if (colorLevel === 2) return `${ESC}[38;5;${rgbToAnsi256(red, green, blue)}m`;
  return `${ESC}[${entry.ansi16}m`;
}

/** Nearest xterm 256-colour index, the same cube mapping chalk's ansi-styles uses. */
export function rgbToAnsi256(red: number, green: number, blue: number): number {
  if (red === green && green === blue) {
    if (red < 8) return 16;
    if (red > 248) return 231;
    return Math.round(((red - 8) / 247) * 24) + 232;
  }
  return (
    16 +
    36 * Math.round((red / 255) * 5) +
    6 * Math.round((green / 255) * 5) +
    Math.round((blue / 255) * 5)
  );
}
