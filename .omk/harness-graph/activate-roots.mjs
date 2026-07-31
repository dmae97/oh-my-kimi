#!/usr/bin/env node
// P0 root activation — precise. Adds ONLY the skill directories that agents actually demand
// (inactive skills with agent edges) to settings.json `skills`, instead of flooding the runtime
// with whole 615-skill roots. Backs up settings.json first. Verifies every path has a SKILL.md.
//
// Usage: node activate-roots.mjs [--apply] [--min-demand N]   (default dry-run, min-demand 1)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const MIN_DEMAND = (() => { const i = argv.indexOf("--min-demand"); return i > -1 ? +argv[i + 1] : 1; })();
const SETTINGS = path.join(HOME, ".omk/agent/settings.json");
const OUT_DIR = path.join(process.cwd(), ".omk/harness-graph/out");
const SKILL_ROOTS = [
  path.join(HOME, ".omk/agent/skills"),
  path.join(HOME, ".claude"),
  path.join(HOME, ".pi/agent"),
  path.join(process.cwd(), ".omk/skills"),
];
const SKIP = new Set(["node_modules", ".git", "sessions", "quarantine", "QUARANTINE", ".cache", "backups", "dist", "build", ".next", "coverage"]);

function readJSON(p, what) {
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch (e) { console.error(`cannot read ${what} at ${p}: ${e.message}`); process.exit(1); }
  try { return JSON.parse(raw); }
  catch (e) { console.error(`invalid JSON in ${what} at ${p}: ${e.message}`); process.exit(1); }
}

// 1. inactive skills + demand from the graph
const g = readJSON(path.join(OUT_DIR, "harness-graph.json"), "harness graph");
const inactive = new Set(g.nodes.filter((n) => n.type === "skill" && n.tier === "inactive").map((n) => n.name));
const demand = new Map();
for (const e of g.edges)
  if (e.type === "agent->skill") {
    const s = e.to.split(":")[1];
    if (inactive.has(s)) demand.set(s, (demand.get(s) || 0) + 1);
  }
const wanted = [...demand.entries()].filter(([, d]) => d >= MIN_DEMAND).map(([s]) => s);

// 2. locate each wanted skill on disk (symlinks followed, loop-guarded)
const loc = new Map(); // name -> dir
function walk(dir, depth, seen) {
  if (depth > 6) return;
  let real; try { real = fs.realpathSync(dir); } catch { return; }
  if (seen.has(real)) return; seen.add(real);
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith(".") && e.name !== ".claude" && e.name !== ".agents") continue;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, depth + 1, seen);
    else if (e.name === "SKILL.md") {
      const t = fs.readFileSync(full, "utf8");
      const m = /^name:\s*(.+)$/m.exec(t);
      if (m) { const nm = m[1].replace(/^["']|["']$/g, "").trim(); if (!loc.has(nm)) loc.set(nm, path.dirname(full)); }
    }
  }
}
const seen = new Set();
for (const r of SKILL_ROOTS) walk(r, 0, seen);

const toAdd = [];
const unresolved = [];
for (const s of wanted) {
  const dir = loc.get(s);
  if (dir && fs.existsSync(path.join(dir, "SKILL.md"))) toAdd.push({ skill: s, demand: demand.get(s), dir });
  else unresolved.push(s);
}
toAdd.sort((a, b) => b.demand - a.demand);

// 3. diff against current settings.json skills array
const settings = readJSON(SETTINGS, "settings.json");
if (!Array.isArray(settings.skills)) settings.skills = [];
const existing = new Set(settings.skills.map((s) => String(s).replace(/^-/, "")));
const newDirs = [];
const dupes = [];
for (const r of toAdd) {
  if (existing.has(r.dir)) dupes.push(r.dir);
  else if (!newDirs.includes(r.dir)) newDirs.push(r.dir);
}

const plan = {
  mode: APPLY ? "apply" : "dry-run",
  minDemand: MIN_DEMAND,
  wantedInactive: wanted.length,
  resolved: toAdd.length,
  unresolved: unresolved.slice(0, 40),
  dirsToAdd: newDirs.length,
  alreadyPresent: dupes.length,
  totalDemandSatisfied: toAdd.reduce((s, r) => s + r.demand, 0),
  sample: toAdd.slice(0, 20),
  newDirs: newDirs.slice(0, 60),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "activate-plan.json"), JSON.stringify(plan, null, 2));

if (APPLY && newDirs.length) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${SETTINGS}.bak-activate-${ts}`;
  fs.copyFileSync(SETTINGS, bak);
  settings.skills.push(...newDirs);
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  plan.backup = bak;
  fs.writeFileSync(path.join(OUT_DIR, "activate-plan.json"), JSON.stringify(plan, null, 2));
}

console.log(`activate ${APPLY ? "APPLIED" : "DRY-RUN"} (min-demand ${MIN_DEMAND})`);
console.log(`  wanted inactive skills: ${wanted.length}  resolved-on-disk: ${toAdd.length}  unresolved: ${unresolved.length}`);
console.log(`  dirs to add: ${newDirs.length}  already-present: ${dupes.length}  demand satisfied: ${plan.totalDemandSatisfied} edges`);
if (plan.backup) console.log(`  backup: ${path.relative(HOME, plan.backup)}`);
console.log(`  plan -> .omk/harness-graph/out/activate-plan.json`);
if (unresolved.length) console.log(`  unresolved sample: ${unresolved.slice(0, 8).join(", ")}`);
