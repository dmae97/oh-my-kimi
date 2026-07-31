#!/usr/bin/env node
// P0 catalog reconciliation — for every agent->skill reference that is NOT in the active
// runtime catalog, resolve WHERE that skill lives on disk and how many agents demand it.
// Produces an activation plan (which skill roots/packs to turn on) instead of blindly
// mutating the runtime catalog, because activation is a resolver/config decision.
//
// Usage: node reconcile-catalog.mjs [--agent-root <dir>]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const i = process.argv.indexOf("--agent-root");
const AGENT_ROOT = i > -1 ? process.argv[i + 1] : path.join(HOME, ".omk/agent");
const AGENTS_DIR = path.join(AGENT_ROOT, "agents");
const OUT_DIR = path.join(process.cwd(), ".omk/harness-graph/out");
const ACTIVE = [
  { kind: "index", file: path.join(process.cwd(), ".omk/skills-index.txt") },
  { kind: "json", file: path.join(AGENT_ROOT, "skills.json") },
  { kind: "settings", file: path.join(AGENT_ROOT, "settings.json") },
];
const SKILL_ROOTS = [
  path.join(AGENT_ROOT, "skills"),
  path.join(HOME, ".claude"),
  path.join(HOME, ".pi/agent"),
  path.join(process.cwd(), ".omk/skills"),
];
const SKIP = new Set(["node_modules", ".git", "sessions", "quarantine", "QUARANTINE", ".cache", "backups", "dist", "build", ".next", "coverage"]);
const ID_RE = /^[@a-z0-9][a-z0-9._/-]*$/i;

const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const readJSON = (p) => { const t = readText(p); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };
function fm(text) { const o = {}; if (!text || !text.startsWith("---")) return o; const e = text.indexOf("\n---", 3); if (e < 0) return o; for (const l of text.slice(3, e).split("\n")) { const m = /^(\w[\w-]*):\s*(.*)$/.exec(l); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "").trim(); } return o; }

function loadActive() {
  const s = new Set();
  for (const a of ACTIVE) {
    if (a.kind === "index") { const t = readText(a.file); if (t) for (const l of t.split("\n")) { const v = l.trim(); if (v && !v.startsWith("#")) s.add(v); } }
    else if (a.kind === "json") { const j = readJSON(a.file); if (j && Array.isArray(j.skills)) for (const sk of j.skills) if (sk?.name) s.add(String(sk.name).trim()); }
    else if (a.kind === "settings") {
      const j = readJSON(a.file);
      if (j && Array.isArray(j.skills)) for (const e of j.skills) {
        if (typeof e !== "string" || e.startsWith("-")) continue;
        const skillMd = e.endsWith("SKILL.md") ? e : path.join(e, "SKILL.md");
        const nm = fm(readText(skillMd)).name;
        s.add((nm || (e.endsWith("SKILL.md") ? path.basename(path.dirname(e)) : path.basename(e))).trim());
      }
    }
  }
  return s;
}

function walk(dir, map, depth, seen) {
  if (depth > 6) return;
  let real; try { real = fs.realpathSync(dir); } catch { return; }
  if (seen.has(real)) return; seen.add(real);
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith(".") && e.name !== ".claude" && e.name !== ".agents") continue;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, map, depth + 1, seen);
    else if (e.name === "SKILL.md") { const nm = fm(readText(full)).name; if (nm && !map.has(nm.trim())) map.set(nm.trim(), path.relative(HOME, full)); }
  }
}
function onDiskMap() { const m = new Map(); const seen = new Set(); for (const r of SKILL_ROOTS) walk(r, m, 0, seen); return m; }

