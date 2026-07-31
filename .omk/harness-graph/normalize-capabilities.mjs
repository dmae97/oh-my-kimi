#!/usr/bin/env node
// T009 — capability normalizer. Repairs the two honest-debt classes the graph flags:
//   dead subpath refs  (python-patterns/testing -> python-patterns)   [repair to base]
//   dead hallucinated  (wiki-onboarding, secrets, ...)                [remove: no-op at runtime]
//   malformed prose    ("none specific", "No direct OMK skill match") [remove; empty -> none]
// Reads the dead set from out/harness-queries.json (ground truth). Backs up agents dir first.
//
// Usage: node normalize-capabilities.mjs [--agents <dir>] [--apply]   (default dry-run)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const AGENTS_DIR = (() => { const i = argv.indexOf("--agents"); return i > -1 ? argv[i + 1] : path.join(HOME, ".omk/agent/agents"); })();
const OUT = path.join(process.cwd(), ".omk/harness-graph/out");
const RUNS = path.join(process.cwd(), ".omk/runs/harness-graph");

const CAP_RE = /^(\s*-\s*(?:Skills|Hooks[^:]*|MCP[^:]*):\s*)(.*?)(\s*)$/;

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// dead skill targets from the graph (authoritative)
const q = readJSON(path.join(OUT, "harness-queries.json"));
if (!q) { console.error("run build-harness-graph.mjs first (missing harness-queries.json)"); process.exit(1); }
const deadTargets = new Set((q.deadSkills || []).map((r) => r.target));
const deadMcp = new Set((q.deadMcp || []).map((r) => r.target));
const deadHook = new Set((q.deadHooks || []).map((r) => r.target));

// valid id sets from the graph: active+inactive skills = full on-disk catalog; non-dead hook/mcp.
// Used to distinguish `id (annotation)` (keep id) from pure prose (drop).
const g = readJSON(path.join(OUT, "harness-graph.json")) || { nodes: [] };
const validSkill = new Set(), validHook = new Set(), validMcp = new Set();
for (const n of g.nodes || []) {
  if (n.type === "skill" && (n.tier === "active" || n.tier === "inactive")) validSkill.add(n.name);
  else if (n.type === "hook" && !n.dead) validHook.add(n.name);
  else if (n.type === "mcp" && !n.dead) validMcp.add(n.name);
}

const log = { dead_removed: [], subpath_repaired: [], malformed_removed: [], annotation_stripped: [], tool_only: [] };

function normItem(item, agent, kind) {
  const v = item.replace(/^["'`]+/, "").replace(/["'`.]+$/, "").trim();
  if (!v || /^(none|n\/?a|tbd|-)$/i.test(v)) return null;
  // extract the leading lowercase kebab id token; strips inline annotations like "(read-only)".
  const m = /^([a-z0-9@][a-z0-9._-]*(?:\/[a-z0-9._-]+)*)/.exec(v);
  if (!m) { log.malformed_removed.push({ agent, kind, item: v }); return null; } // pure prose
  let token = m[1];
  const hadExtra = token !== v;
  if (token.includes("/")) {           // subpath typo -> base id
    const base = token.split("/")[0];
    log.subpath_repaired.push({ agent, kind, from: v, to: base });
    token = base;
  }
  const validSet = kind === "skill" ? validSkill : kind === "mcp" ? validMcp : validHook;
  const deadSet = kind === "skill" ? deadTargets : kind === "mcp" ? deadMcp : deadHook;
  if (validSet.has(token)) {
    if (hadExtra) log.annotation_stripped.push({ agent, kind, from: v, to: token });
    return token;
  }
  if (deadSet.has(token)) { log.dead_removed.push({ agent, kind, item: token }); return null; }
  // leading token is neither a real id nor a known dead ref -> prose/unknown, drop for review
  log.malformed_removed.push({ agent, kind, item: v });
  return null;
}

function kindOf(prefix) {
  return /Skills/.test(prefix) ? "skill" : /Hooks/.test(prefix) ? "hook" : "mcp";
}

function processFile(file) {
  const agent = path.basename(file, ".md");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = CAP_RE.exec(lines[i]);
    if (!m) continue;
    const [, prefix, value] = m;
    const kind = kindOf(prefix);
    const seen = new Set();
    const kept = [];
    for (const raw of value.split(/[,;]/)) {
      const n = normItem(raw, agent, kind);
      if (n && !seen.has(n)) { seen.add(n); kept.push(n); }
    }
    const rebuilt = prefix + (kept.length ? kept.join(", ") : "none");
    if (kept.length === 0 && kind === "skill") log.tool_only.push(agent);
    if (rebuilt !== lines[i]) { lines[i] = rebuilt; changed = true; }
  }
  if (changed && APPLY) fs.writeFileSync(file, lines.join("\n"));
  return changed;
}

let files = [];
try { files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).map((f) => path.join(AGENTS_DIR, f)); }
catch { console.error("no agents dir:", AGENTS_DIR); process.exit(1); }

let backup = "(dry-run)";
if (APPLY) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  backup = path.join(path.dirname(AGENTS_DIR), `agents-backup-normalize-${ts}.tgz`);
  execFileSync("tar", ["czf", backup, "-C", path.dirname(AGENTS_DIR), path.basename(AGENTS_DIR)]);
}

let touched = 0;
for (const f of files) if (processFile(f)) touched++;

fs.mkdirSync(RUNS, { recursive: true });
const evidence = {
  task: "T009", mode: APPLY ? "apply" : "dry-run", ts: new Date().toISOString(), backup,
  agentsTouched: touched,
  counts: {
    dead_removed: log.dead_removed.length,
    subpath_repaired: log.subpath_repaired.length,
    malformed_removed: log.malformed_removed.length,
    annotation_stripped: log.annotation_stripped.length,
    tool_only_agents: [...new Set(log.tool_only)].length,
  },
  log,
};
fs.writeFileSync(path.join(RUNS, "T009.json"), JSON.stringify(evidence, null, 2));

console.log(`normalize ${APPLY ? "APPLIED" : "DRY-RUN"} — backup: ${path.relative(HOME, backup)}`);
console.log(`  agents touched: ${touched}`);
console.log(`  dead removed: ${evidence.counts.dead_removed}  subpath repaired: ${evidence.counts.subpath_repaired}`);
console.log(`  malformed removed: ${evidence.counts.malformed_removed}  tool-only agents: ${evidence.counts.tool_only_agents}`);
console.log(`  evidence -> .omk/runs/harness-graph/T009.json`);
