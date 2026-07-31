#!/usr/bin/env node
// Agent hygiene fixer — SAFE, at-source. Only does provably-correct edits:
//   1. strip trailing sentence punctuation from capability lines (a skill id never ends in ".")
// Everything requiring intent (malformed prose entries, hallucinated skill names) is REPORTED
// into a remediation backlog, never auto-rewritten. Backs up the agents dir before touching it.
//
// Usage: node fix-agent-hygiene.mjs [--agents <dir>] [--apply]   (default: dry-run)

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
const OUT_DIR = path.join(process.cwd(), ".omk/harness-graph/out");

const CAP_RE = /^(\s*-\s*(?:Skills|Hooks[^:]*|MCP[^:]*):\s*)(.*?)(\s*)$/;
const ID_RE = /^[@a-z0-9][a-z0-9._/-]*$/i;
const PROSE_RE = /\s|—|no direct|self-contained|none specific|n\/a/i;

function listAgents() {
  try { return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).map((f) => path.join(AGENTS_DIR, f)); }
  catch { return []; }
}

function backup() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(path.dirname(AGENTS_DIR), `agents-backup-${ts}.tgz`);
  execFileSync("tar", ["czf", dest, "-C", path.dirname(AGENTS_DIR), path.basename(AGENTS_DIR)]);
  return dest;
}

const fixes = [];          // {agent, before, after}
const malformed = [];      // {agent, entries[]}
const suspiciousDead = []; // {agent, entries[]}  (ids that look like subpaths/typos)

function processFile(file) {
  const agent = path.basename(file, ".md");
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const m = CAP_RE.exec(lines[i]);
    if (!m) continue;
    const [, prefix, value] = m;

    // report-only classification of the entries on this line
    for (const raw of value.split(/[,;]/)) {
      const item = raw.trim().replace(/^["'`]+/, "").replace(/[."'`]+$/, "").trim();
      if (!item || /^(none|n\/?a|tbd|-)$/i.test(item)) continue;
      if (PROSE_RE.test(item)) malformed.push({ agent, entry: item });
      else if (item.includes("/")) suspiciousDead.push({ agent, entry: item });
    }

    // SAFE auto-fix: strip trailing sentence punctuation ('.' or stray quote) from the value
    const cleaned = value.replace(/[.\s]+$/, "");
    if (cleaned !== value) {
      const before = lines[i];
      lines[i] = prefix + cleaned;
      fixes.push({ agent, before: before.trim(), after: lines[i].trim() });
      changed = true;
    }
  }

  if (changed && APPLY) fs.writeFileSync(file, lines.join("\n"));
  return changed;
}

// --- run ---
const agents = listAgents();
if (!agents.length) { console.error("no agents at", AGENTS_DIR); process.exit(1); }

let backupPath = "(dry-run, no backup)";
if (APPLY) backupPath = backup();

let touched = 0;
for (const f of agents) if (processFile(f)) touched++;

fs.mkdirSync(OUT_DIR, { recursive: true });
const backlog = {
  generatedAt: new Date().toISOString(),
  mode: APPLY ? "apply" : "dry-run",
  backup: backupPath,
  autoFixed: { agentsTouched: touched, lineFixes: fixes.length, sample: fixes.slice(0, 15) },
  remediationBacklog: {
    malformedEntries: dedupe(malformed),
    suspiciousDeadRefs: dedupe(suspiciousDead),
  },
};
fs.writeFileSync(path.join(OUT_DIR, "agent-hygiene-backlog.json"), JSON.stringify(backlog, null, 2));

function dedupe(arr) {
  const byAgent = new Map();
  for (const { agent, entry } of arr) {
    if (!byAgent.has(agent)) byAgent.set(agent, new Set());
    byAgent.get(agent).add(entry);
  }
  return [...byAgent.entries()].map(([agent, s]) => ({ agent, entries: [...s] }));
}

console.log(`hygiene ${APPLY ? "APPLIED" : "DRY-RUN"} — backup: ${path.relative(HOME, backupPath) || backupPath}`);
console.log(`  agents scanned: ${agents.length}  touched: ${touched}  trailing-punct line fixes: ${fixes.length}`);
console.log(`  backlog -> malformed agents: ${backlog.remediationBacklog.malformedEntries.length}  suspicious-dead: ${backlog.remediationBacklog.suspiciousDeadRefs.length}`);
console.log(`  written: .omk/harness-graph/out/agent-hygiene-backlog.json`);
