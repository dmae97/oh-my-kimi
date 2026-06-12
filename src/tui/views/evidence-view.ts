import type { TuiFrame, TuiSnapshot } from "../model.js";
import { frame, nodeStatusSymbol, nodes, type TuiViewRenderOptions } from "./common.js";

export function renderEvidenceView(snapshot: TuiSnapshot, options: TuiViewRenderOptions = {}): TuiFrame {
  const lines: string[] = [];
  for (const node of nodes(snapshot)) {
    for (const output of node.outputs ?? []) {
      lines.push(`${nodeStatusSymbol(node.status)} ${node.id} output:${output.gate ?? "none"} ${output.name}${output.ref ? ` -> ${output.ref}` : ""}`);
    }
    for (const evidence of node.evidence ?? []) {
      const marker = evidence.passed ? "✓" : "✕";
      const msg = evidence.message ? ` ${evidence.message}` : "";
      lines.push(`${marker} ${node.id} gate:${evidence.gate}${evidence.ref ? ` ${evidence.ref}` : ""}${msg}`);
    }
    if (node.routing?.evidenceRequired && !node.evidence?.length && !node.outputs?.length) {
      lines.push(`□ ${node.id} evidence required`);
    }
  }
  return frame("evidence", lines.length > 0 ? lines : ["□ no evidence gates recorded"], options, "Evidence or it did not happen.");
}
