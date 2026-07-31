#!/usr/bin/env node
// T010 — orphan-active triage. Skills in the active runtime catalog that NO agent wires.
// Report-only: classifies each by on-disk source so a human decides prune-from-settings vs
// wire-to-agent. Never auto-deletes (a skill may be reachable via slash-command/dynamic trigger).
//
// Usage: node orphan-triage.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const OUT = path.join(process.cwd(), ".omk/harness-graph/out");
const AGENT_ROOT = path.join(HOME, ".omk/agent");
const SKILL_ROOTS = [
  path.join(AGENT_ROOT, "skills"), path.join(HOME, ".claude"),
  path.join(HOME, ".pi/agent"), path.join(process.cwd(), ".omk/skills"),
];
const SKIP = new Set(["node_modules", ".git", "sessions", "quarantine", "QUARANTINE", ".cache", "backups", "dist", "build", ".next", "coverage"]);

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function fm(t) { const o = {}; if (!t || !t.startsWith("---")) return o; const e = t.indexOf("\n---", 3); if (e < 0) return o; for (const l of t.slice(3, e).split("\n")) { const m = /^(\w[\w-]*):\s*(.*)$/.exec(l); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "").trim(); } return o; }
function readText(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }

const q = readJSON(path.join(OUT, "harness-queries.json"));
if (!q) { console.error("run build-harness-graph.mjs first"); process.exit(1); }
const orphans = new Set(q.orphanActiveSkills || []);

// resolve each orphan to its on-disk source
const loc = new Map();
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
    else if (e.name === "SKILL.md") { const nm = fm(readText(full)).name; if (nm && orphans.has(nm.trim()) && !loc.has(nm.trim())) loc.set(nm.trim(), path.relative(HOME, path.dirname(full))); }
  }
}
const seen = new Set();
for (const r of SKILL_ROOTS) walk(r, 0, seen);

const clusters = new Map();
const unresolved = [];
for (const s of orphans) {
  const p = loc.get(s);
  if (!p) { unresolved.push(s); continue; }
  const root = p.split("/").slice(0, 3).join("/");
  if (!clusters.has(root)) clusters.set(root, []);
  clusters.get(root).push(s);
}
const rows = [...clusters.entries()].map(([root, sk]) => ({ root, count: sk.length, skills: sk.sort() })).sort((a, b) => b.count - a.count);

const L = ["# Orphan-Active Triage (T010)", "", `_${new Date().toISOString()}_`, "",
  `**${orphans.size}** active-catalog skills have zero agent edges. Report-only — a skill may still`,
  "be reachable via slash-command or dynamic trigger, so this is a *review* list, not a delete list.", "",
  "## Decision per cluster", "",
  "- **prune**: pack activated but no agent needs it → remove its dir from `settings.json.skills`.",
  "- **wire**: capability is wanted → add the skill to the relevant agents' `- Skills:` line.", "",
  "| source cluster | orphans | prune? |", "|---|---:|---|"];
for (const r of rows) L.push(`| ${r.root} | ${r.count} | ${r.count > 15 ? "review pack" : "case-by-case"} |`);
L.push("", "## Full orphan list by cluster", "");
for (const r of rows) { L.push(`### ${r.root} (${r.count})`, "```", r.skills.join("  "), "```", ""); }
if (unresolved.length) L.push(`### unresolved (${unresolved.length})`, "```", unresolved.sort().join("  "), "```");

fs.writeFileSync(path.join(OUT, "orphan-triage.md"), L.join("\n"));
console.log(`orphan triage -> out/orphan-triage.md`);
console.log(`  orphans: ${orphans.size}  clusters: ${rows.length}  unresolved: ${unresolved.length}`);
for (const r of rows.slice(0, 6)) console.log(`    ${r.count}\t${r.root}`);
