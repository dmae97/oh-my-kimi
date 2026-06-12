/**
 * OMK Theme — Brand color style builders & semantic status helpers
 * Extracted from util/theme.ts to break God Module coupling
 */

import { P } from "../brand/palette.js";
import { esc, rgb, bgRgb } from "./ansi.js";

export const glyph = {
  routed: "◇",
  blocked: "◆",
  active: "●",
  queued: "○",
  verified: "✓",
  failed: "✕",
  evidence: "▣",
  signal: "⟡",
  warning: "⟁",
} as const;

export const style = {
  reset: esc("0"),
  bold: esc("1"),
  dim: esc("2"),
  italic: esc("3"),
  underline: esc("4"),

  // Brand colors
  purple: (s: string) => esc(rgb(P.purple.r, P.purple.g, P.purple.b)) + s + esc("0"),
  lightPurple: (s: string) => esc(rgb(P.lightPurple.r, P.lightPurple.g, P.lightPurple.b)) + s + esc("0"),
  darkPurple: (s: string) => esc(rgb(P.darkPurple.r, P.darkPurple.g, P.darkPurple.b)) + s + esc("0"),
  pink: (s: string) => esc(rgb(P.pink.r, P.pink.g, P.pink.b)) + s + esc("0"),
  hotPink: (s: string) => esc(rgb(P.hotPink.r, P.hotPink.g, P.hotPink.b)) + s + esc("0"),
  mint: (s: string) => esc(rgb(P.mint.r, P.mint.g, P.mint.b)) + s + esc("0"),
  darkMint: (s: string) => esc(rgb(P.darkMint.r, P.darkMint.g, P.darkMint.b)) + s + esc("0"),
  orange: (s: string) => esc(rgb(P.orange.r, P.orange.g, P.orange.b)) + s + esc("0"),
  red: (s: string) => esc(rgb(P.red.r, P.red.g, P.red.b)) + s + esc("0"),
  blue: (s: string) => esc(rgb(P.blue.r, P.blue.g, P.blue.b)) + s + esc("0"),
  cream: (s: string) => esc(rgb(P.cream.r, P.cream.g, P.cream.b)) + s + esc("0"),
  gray: (s: string) => esc(rgb(P.gray.r, P.gray.g, P.gray.b)) + s + esc("0"),
  skin: (s: string) => esc(rgb(P.skin.r, P.skin.g, P.skin.b)) + s + esc("0"),
  matrixGreen: (s: string) => esc(rgb(P.matrixGreen.r, P.matrixGreen.g, P.matrixGreen.b)) + s + esc("0"),
  matrixDark: (s: string) => esc(rgb(P.matrixDark.r, P.matrixDark.g, P.matrixDark.b)) + s + esc("0"),

  // Combos
  purpleBold: (s: string) => esc("1;" + rgb(P.purple.r, P.purple.g, P.purple.b)) + s + esc("0"),
  pinkBold: (s: string) => esc("1;" + rgb(P.pink.r, P.pink.g, P.pink.b)) + s + esc("0"),
  mintBold: (s: string) => esc("1;" + rgb(P.mint.r, P.mint.g, P.mint.b)) + s + esc("0"),
  blueBold: (s: string) => esc("1;" + rgb(P.blue.r, P.blue.g, P.blue.b)) + s + esc("0"),
  creamBold: (s: string) => esc("1;" + rgb(P.cream.r, P.cream.g, P.cream.b)) + s + esc("0"),

  // Backgrounds
  bgPurple: (s: string) => esc(bgRgb(P.purple.r, P.purple.g, P.purple.b) + ";" + rgb(255, 255, 255)) + s + esc("0"),
  bgPink: (s: string) => esc(bgRgb(P.pink.r, P.pink.g, P.pink.b) + ";" + rgb(255, 255, 255)) + s + esc("0"),
  bgDark: (s: string) => esc(bgRgb(P.dark.r, P.dark.g, P.dark.b) + ";" + rgb(P.cream.r, P.cream.g, P.cream.b)) + s + esc("0"),

  // Parallel UI extras
  orangeBold: (s: string) => esc("1;" + rgb(P.orange.r, P.orange.g, P.orange.b)) + s + esc("0"),
  redBold: (s: string) => esc("1;" + rgb(P.red.r, P.red.g, P.red.b)) + s + esc("0"),

  // Matrix theme
  phosphor: (s: string) => esc(rgb(P.matrixGreen.r, P.matrixGreen.g, P.matrixGreen.b)) + s + esc("0"),
  phosphorBold: (s: string) => esc("1;" + rgb(P.matrixGreen.r, P.matrixGreen.g, P.matrixGreen.b)) + s + esc("0"),
  phosphorDim: (s: string) => esc("2;" + rgb(P.matrixGreen.r, P.matrixGreen.g, P.matrixGreen.b)) + s + esc("0"),
  matrixBlack: (s: string) => esc(rgb(0, 0, 0)) + s + esc("0"),
  bgMatrix: (s: string) => esc(bgRgb(0, 8, 0) + ";" + rgb(P.matrixGreen.r, P.matrixGreen.g, P.matrixGreen.b)) + s + esc("0"),

  // Metrics
  cyan: (s: string) => esc(rgb(P.metricsCyan.r, P.metricsCyan.g, P.metricsCyan.b)) + s + esc("0"),
  cyanBold: (s: string) => esc("1;" + rgb(P.metricsCyan.r, P.metricsCyan.g, P.metricsCyan.b)) + s + esc("0"),
  navy: (s: string) => esc(rgb(P.metricsNavy.r, P.metricsNavy.g, P.metricsNavy.b)) + s + esc("0"),
  slate: (s: string) => esc(rgb(P.metricsSlate.r, P.metricsSlate.g, P.metricsSlate.b)) + s + esc("0"),
  silver: (s: string) => esc(rgb(P.metricsSilver.r, P.metricsSilver.g, P.metricsSilver.b)) + s + esc("0"),
  white: (s: string) => esc(rgb(P.metricsWhite.r, P.metricsWhite.g, P.metricsWhite.b)) + s + esc("0"),
  whiteBold: (s: string) => esc("1;" + rgb(P.metricsWhite.r, P.metricsWhite.g, P.metricsWhite.b)) + s + esc("0"),
  amber: (s: string) => esc(rgb(P.metricsAmber.r, P.metricsAmber.g, P.metricsAmber.b)) + s + esc("0"),
  green: (s: string) => esc(rgb(P.metricsGreen.r, P.metricsGreen.g, P.metricsGreen.b)) + s + esc("0"),
  greenBold: (s: string) => esc("1;" + rgb(P.metricsGreen.r, P.metricsGreen.g, P.metricsGreen.b)) + s + esc("0"),
  metricsRed: (s: string) => esc(rgb(P.metricsRed.r, P.metricsRed.g, P.metricsRed.b)) + s + esc("0"),
  metricsBlue: (s: string) => esc(rgb(P.metricsBlue.r, P.metricsBlue.g, P.metricsBlue.b)) + s + esc("0"),
  violet: (s: string) => esc(rgb(P.metricsViolet.r, P.metricsViolet.g, P.metricsViolet.b)) + s + esc("0"),

  bgNavy: (s: string) => esc(bgRgb(P.metricsNavy.r, P.metricsNavy.g, P.metricsNavy.b) + ";" + rgb(P.metricsWhite.r, P.metricsWhite.g, P.metricsWhite.b)) + s + esc("0"),
  bgSlate: (s: string) => esc(bgRgb(P.metricsSlate.r, P.metricsSlate.g, P.metricsSlate.b) + ";" + rgb(P.metricsSilver.r, P.metricsSilver.g, P.metricsSilver.b)) + s + esc("0"),

  amberBold: (s: string) => esc("1;" + rgb(P.metricsAmber.r, P.metricsAmber.g, P.metricsAmber.b)) + s + esc("0"),
  metricsRedBold: (s: string) => esc("1;" + rgb(P.metricsRed.r, P.metricsRed.g, P.metricsRed.b)) + s + esc("0"),
};

export const status = {
  ok: (s: string) => style.mintBold(`${glyph.verified} ${s}`),
  warn: (s: string) => style.orange(`${glyph.warning} ${s}`),
  fail: (s: string) => style.red(`${glyph.failed} ${s}`),
  info: (s: string) => style.purple(`${glyph.signal} ${s}`),
  success: (s: string) => style.mint(`${glyph.verified} ${s}`),
  error: (s: string) => style.red(`${glyph.failed} ${s}`),
};
