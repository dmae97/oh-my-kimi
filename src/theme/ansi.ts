/**
 * OMK Theme — ANSI escape utilities & text sanitization
 * Extracted from util/theme.ts to break God Module coupling
 */

export const colorEnabled = process.env.FORCE_COLOR === "1"
  || process.env.FORCE_COLOR === "true"
  || (
    process.env.NO_COLOR === undefined
    && process.env.TERM !== "dumb"
    && Boolean(process.stdout.isTTY)
  );

export const esc = (codes: string) => colorEnabled ? `\x1b[${codes}m` : "";
export const rgb = (r: number, g: number, b: number) => `38;2;${r};${g};${b}`;
export const bgRgb = (r: number, g: number, b: number) => `48;2;${r};${g};${b}`;

export function stripBrokenAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\[[0-9;]{1,64}m/g, "")
    .replace(/\[0m/g, "");
}

export function sanitizeTerminalText(value: string): string {
  return stripBrokenAnsi(value
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[P^_][\s\S]*?\x1B\\/g, ""))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/^::code-comment\{.*?\}[ \t]*\r?\n?/gm, "");
}

export function visibleTerminalWidth(text: string): number {
  return sanitizeTerminalText(text).length;
}

export function stripAnsi(str: string): string {
  return sanitizeTerminalText(str);
}

export function padEndAnsi(str: string, len: number): string {
  return str + " ".repeat(Math.max(0, len - stripAnsi(str).length));
}
