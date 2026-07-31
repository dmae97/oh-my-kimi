#!/usr/bin/env node
// Prune references to retired hooks from agent definitions — SAFE, at-source, reversible.
//
// Scope: exactly the tokens named in --targets (default: pre-shell-guard, stop-verify).
// protect-secrets is deliberately NOT touched by default — narrower than "delete every
// dead hook", per explicit user direction (2026-08-01). Neither target has a corresponding
// *.sh in the live ~/.omk/extensions dir (confirmed via harness-graph provenance) and
// neither is coming back, so this is documentation cleanup, not a live security change:
// the Pi runtime (~/.pi/agent/extensions/omk-runtime/index.ts) already resolves hooks from
// disk, not from these agent capability lines, so nothing here was ever enforcing anything.
//
// Touches two distinct shapes per agent .md, both within their own scope only:
//   - frontmatter `hooks: a, b, c`              (only inside the --- ... --- block)
//   - body `- Hooks[...]: a, b, c`               (e.g. "- Hooks:", "- Hooks relevant to this lane:")
// Every other hook on the same line is left untouched. A line whose entire list becomes
// empty after pruning is dropped rather than left as a dangling "- Hooks: ".
//
// Usage: node prune-retired-hooks.mjs [--agents <dir>] [--targets pre-shell-guard,stop-verify] [--apply]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const argv = new Set(process.argv.slice(2));
const APPLY = argv.has("--apply");
const AGENTS_DIR = (() => {
  const i = process.argv.indexOf("--agents");
  return i > -1 ? process.argv[i + 1] : path.join(HOME, ".omk/agent/agents");
})();
const TARGETS = (() => {
  const i = process.argv.indexOf("--targets");
  const raw = i > -1 ? process.argv[i + 1] : "pre-shell-guard,stop-verify";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
})();
const OUT_DIR = path.join(process.cwd(), ".omk/harness-graph/out");

const FRONTMATTER_HOOKS_RE = /^(hooks:\s*)(.*?)(\s*)$/;
const BODY_HOOKS_RE = /^(\s*-\s*Hooks[^:]*:\s*)(.*?)(\s*)$/;

function listAgents() {
  try { return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).map((f) => path.join(AGENTS_DIR, f)); }
  catch { return []; }
}

function backup() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(path.dirname(AGENTS_DIR), `agents-backup-prune-${ts}.tgz`);
  execFileSync("tar", ["czf", dest, "-C", path.dirname(AGENTS_DIR), path.basename(AGENTS_DIR)]);
  return dest;
}

function pruneValue(value) {
  const items = value.split(/[,;]/)
    .map((s) => s.trim().replace(/^["'`]+/, "").replace(/[."'`]+$/, "").trim())
    .filter(Boolean);
  const kept = items.filter((it) => !TARGETS.has(it));
  const removed = items.filter((it) => TARGETS.has(it));
  return { kept, removed };
}

const changes = []; // {agent, kind, before, after|null, removed[]}
const removedByTarget = new Map();

function tally(removed) {
  for (const t of removed) removedByTarget.set(t, (removedByTarget.get(t) || 0) + 1);
}

function processFile(file) {
  const agent = path.basename(file, ".md");
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  let changed = false;
  let inFrontmatter = false;
  let frontmatterEnded = false;
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.trim() === "---") { inFrontmatter = true; out.push(line); continue; }
    if (inFrontmatter && !frontmatterEnded && line.trim() === "---") { frontmatterEnded = true; inFrontmatter = false; out.push(line); continue; }

    let handled = false;
    if (inFrontmatter) {
      const m = FRONTMATTER_HOOKS_RE.exec(line);
      if (m) {
        const { kept, removed } = pruneValue(m[2]);
        if (removed.length) {
          changed = true; tally(removed);
          const after = kept.length ? `hooks: ${kept.join(", ")}` : null;
          changes.push({ agent, kind: "frontmatter", before: line, after, removed });
          if (after) out.push(after);
          handled = true;
        }
      }
    } else {
      const m = BODY_HOOKS_RE.exec(line);
      if (m) {
        const { kept, removed } = pruneValue(m[2]);
        if (removed.length) {
          changed = true; tally(removed);
          const after = kept.length ? m[1] + kept.join(", ") : null;
          changes.push({ agent, kind: "body", before: line.trim(), after: after ? after.trim() : null, removed });
          if (after) out.push(after);
          handled = true;
        }
      }
    }
    if (!handled) out.push(line);
  }

  if (changed && APPLY) fs.writeFileSync(file, out.join("\n"));
  return changed;
}

// --- run ---
const agents = listAgents();
if (!agents.length) { console.error("no agents at", AGENTS_DIR); process.exit(1); }
if (TARGETS.size === 0) { console.error("no --targets given"); process.exit(1); }

let backupPath = "(dry-run, no backup)";
if (APPLY) backupPath = backup();

let touched = 0;
for (const f of agents) if (processFile(f)) touched++;

fs.mkdirSync(OUT_DIR, { recursive: true });
const removedTotal = [...removedByTarget.values()].reduce((a, b) => a + b, 0);
const report = {
  generatedAt: new Date().toISOString(),
  mode: APPLY ? "apply" : "dry-run",
  targets: [...TARGETS],
  backup: backupPath,
  agentsScanned: agents.length,
  agentsTouched: touched,
  tokensRemoved: removedTotal,
  removedByTarget: Object.fromEntries(removedByTarget),
  allChanges: changes,
};
fs.writeFileSync(path.join(OUT_DIR, "prune-retired-hooks-report.json"), JSON.stringify(report, null, 2));

console.log(`prune-retired-hooks ${APPLY ? "APPLIED" : "DRY-RUN"} — backup: ${path.relative(HOME, backupPath) || backupPath}`);
console.log(`  targets: ${[...TARGETS].join(", ")}`);
console.log(`  agents scanned: ${agents.length}  touched: ${touched}  tokens removed: ${removedTotal}`);
for (const [t, n] of removedByTarget) console.log(`    ${t}: ${n}`);
console.log(`  written: .omk/harness-graph/out/prune-retired-hooks-report.json`);
