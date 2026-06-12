/**
 * OutputRouter — routes OmkEvent to the appropriate renderer based on OutputProfile.stdoutMode.
 *
 * Invariant I-004: provider stdout MUST NOT bypass the router.
 * Raw provider stdout is never emitted directly; all output flows through a Renderer.
 */

import type { OmkEvent, OutputProfile, StdoutMode } from "./contracts/command-envelope.js";
import type {
  ThemeRenderer,
  NlpRenderer,
  JsonRenderer,
} from "./renderers.js";
import {
  createThemeRenderer,
  createNlpRenderer,
  createJsonRenderer,
} from "./renderers.js";
import type { ThemePalette } from "../cli/theme/theme-registry.js";
import { getBuiltinTheme } from "../cli/theme/theme-registry.js";
import { resolveTheme } from "../cli/theme/theme-resolver.js";
import type { NlgRenderer } from "./nlg-renderer.js";
import { createNlgRenderer } from "./nlg-renderer.js";
import type { ReasoningTrace } from "./contracts/reasoning-trace.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Renderer = ThemeRenderer | NlpRenderer | JsonRenderer;

export interface OutputRouter {
  route(event: OmkEvent): void;
  /** Route a reasoning trace through the NLG renderer */
  routeTrace(trace: ReasoningTrace): void;
  /** Render opencode-style status bar at bottom */
  renderStatusBar(provider: string, model: string, intent: string): void;
  flush(): void;
  getRenderer(): Renderer;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class OutputRouterImpl implements OutputRouter {
  private readonly renderer: Renderer;
  private readonly stdoutMode: StdoutMode;
  private readonly themeRenderer: ThemeRenderer | undefined;
  private readonly nlpRenderer: NlpRenderer | undefined;
  private readonly jsonRenderer: JsonRenderer | undefined;
  private readonly nlgRenderer: NlgRenderer | undefined;

  constructor(profile: OutputProfile) {
    this.stdoutMode = profile.stdoutMode;

    // Resolve ThemePalette from the theme system (flag → env → config → terminal)
    const palette: ThemePalette | undefined = (() => {
      try {
        const resolved = resolveTheme({ cwd: process.cwd() });
        return getBuiltinTheme(resolved.name);
      } catch {
        return undefined;
      }
    })();

    // Initialize NLG renderer with the resolved palette
    this.nlgRenderer = createNlgRenderer({ palette, write: process.stdout.write.bind(process.stdout) });

    switch (profile.stdoutMode) {
      case "theme":
      case "human": {
        const useColor = profile.color === "always" || (profile.color === "auto" && process.stdout.isTTY === true);
        const r = createThemeRenderer(
          useColor
            ? process.stdout.write.bind(process.stdout)
            : stripColorWriter,
          useColor ? palette : undefined,
        );
        this.themeRenderer = r;
        this.renderer = r;
        break;
      }
      case "nlp": {
        const r = createNlpRenderer();
        this.nlpRenderer = r;
        this.renderer = r;
        break;
      }
      case "json":
      case "machine": {
        const r = createJsonRenderer();
        this.jsonRenderer = r;
        this.renderer = r;
        break;
      }
      case "raw": {
        // "raw" is an escape hatch that still routes through the NLP renderer
        // to enforce I-004: provider stdout never bypasses the router.
        const r = createNlpRenderer();
        this.nlpRenderer = r;
        this.renderer = r;
        break;
      }
      default: {
        const _exhaustive: never = profile.stdoutMode;
        void _exhaustive;
        const r = createNlpRenderer();
        this.nlpRenderer = r;
        this.renderer = r;
      }
    }
  }

  route(event: OmkEvent): void {
    if (this.themeRenderer) {
      routeToTheme(this.themeRenderer, event);
    } else if (this.nlpRenderer) {
      this.nlpRenderer.render(event);
    } else if (this.jsonRenderer) {
      this.jsonRenderer.render(event);
    }
  }

  routeTrace(trace: ReasoningTrace): void {
    if (this.nlgRenderer) {
      this.nlgRenderer.renderTurnResult(trace);
    } else if (this.themeRenderer) {
      // Fallback: use trace summary as progress
      const summary = trace.result.summary;
      this.themeRenderer.renderProgress(summary);
    } else if (this.jsonRenderer) {
      this.jsonRenderer.render({
        type: "result",
        timestamp: new Date().toISOString(),
        data: { kind: "result", content: JSON.stringify(trace), format: "json" },
      });
    }
  }

  renderStatusBar(provider: string, model: string, intent: string): void {
    if (this.themeRenderer) {
      this.themeRenderer.renderStatusBar(provider, model, intent);
    }
  }

  flush(): void {
    if (this.themeRenderer) {
      this.themeRenderer.flush();
    } else if (this.nlpRenderer) {
      const text = this.nlpRenderer.flush();
      if (text.length > 0) {
        process.stdout.write(text + "\n");
      }
    } else if (this.jsonRenderer) {
      const records = this.jsonRenderer.flush();
      if (records.length > 0) {
        process.stdout.write(JSON.stringify(records, null, 2) + "\n");
      }
    }
  }

  getRenderer(): Renderer {
    return this.renderer;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createOutputRouter(profile: OutputProfile): OutputRouter {
  return new OutputRouterImpl(profile);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Route an OmkEvent to the ThemeRenderer's typed methods.
 */
function routeToTheme(renderer: ThemeRenderer, event: OmkEvent): void {
  if (!event.data) {
    return;
  }
  switch (event.data.kind) {
    case "turn_started":
      renderer.renderTurnStarted(event.data.intent, event.data.provider);
      break;
    case "progress":
      renderer.renderProgress(event.data.message, event.data.percent);
      break;
    case "mcp_status":
      renderer.renderMcpStatus(event.data.server, event.data.status);
      break;
    case "warning":
      renderer.renderWarning(event.data.message);
      break;
    case "result":
      renderer.renderResult(event.data.content);
      break;
    case "error":
      renderer.renderError(event.data.message, event.data.recoverable);
      break;
    case "turn_finished":
      renderer.renderTurnFinished(event.data.durationMs);
      break;
  }
}

/**
 * Writer that strips ANSI escape codes — used when profile.color is false.
 */
function stripColorWriter(text: string): boolean {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  process.stdout.write(stripped);
  return true;
}
