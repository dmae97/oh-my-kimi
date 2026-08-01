#!/usr/bin/env node
// Rebuild .omk/skills-index.txt as the UNION of real runtime demand only:
//   - settings.json enabled skill frontmatter names
//   - skills.json names
//   - skills referenced by any agent capability line (non-dead)
// Stale full-universe dumps inflate "orphan-active" (skills in index, zero agent edges)
// and make the active catalog a lie. Backs up the previous index first.
//
// Usage: node compact-skills-index.mjs [--apply]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const APPLY = process.argv.includes("--apply");
const ROOT = process.cwd();
const INDEX = path.join(ROOT, ".omk/skills-index.txt");
const AGENT_ROOT = path.join(HOME, ".omk/agent");
const AGENTS_DIR = path.join(AGENT_ROOT, "agents");
const OUT = path.join(ROOT, ".omk/harness-graph/out");
const GRAPH = path.join(OUT, "harness-graph.json");
const CAP_RE = /^-\s*Skills:\s*(.*)$/;
const ID_RE = /^[@a-z0-9][a-z0-9._/-]*$/i;

const readText = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const readJSON = (p) => {
  const t = readText(p);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
function fm(text) {
  const out = {};
  if (!text || !text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const keep = new Set();

// 1) agent-referenced skills from latest graph (preferred) or live parse
const g = readJSON(GRAPH);
if (g && Array.isArray(g.edges)) {
  for (const e of g.edges) {
    if (e.type === "agent->skill" && e.tier !== "dead") {
      keep.add(e.to.split(":").slice(1).join(":"));
    }
  }
} else {
  let files = [];
  try {
    files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    /* empty */
  }
  for (const f of files) {
    const text = readText(path.join(AGENTS_DIR, f)) || "";
    for (const line of text.split("\n")) {
      const m = CAP_RE.exec(line.trim());
      if (!m) continue;
      for (const raw of m[2].split(/[,;]/)) {
        const s = raw
          .trim()
          .replace(/^["'`]+/, "")
          .replace(/["'`.]+$/, "")
          .trim();
        if (s && ID_RE.test(s) && !/^(none|n\/?a|tbd|-)$/i.test(s)) keep.add(s);
      }
    }
  }
}

// 2) skills.json
const sj = readJSON(path.join(AGENT_ROOT, "skills.json"));
if (sj && Array.isArray(sj.skills)) {
  for (const sk of sj.skills) if (sk && sk.name) keep.add(String(sk.name).trim());
}

// 3) settings.json enabled entries (frontmatter name)
const st = readJSON(path.join(AGENT_ROOT, "settings.json"));
if (st && Array.isArray(st.skills)) {
  for (const e of st.skills) {
    if (typeof e !== "string" || e.startsWith("-")) continue;
    const skillMd = e.endsWith("SKILL.md") ? e : path.join(e, "SKILL.md");
    const nm = fm(readText(skillMd)).name;
    keep.add((nm || path.basename(e.endsWith("SKILL.md") ? path.dirname(e) : e)).trim());
  }
}

const prev = (readText(INDEX) || "")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const next = [...keep].filter(Boolean).sort((a, b) => a.localeCompare(b));
const removed = prev.filter((s) => !keep.has(s));
const added = next.filter((s) => !prev.includes(s));

const report = {
  generatedAt: new Date().toISOString(),
  mode: APPLY ? "apply" : "dry-run",
  previous: prev.length,
  next: next.length,
  removed: removed.length,
  added: added.length,
  removedSample: removed.slice(0, 40),
  addedSample: added.slice(0, 20),
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "compact-skills-index-report.json"), JSON.stringify(report, null, 2));

if (APPLY) {
  const bak = `${INDEX}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (fs.existsSync(INDEX)) fs.copyFileSync(INDEX, bak);
  const body =
    [
      "# Compact skills index — agent-demanded ∪ settings ∪ skills.json",
      `# rebuilt ${report.generatedAt}`,
      "# Do NOT dump the full on-disk universe here; that inflates orphan-active.",
      ...next,
    ].join("\n") + "\n";
  fs.writeFileSync(INDEX, body);
  console.error(`compact-skills-index APPLIED — backup: ${path.basename(bak)}`);
} else {
  console.error("compact-skills-index DRY-RUN");
}
console.error(`  prev=${prev.length} → next=${next.length}  removed=${removed.length}  added=${added.length}`);
console.error(`  report → .omk/harness-graph/out/compact-skills-index-report.json`);
