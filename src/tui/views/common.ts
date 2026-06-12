import type { DagNode, TaskStatus } from "../../contracts/dag.js";
import type { TuiFrame, TuiSnapshot } from "../model.js";

export interface TuiViewRenderOptions {
  width?: number;
  height?: number;
}

export function frame(title: string, lines: string[], options: TuiViewRenderOptions = {}, footer?: string): TuiFrame {
  const width = Math.max(40, options.width ?? 80);
  const height = options.height;
  const body = height && height > 0 ? lines.slice(0, Math.max(0, height - (footer ? 1 : 0))) : lines;
  return { title, lines: body.map((line) => truncate(line, width)), footer, width, height };
}

export function truncate(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
}

export function list(values: readonly string[] | undefined, empty = "none", max = 3): string {
  if (!values || values.length === 0) return empty;
  const shown = values.slice(0, max);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, +${rest}` : shown.join(", ");
}

export function nodeStatusSymbol(status: TaskStatus): string {
  switch (status) {
    case "done":
      return "✓";
    case "running":
      return "▶";
    case "failed":
      return "✕";
    case "blocked":
      return "!";
    case "skipped":
      return "-";
    case "pending":
      return "□";
  }
}

export function nodes(snapshot: TuiSnapshot): DagNode[] {
  return snapshot.state?.nodes ?? [];
}