// agent demand
const CAP_RE = /^-\s*Skills:\s*(.*)$/;
function demand() {
  const d = new Map();
  let files = []; try { files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")); } catch {}
  for (const f of files) {
    const agent = f.replace(/\.md$/, "");
    const text = readText(path.join(AGENTS_DIR, f)) || "";
    for (const line of text.split("\n")) {
      const m = CAP_RE.exec(line.trim());
      if (!m) continue;
      for (const raw of m[1].split(/[,;]/)) {
        const item = raw.trim().replace(/^["'`]+/, "").replace(/[."'`]+$/, "").trim();
        if (item && ID_RE.test(item) && !/^(none|n\/?a|tbd|-)$/i.test(item)) {
          if (!d.has(item)) d.set(item, new Set());
          d.get(item).add(agent);
        }
      }
    }
  }
  return d;
}

const active = loadActive();
const disk = onDiskMap();
const dem = demand();

const inactive = [], dead = [];
for (const [skill, agents] of dem) {
  if (active.has(skill)) continue;
  const rec = { skill, demand: agents.size, agents: [...agents].slice(0, 6) };
  if (disk.has(skill)) { rec.path = disk.get(skill); inactive.push(rec); }
  else dead.push(rec);
}
inactive.sort((a, b) => b.demand - a.demand);
dead.sort((a, b) => b.demand - a.demand);

// cluster inactive by source pack (2 path segments under HOME)
const clusters = new Map();
for (const r of inactive) {
  const seg = r.path.split("/").slice(0, 3).join("/");
  if (!clusters.has(seg)) clusters.set(seg, { root: seg, skills: 0, demand: 0 });
  const c = clusters.get(seg); c.skills++; c.demand += r.demand;
}
const clusterRows = [...clusters.values()].sort((a, b) => b.demand - a.demand);

fs.mkdirSync(OUT_DIR, { recursive: true });
const plan = {
  generatedAt: new Date().toISOString(),
  summary: {
    inactiveSkills: inactive.length, inactiveDemandEdges: inactive.reduce((s, r) => s + r.demand, 0),
    deadSkills: dead.length, deadDemandEdges: dead.reduce((s, r) => s + r.demand, 0),
    activationClusters: clusterRows.length,
  },
  activationClusters: clusterRows,
  inactiveTop: inactive.slice(0, 60),
  dead,
};
fs.writeFileSync(path.join(OUT_DIR, "reconcile-plan.json"), JSON.stringify(plan, null, 2));

// markdown
const L = ["# P0 Catalog Reconciliation Plan", "", `_Generated ${new Date().toISOString()}_`, "",
  `Inactive skills: **${plan.summary.inactiveSkills}** wanted by **${plan.summary.inactiveDemandEdges}** agent edges.`,
  `Truly dead (no SKILL.md anywhere): **${plan.summary.deadSkills}** (${plan.summary.deadDemandEdges} edges).`, "",
  "## Activation clusters (turn these roots on to satisfy demand)", "", "| source root | skills | agent-demand |", "|---|---:|---:|"];
for (const c of clusterRows) L.push(`| ${c.root} | ${c.skills} | ${c.demand} |`);
L.push("", "## Top inactive skills (skill · demand · where it lives)", "", "| skill | demand | path |", "|---|---:|---|");
for (const r of inactive.slice(0, 40)) L.push(`| ${r.skill} | ${r.demand} | ${r.path} |`);
L.push("", "## Truly dead references (fix or remove in referencing agents)", "", "| skill | demand | example agents |", "|---|---:|---|");
for (const r of dead) L.push(`| ${r.skill} | ${r.demand} | ${r.agents.join(", ")} |`);
fs.writeFileSync(path.join(OUT_DIR, "reconcile-plan.md"), L.join("\n"));

console.log("reconcile plan ->", path.relative(process.cwd(), OUT_DIR));
console.log(`  inactive skills: ${inactive.length} (${plan.summary.inactiveDemandEdges} edges)  clusters: ${clusterRows.length}`);
console.log(`  dead skills: ${dead.length} (${plan.summary.deadDemandEdges} edges)`);
console.log("  top clusters:");
for (const c of clusterRows.slice(0, 5)) console.log(`    ${c.demand}dmd ${c.skills}sk  ${c.root}`);
