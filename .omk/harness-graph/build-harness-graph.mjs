#!/usr/bin/env node
// Harness graph builder v2 — nodes: agents/skills/hooks/mcp, edges: agent->{skill,hook,mcp}.
// Skill refs are classified into 3 tiers (active catalog / on-disk-inactive / dead) so the
// dead-link count is defensible against the full on-disk skill universe, not a stale index.
// Stdlib only, no deps.
//
// Usage: node build-harness-graph.mjs [--agent-root <dir>] [--out <dir>]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const argv = parseArgs(process.argv.slice(2));
const AGENT_ROOT = argv["agent-root"] || path.join(HOME, ".omk/agent");
const AGENTS_DIR = path.join(AGENT_ROOT, "agents");
const OUT_DIR = argv.out || path.join(process.cwd(), ".omk/harness-graph/out");

// Active catalog = what the runtime actually configured/discovered.
const ACTIVE_SOURCES = [
  { kind: "index", file: path.join(process.cwd(), ".omk/skills-index.txt") },
  { kind: "json", file: path.join(AGENT_ROOT, "skills.json") },
  { kind: "settings", file: path.join(AGENT_ROOT, "settings.json") },
];
// On-disk universe = every SKILL.md reachable from these roots (symlinks followed).
const SKILL_ROOTS = [
  path.join(AGENT_ROOT, "skills"),
  path.join(HOME, ".claude"),
  path.join(HOME, ".pi/agent"),
  path.join(process.cwd(), ".omk/skills"),
];
const WALK_SKIP = new Set([
  "node_modules", ".git", "sessions", "quarantine", "QUARANTINE",
  ".cache", "backups", "dist", "build", ".next", "coverage",
]);
const MAX_DEPTH = 6;

const HOOKS_JSON = path.join(AGENT_ROOT, "hooks.json");
const MCP_JSON = path.join(AGENT_ROOT, "mcp.json");
const SETTINGS_JSON = path.join(AGENT_ROOT, "settings.json");

// Hook/MCP ground truth is DERIVED, never hardcoded. It mirrors exactly what the omk-runtime
// extension resolves at runtime (~/.pi/agent/extensions/omk-runtime/index.ts):
//   hooks -> `*.sh` in $OMK_HOME/extensions            (HOOK_DISCOVERY_DIR + summarizeHooks)
//   mcp   -> $OMK_HOME/mcp.json ∪ $OMK_HOME/agent/mcp.json  (listConfiguredMcpServers)
//
// A frozen literal array here makes hookEdgesDead/mcpEdgesDead structurally incapable of going
// red: whatever you type in becomes "valid" by definition. That is exactly how 398 agent->hook
// edges (protect-secrets 209, pre-shell-guard 150, stop-verify 39) pointed at scripts that do
// not exist in the live install while the report printed `hookEdgesDead: 0`. Freezing the
// answer key is the same sin as mutating the catalog to make a metric green — see README.
const OMK_HOME = process.env.OMK_HOME || path.join(HOME, ".omk");
const HOOK_DISCOVERY_DIR = path.join(OMK_HOME, "extensions");
const ROOT_MCP_JSON = path.join(OMK_HOME, "mcp.json");

const STOPWORDS = new Set(
  ("a an and are as at be by for from has have in into is it its of on or that the to " +
   "use used using when with you your this these those which who whom what specialist " +
   "senior expert agent build builds building based across all any who").split(" ")
);

// A real skill/hook/mcp id is a single kebab/snake token (optionally scoped). Anything with
// whitespace or prose punctuation is a malformed capability entry, not a reference.
const ID_RE = /^[@a-z0-9][a-z0-9._/-]*$/i;

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++)
    if (a[i].startsWith("--")) {
      const k = a[i].slice(2);
      o[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
    }
  return o;
}
const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const readJSON = (p) => { const t = readText(p); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };

// --- Catalogs ----------------------------------------------------------------

