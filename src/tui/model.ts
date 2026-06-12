import type { RunState } from "../contracts/orchestration.js";

export type TuiRenderMode = "diff" | "full" | "append";

export type TuiView = "summary" | "dag" | "graph" | "evidence" | "events" | "capabilities" | "tool-plane";

export interface TuiFrame {
  title: string;
  lines: string[];
  footer?: string;
  width: number;
  height?: number;
}

export interface TuiAction {
  type:
    | "quit"
    | "pause"
    | "refresh"
    | "toggle-history"
    | "cycle-render-mode"
    | "increase-height"
    | "decrease-height"
    | "select-view";
  view?: TuiView;
}

export interface TuiSnapshot {
  runId: string;
  state: RunState | null;
  todos: unknown[];
  events: unknown[];
  updatedAt: string;
}

export interface TuiViewRenderer {
  view: TuiView;
  render(snapshot: TuiSnapshot, options?: { width?: number; height?: number }): TuiFrame;
}
