import { resolveOmkBrandTheme, resolveTuiMotion, type OmkBrandThemeName, type OmkTuiMotion } from "../../../../brand/theme.js";
import type { TuiView } from "../../../../tui/model.js";
import { clearTerminalScreen } from "../../../../tui/terminal-frame-renderer.js";
import { style } from "../../../../util/theme.js";
import { okSlashResult } from "../result.js";
import type { SlashCommandSpec } from "../types.js";

const VIEWS = new Set<TuiView>(["summary", "dag", "graph", "evidence", "events", "capabilities", "tool-plane"]);
const ANIMATIONS = new Set<OmkTuiMotion>(["off", "low", "auto", "full"]);

export function buildUiSlashCommands(): SlashCommandSpec[] {
  return [
    {
      name: "/clear",
      aliases: ["/cls"],
      group: "ui",
      summary: "Clear screen",
      usage: "/clear",
      examples: ["/clear"],
      handler: (ctx) => {
        clearTerminalScreen((chunk) => (ctx.renderer ? process.stderr : process.stdout).write(chunk));
        return okSlashResult();
      },
    },
    {
      name: "/theme",
      aliases: [":theme"],
      group: "ui",
      summary: "Set session theme",
      usage: "/theme <system24|green-rain|neon-grid|plain|high-contrast>",
      examples: ["/theme green-rain"],
      handler: (_ctx, args) => {
        const requested = args.positional[0];
        const theme = normalizeTheme(requested);
        if (!theme) {
          return okSlashResult({ text: style.phosphorDim("\n  Usage: /theme system24|green-rain|neon-grid|plain|high-contrast\n") });
        }
        return okSlashResult({
          statePatch: { theme },
          text: `${style.phosphor("\n  Theme changed for this session:")} ${style.phosphorDim(resolveOmkBrandTheme(theme).label)}\n`,
        });
      },
    },
    {
      name: "/view",
      aliases: [":view"],
      group: "ui",
      summary: "Set control-plane view",
      usage: "/view <summary|graph|evidence|tool-plane|events>",
      examples: ["/view graph", "/view evidence"],
      handler: (ctx, args) => {
        const view = normalizeView(args.positional[0]);
        if (!view) {
          return okSlashResult({ text: style.phosphorDim("\n  Usage: /view summary|graph|dag|evidence|tool-plane|events|capabilities\n") });
        }
        ctx.env.OMK_TUI_VIEW = view;
        return okSlashResult({
          statePatch: { view },
          text: `${style.phosphor("\n  Control-plane view changed:")} ${style.phosphorDim(view)}\n`,
        });
      },
    },
    {
      name: "/animation",
      aliases: ["/motion"],
      group: "ui",
      summary: "Set animation policy",
      usage: "/animation <off|low|auto|full>",
      examples: ["/animation low"],
      handler: (ctx, args) => {
        const animation = normalizeAnimation(args.positional[0]);
        if (!animation) {
          return okSlashResult({ text: style.phosphorDim("\n  Usage: /animation off|low|auto|full\n") });
        }
        ctx.env.OMK_ANIMATION = animation;
        return okSlashResult({
          statePatch: { animation },
          text: `${style.phosphor("\n  Animation policy changed:")} ${style.phosphorDim(resolveTuiMotion({ OMK_ANIMATION: animation }))}\n`,
        });
      },
    },
  ];
}

function normalizeTheme(value: string | undefined): OmkBrandThemeName | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "green" || normalized === "rain") return "green-rain";
  if (normalized === "neon" || normalized === "grid" || normalized === "control" || normalized === "omk-control") return "neon-grid";
  if (normalized === "system24" || normalized === "green-rain" || normalized === "neon-grid" || normalized === "plain" || normalized === "high-contrast") {
    return normalized;
  }
  return undefined;
}

function normalizeView(value: string | undefined): TuiView | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "toolplane" || normalized === "tools") return "tool-plane";
  if (VIEWS.has(normalized as TuiView)) return normalized as TuiView;
  return undefined;
}

function normalizeAnimation(value: string | undefined): OmkTuiMotion | undefined {
  const normalized = value?.trim().toLowerCase();
  if (ANIMATIONS.has(normalized as OmkTuiMotion)) return normalized as OmkTuiMotion;
  return undefined;
}