function parseFrontmatter(text) {
  const out = {};
  if (!text || !text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return out;
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function loadActiveCatalog() {
  const set = new Set();
  for (const s of ACTIVE_SOURCES) {
    if (s.kind === "index") {
      const t = readText(s.file);
      if (t) for (const l of t.split("\n")) { const v = l.trim(); if (v && !v.startsWith("#")) set.add(v); }
    } else if (s.kind === "json") {
      const j = readJSON(s.file);
      if (j && Array.isArray(j.skills))
        for (const sk of j.skills) if (sk && sk.name) set.add(String(sk.name).trim());
    } else if (s.kind === "settings") {
      // settings.json `skills` array: dir paths + SKILL.md paths; "-" prefix = disabled (skip).
      // Read each entry's frontmatter name (dir basename is unreliable: skill name != dir name).
      const j = readJSON(s.file);
      if (j && Array.isArray(j.skills))
        for (const e of j.skills) {
          if (typeof e !== "string" || e.startsWith("-")) continue;
          const skillMd = e.endsWith("SKILL.md") ? e : path.join(e, "SKILL.md");
          const nm = parseFrontmatter(readText(skillMd)).name;
          set.add((nm || (e.endsWith("SKILL.md") ? path.basename(path.dirname(e)) : path.basename(e))).trim());
        }
    }
  }
  return set;
}

function walkForSkillNames(dir, set, depth, seen) {
  if (depth > MAX_DEPTH) return;
  let real;
  try { real = fs.realpathSync(dir); } catch { return; }
  if (seen.has(real)) return; // symlink loop guard
  seen.add(real);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".claude" && e.name !== ".agents") continue;
    if (WALK_SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(full); } catch { continue; } // follows symlinks; skips broken
    if (st.isDirectory()) walkForSkillNames(full, set, depth + 1, seen);
    else if (e.name === "SKILL.md") {
      const nm = parseFrontmatter(readText(full)).name;
      if (nm) set.add(nm.trim());
    }
  }
}

function loadOnDiskCatalog() {
  const set = new Set();
  const seen = new Set();
  for (const root of SKILL_ROOTS) walkForSkillNames(root, set, 0, seen);
  return set;
}

// Same rule the runtime uses: a hook exists iff `<name>.sh` is a file in $OMK_HOME/extensions.
// A `.bak-*` rename (how protect-secrets was retired on 2026-07-21) therefore reads as absent.
function discoverRuntimeHooks() {
  let entries = [];
  try { entries = fs.readdirSync(HOOK_DISCOVERY_DIR, { withFileTypes: true }); } catch { /* dir gone */ }
  return entries.filter((e) => e.isFile() && e.name.endsWith(".sh")).map((e) => e.name.slice(0, -3));
}

function loadValidHooks() {
  const discovered = discoverRuntimeHooks();
  // Empty discovery means the path moved, not that every hook died. Reporting 100% dead would
  // be as dishonest as reporting 0% — fail loudly instead of emitting a confident wrong number.
  if (discovered.length === 0)
    throw new Error(`no *.sh found in ${HOOK_DISCOVERY_DIR} — hook discovery is broken. Fix the path; do NOT reintroduce a hardcoded list.`);
  const set = new Set(discovered);
  const h = readJSON(HOOKS_JSON);
  if (h && h.hooks) for (const [integ, cfg] of Object.entries(h.hooks)) {
    set.add(integ);
    if (cfg && cfg.hooks) for (const n of Object.keys(cfg.hooks)) set.add(n);
  }
  return set;
}

function loadValidMcp() {
  const enabled = new Set(), disabled = new Set();
  const configs = [ROOT_MCP_JSON, MCP_JSON].map(readJSON).filter(Boolean);
  for (const m of configs) if (m.mcpServers) for (const k of Object.keys(m.mcpServers)) enabled.add(k);
  if (enabled.size === 0)
    throw new Error(`no mcpServers found in ${ROOT_MCP_JSON} or ${MCP_JSON} — MCP discovery is broken. Fix the path; do NOT reintroduce a hardcoded list.`);
  // A server disabled in one config but enabled in the other counts as enabled (union wins).
  for (const m of configs)
    if (m._disabledMcpServers) for (const k of Object.keys(m._disabledMcpServers)) if (!enabled.has(k)) disabled.add(k);
  return { enabled, disabled };
}

// --- Agent parsing -----------------------------------------------------------

const CAP_RE = /^-\s*(Skills|Hooks[^:]*|MCP[^:]*):\s*(.*)$/;

