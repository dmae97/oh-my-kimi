import type { TuiFrame, TuiSnapshot } from "../model.js";
import { frame, list, nodeStatusSymbol, nodes, type TuiViewRenderOptions } from "./common.js";

export function renderDagView(snapshot: TuiSnapshot, options: TuiViewRenderOptions = {}): TuiFrame {
  const dagNodes = nodes(snapshot);
  const lines = dagNodes.map((node) => {
    const deps = node.dependsOn.length > 0 ? ` deps=${list(node.dependsOn, "", 2)}` : "";
    const provider = node.routing?.assignedProvider ?? node.routing?.provider ?? "auto";
    const model = node.routing?.assignedModel ?? node.routing?.providerModel;
    const route = model ? `${provider}/${model}` : provider;
    return `${nodeStatusSymbol(node.status)} ${node.id} ${node.role} ${node.name} route=${route}${deps}`;
  });
  return frame("graph", lines.length > 0 ? lines : ["□ no DAG nodes"], options, `run#${snapshot.runId}`);
}
