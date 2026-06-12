import type { TuiFrame, TuiSnapshot } from "../model.js";
import { frame, list, nodes, type TuiViewRenderOptions } from "./common.js";

export function renderCapabilitiesView(snapshot: TuiSnapshot, options: TuiViewRenderOptions = {}): TuiFrame {
  const lines = nodes(snapshot).map((node) => {
    const routing = node.routing;
    const assigned = routing?.assignedCapabilities;
    const mcp = routing?.mcpServers ?? assigned?.mcpServers;
    const skills = routing?.skills ?? assigned?.skills;
    const hooks = routing?.hooks ?? assigned?.hooks;
    const tools = routing?.tools ?? assigned?.tools;
    return `${node.id} mcp=[${list(mcp)}] skills=[${list(skills, "none", 2)}] hooks=[${list(hooks)}] tools=[${list(tools)}]`;
  });
  return frame("tool plane", lines.length > 0 ? lines : ["□ no tool-plane capabilities assigned"], options, `updated ${snapshot.updatedAt}`);
}