function splitList(v) {
  // strip surrounding quotes AND trailing sentence punctuation (agent lines often end ". ")
  return v.split(/[,;]/)
    .map((s) => s.trim().replace(/^["'`]+/, "").replace(/["'`.]+$/, "").trim())
    .filter(Boolean);
}

function parseAgent(file) {
  const text = readText(file) || "";
  const fm = parseFrontmatter(text);
  const name = fm.name || path.basename(file, ".md");
  const caps = { skills: [], hooks: [], mcp: [] };
  const malformed = { skills: [], hooks: [], mcp: [] };
  for (const line of text.split("\n")) {
    const m = CAP_RE.exec(line.trim());
    if (!m) continue;
    const kind = m[1].startsWith("Skills") ? "skills" : m[1].startsWith("Hooks") ? "hooks" : "mcp";
    for (const item of splitList(m[2])) {
      if (/^(none|n\/?a|tbd|-)$/i.test(item)) continue;
      (ID_RE.test(item) ? caps : malformed)[kind].push(item);
    }
  }
  return { name, description: fm.description || "", caps, malformed, file: path.relative(HOME, file) };
}

// --- Build -------------------------------------------------------------------

function build() {
  const active = loadActiveCatalog();
  const onDisk = loadOnDiskCatalog();
  const validHooks = loadValidHooks();
  const { enabled: mcpEnabled, disabled: mcpDisabled } = loadValidMcp();
  const allMcp = new Set([...mcpEnabled, ...mcpDisabled]);

  let files = [];
  try { files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).map((f) => path.join(AGENTS_DIR, f)); } catch {}
  const agents = files.map(parseAgent);

  const nodes = new Map();
  const edges = [];
  const addNode = (type, name, extra = {}) => {
    const id = `${type}:${name}`;
    if (!nodes.has(id)) nodes.set(id, { id, type, name, inbound: 0, ...extra });
    else Object.assign(nodes.get(id), extra);
    return nodes.get(id);
  };

  for (const s of active) addNode("skill", s, { tier: "active" });
  for (const s of onDisk) if (!active.has(s)) addNode("skill", s, { tier: "inactive" });
  for (const h of validHooks) addNode("hook", h, { exists: true });
  for (const m of mcpEnabled) addNode("mcp", m, { exists: true, enabled: true });
  for (const m of mcpDisabled) addNode("mcp", m, { exists: true, enabled: false });

  const dead = { skill: new Map(), hook: new Map(), mcp: new Map() };
  const inactive = new Map();
  const malformed = new Map(); // agent -> {skills,hooks,mcp}
  const push = (map, key, agent) => { (map.get(key) || map.set(key, []).get(key)).push(agent); };

  for (const a of agents) {
    addNode("agent", a.name, { description: a.description, file: a.file,
      skills: a.caps.skills.length, hooks: a.caps.hooks.length, mcp: a.caps.mcp.length });

    for (const s of a.caps.skills) {
      let tier;
      if (active.has(s)) tier = "active";
      else if (onDisk.has(s)) { tier = "inactive"; push(inactive, s, a.name); }
      else { tier = "dead"; push(dead.skill, s, a.name); }
      const node = addNode("skill", s, {}); // ensure node exists (dead skills have none yet)
      node.inbound++; if (tier === "dead") node.dead = true;
      edges.push({ from: `agent:${a.name}`, to: `skill:${s}`, type: "agent->skill", tier });
    }
    const linkExact = (type, list, validSet) => {
      for (const t of list) {
        const ok = validSet.has(t);
        const node = addNode(type, t, {});
        node.inbound++; if (!ok) { node.dead = true; push(dead[type], t, a.name); }
        edges.push({ from: `agent:${a.name}`, to: `${type}:${t}`, type: `agent->${type}`, tier: ok ? "active" : "dead" });
      }
    };
    linkExact("hook", a.caps.hooks, validHooks);
    linkExact("mcp", a.caps.mcp, allMcp);

    const mf = a.malformed;
    if (mf.skills.length + mf.hooks.length + mf.mcp.length > 0)
      malformed.set(a.name, mf);
  }

  return { nodes, edges, agents, active, onDisk, validHooks, mcpEnabled, mcpDisabled, dead, inactive, malformed };
}

// --- Queries -----------------------------------------------------------------

const tokenize = (t) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !STOPWORDS.has(x)));
function jaccard(a, b) { if (!a.size || !b.size) return 0; let i = 0; for (const t of a) if (b.has(t)) i++; return i / (a.size + b.size - i); }
const rows = (m) => [...m.entries()].map(([target, ags]) => ({ target, count: ags.length, agents: ags.slice(0, 8) })).sort((a, b) => b.count - a.count);

