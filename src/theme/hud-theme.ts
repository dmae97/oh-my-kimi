/**
 * OMK Theme — HudTheme contract implementation
 * Bridges theme modules to the HudTheme interface used by render.ts
 */

import type { HudTheme } from "../hud/types.js";
import { style } from "./colors.js";
import { status } from "./colors.js";
import { panel, gauge, stat, matrixHeader, gradient, separator } from "./layout.js";
import { padEndAnsi, sanitizeTerminalText } from "./ansi.js";
import { getSystemUsage } from "./metrics.js";

export const hudTheme: HudTheme = {
  style: {
    blue: style.blue,
    cream: style.cream,
    creamBold: style.creamBold,
    gray: style.gray,
    mint: style.mint,
    mintBold: style.mintBold,
    orange: style.orange,
    orangeBold: style.orangeBold,
    phosphor: style.phosphor,
    pinkBold: style.pinkBold,
    purple: style.purple,
    purpleBold: style.purpleBold,
    red: style.red,
    redBold: style.redBold,
  },
  status: {
    ok: status.ok,
    warn: status.warn,
    info: status.info,
  },
  panel,
  gauge,
  stat,
  matrixHeader,
  gradient,
  separator,
  padEndAnsi,
  sanitizeTerminalText,
  getSystemUsage,
};
