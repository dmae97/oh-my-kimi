/**
 * OMK Routing — Shared types for routing submodules
 */

export type RouteKind = "skill" | "mcp" | "tool" | "hook";
export type RouteSource = "project" | "global" | "builtin";
export type WriteRisk = "none" | "low" | "high";

export interface RouteCandidate {
  kind: RouteKind;
  id: string;
  source: RouteSource;
  roles: string[];
  keywords: string[];
  readOnly: boolean;
  writeRisk: WriteRisk;
  contextCost: 1 | 2 | 3;
  capabilities: string[];
}

export interface ScoredRoute {
  candidate: RouteCandidate;
  score: number;
  reason: string;
}

export interface RoutingDiagnostic {
  kind: "mcp-config";
  source: "project" | "global";
  path: string;
  message: string;
}

export interface RoutingInventory {
  skills: Map<string, RouteSource>;
  mcpServers: Map<string, RouteSource>;
  hooks: Map<string, RouteSource>;
  tools: Set<string>;
  diagnostics: RoutingDiagnostic[];
  skillsScope: "project" | "all" | "none";
  mcpScope: "project" | "all" | "none";
  hooksScope: "project" | "all" | "none";
}