function queries(g, thresh = 0.5) {
  const skills = [...g.nodes.values()].filter((n) => n.type === "skill");
  const hooks = [...g.nodes.values()].filter((n) => n.type === "hook");
  const mcp = [...g.nodes.values()].filter((n) => n.type === "mcp");
  const top = (arr, k) => [...arr].sort((a, b) => b.inbound - a.inbound).slice(0, k).map((n) => ({ name: n.name, inbound: n.inbound, tier: n.tier }));

  const orphanActive = skills.filter((n) => n.tier === "active" && n.inbound === 0).map((n) => n.name).sort();

  const withTok = g.agents.filter((a) => a.description.length > 20).map((a) => ({ name: a.name, tok: tokenize(a.description) }));
  const collisions = [];
  for (let i = 0; i < withTok.length; i++)
    for (let j = i + 1; j < withTok.length; j++) {
      const s = jaccard(withTok[i].tok, withTok[j].tok);
      if (s >= thresh) collisions.push({ a: withTok[i].name, b: withTok[j].name, sim: +s.toFixed(2) });
    }
  collisions.sort((x, y) => y.sim - x.sim);

  const malformedRows = [...g.malformed.entries()]
    .map(([agent, mf]) => ({ agent, entries: [...mf.skills, ...mf.hooks, ...mf.mcp].slice(0, 3) }))
    .slice(0, 40);

  return {
    counts: {
      agents: g.agents.length,
      skillsActive: g.active.size,
      skillsOnDiskExtra: [...g.onDisk].filter((s) => !g.active.has(s)).length,
      skillEdges: g.edges.filter((e) => e.type === "agent->skill").length,
      skillEdgesActive: g.edges.filter((e) => e.type === "agent->skill" && e.tier === "active").length,
      skillEdgesInactive: g.edges.filter((e) => e.type === "agent->skill" && e.tier === "inactive").length,
      skillEdgesDead: g.edges.filter((e) => e.type === "agent->skill" && e.tier === "dead").length,
      hookEdgesDead: g.edges.filter((e) => e.type === "agent->hook" && e.tier === "dead").length,
      mcpEdgesDead: g.edges.filter((e) => e.type === "agent->mcp" && e.tier === "dead").length,
      malformedAgents: g.malformed.size,
    },
    // Where every catalog came from. Shipped in the artifact so a future reader can tell a
    // measured zero from a zero that was defined into existence.
    provenance: [
      { catalog: "hooks (valid)", size: g.validHooks.size, source: `${HOOK_DISCOVERY_DIR}/*.sh + ${HOOKS_JSON}` },
      { catalog: "mcp (enabled)", size: g.mcpEnabled.size, source: `${ROOT_MCP_JSON} ∪ ${MCP_JSON}` },
      { catalog: "mcp (disabled)", size: g.mcpDisabled.size, source: "_disabledMcpServers in the same files" },
      { catalog: "skills (active)", size: g.active.size, source: ACTIVE_SOURCES.map((s) => s.file).join(" ∪ ") },
      { catalog: "skills (on disk)", size: g.onDisk.size, source: SKILL_ROOTS.join(" ∪ ") },
    ],
    deadSkills: rows(g.dead.skill),
    inactiveSkills: rows(g.inactive),
    deadHooks: rows(g.dead.hook),
    deadMcp: rows(g.dead.mcp),
    orphanActiveSkills: orphanActive,
    hubSkills: top(skills, 15),
    hubHooks: top(hooks, 15),
    hubMcp: top(mcp, 15),
    collisions: collisions.slice(0, 40),
    malformedAgents: malformedRows,
    modelDrift: detectModelDrift(),
  };
}

function detectModelDrift() {
  const src = [];
  const st = readJSON(SETTINGS_JSON);
  if (st) src.push({ source: "settings.json", model: [st.defaultProvider, st.defaultModel].filter(Boolean).join("/") || "?" });
  const h = readText(path.join(HOME, ".agents/skills/harness/SKILL.md"));
  if (h) { const m = /model:\s*["']?([a-z0-9.\-]+)/i.exec(h); if (m) src.push({ source: "harness/SKILL.md", model: m[1] }); }
  const a = readText(path.join(HOME, ".omk/agent/AGENTS.md"));
  if (a) { const m = /Failover:\s*([a-z0-9.\-]+)/i.exec(a); if (m) src.push({ source: "AGENTS.md failover", model: m[1] }); }
  const distinct = [...new Set(src.map((s) => s.model))];
  return { drift: distinct.length > 1, distinct, sources: src };
}

// --- Report ------------------------------------------------------------------

function report(q) {
  const L = []; const p = (s = "") => L.push(s);
  p("# Harness Graph — Inventory & Drift Report v2");
  p(`\n_Generated ${new Date().toISOString()}_\n`);
  p("Skill references are tiered: **active** (in runtime catalog) · **inactive** (SKILL.md on");
  p("disk but not activated) · **dead** (no SKILL.md anywhere = hallucinated/removed).\n");

  p("## 1. Counts\n");
  p("| metric | value |\n|---|---:|");
  for (const [k, v] of Object.entries(q.counts)) p(`| ${k} | ${v} |`);
  p("");

  p("### Catalog provenance (what each \"valid\" set was measured against)\n");
  p("| catalog | size | derived from |\n|---|---:|---|");
  for (const r of q.provenance) p(`| ${r.catalog} | ${r.size} | \`${r.source}\` |`);
  p("\n> Hooks/MCP are discovered from the runtime, not a literal array. A hardcoded answer key");
  p("> makes the dead-edge count structurally unable to go red.\n");

  p("## 2. DEAD skill links (referenced, no SKILL.md anywhere — high confidence)\n");
  tbl(p, q.deadSkills, ["skill", "#agents", "example agents"]);

  p("## 3. INACTIVE skill links (on disk, not in active catalog — wiring/config gap)\n");
  tbl(p, q.inactiveSkills, ["skill", "#agents", "example agents"]);

  p("## 4. Dead hook / MCP links\n");
  p("### Hooks"); tbl(p, q.deadHooks, ["hook", "#agents", "example agents"]);
  p("### MCP"); tbl(p, q.deadMcp, ["mcp", "#agents", "example agents"]);

  p("## 5. Malformed capability entries (prose instead of a skill id)\n");
  if (!q.malformedAgents.length) p("(none)\n");
  else { p("| agent | sample entry |\n|---|---|"); for (const r of q.malformedAgents) p(`| ${r.agent} | ${r.entries.join(" · ").slice(0, 90)} |`); p(""); }

  p("## 6. Orphan ACTIVE skills (in catalog, zero agent wires them)\n");
  p(`> ${q.orphanActiveSkills.length} active-catalog skills have no agent edge. Command/dynamic`);
  p("> triggers may still reach them — candidates for wiring/pruning, not auto-delete.\n");
  p("```\n" + (q.orphanActiveSkills.join("  ") || "(none)") + "\n```\n");

  p("## 7. Fan-in hubs\n");
  hub(p, "Skills", q.hubSkills); hub(p, "Hooks", q.hubHooks); hub(p, "MCP", q.hubMcp);

  p("## 8. Trigger collisions (near-duplicate agent descriptions)\n");
  if (!q.collisions.length) p("(none above threshold)\n");
  else { p("| sim | agent A | agent B |\n|---:|---|---|"); for (const c of q.collisions) p(`| ${c.sim} | ${c.a} | ${c.b} |`); p(""); }

  p("## 9. Model drift\n");
  p(q.modelDrift.drift ? `⚠️ **DRIFT** — ${q.modelDrift.distinct.length} distinct: ${q.modelDrift.distinct.join(", ")}` : "✅ consistent");
  p("\n| source | model |\n|---|---|");
  for (const s of q.modelDrift.sources) p(`| ${s.source} | ${s.model} |`);
  p("");
  return L.join("\n");
}

function tbl(p, r, cols) {
  if (!r.length) { p("(none)\n"); return; }
  p(`| ${cols.join(" | ")} |`); p(`|${cols.map(() => "---").join("|")}|`);
  for (const x of r) p(`| ${x.target} | ${x.count} | ${x.agents.join(", ")} |`);
  p("");
}
function hub(p, label, r) { p(`### ${label}`); p("| node | inbound | tier |\n|---|---:|---|"); for (const x of r) p(`| ${x.name} | ${x.inbound} | ${x.tier || "-"} |`); p(""); }

// --- Main --------------------------------------------------------------------

const g = build();
const q = queries(g);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "harness-graph.json"), JSON.stringify({ generatedAt: new Date().toISOString(), counts: q.counts, nodes: [...g.nodes.values()], edges: g.edges }, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "harness-queries.json"), JSON.stringify(q, null, 2));
fs.writeFileSync(path.join(OUT_DIR, "harness-report.md"), report(q));

const c = q.counts;
console.log("Harness graph v2 ->", path.relative(process.cwd(), OUT_DIR));
console.log(`  nodes: ${g.nodes.size}  edges: ${g.edges.length}`);
console.log(`  agents: ${c.agents}  active-catalog: ${c.skillsActive}  on-disk-extra: ${c.skillsOnDiskExtra}`);
console.log(`  skill edges: ${c.skillEdges}  active:${c.skillEdgesActive} inactive:${c.skillEdgesInactive} DEAD:${c.skillEdgesDead}`);
console.log(`  dead skills(distinct): ${q.deadSkills.length}  inactive(distinct): ${q.inactiveSkills.length}  orphan-active: ${q.orphanActiveSkills.length}`);
console.log(`  dead hooks: ${q.deadHooks.length}  dead mcp: ${q.deadMcp.length}  malformed agents: ${c.malformedAgents}`);
console.log(`  collisions(>=0.5): ${q.collisions.length}  model-drift: ${q.modelDrift.drift ? q.modelDrift.distinct.join("/") : "no"}`);
