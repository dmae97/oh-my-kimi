#!/usr/bin/env node
// Safe catalog housekeeping — removes STALE DISABLED entries from settings.json.skills:
// entries that are already disabled ("-" prefix) AND whose target SKILL.md no longer exists.
// This is the only provably-safe prune: they are off and gone. Backs up settings.json first.
//
// NOTE: orphan-active skills are NOT pruned here — that would remove root/command-triggered
// skills (e.g. system-prompts-leaks appears orphan-to-agents but is used by the root). See
// out/orphan-triage.md for the human-review list.
//
// Usage: node prune-catalog.mjs [--apply]   (default dry-run)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const APPLY = process.argv.includes("--apply");
const SETTINGS = path.join(HOME, ".omk/agent/settings.json");
const RUNS = path.join(process.cwd(), ".omk/runs/harness-graph");

let s;
try { s = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); }
catch (e) { console.error(`cannot read settings.json: ${e.message}`); process.exit(1); }
if (!Array.isArray(s.skills)) { console.error("settings.skills is not an array"); process.exit(1); }

const stale = [];
const kept = s.skills.filter((e) => {
  if (typeof e === "string" && e.startsWith("-")) {
    const target = e.slice(1);
    if (!fs.existsSync(target)) { stale.push(e); return false; }
  }
  return true;
});

fs.mkdirSync(RUNS, { recursive: true });
fs.writeFileSync(path.join(RUNS, "prune-stale-disabled.json"),
  JSON.stringify({ ts: new Date().toISOString(), mode: APPLY ? "apply" : "dry-run", removed: stale }, null, 2));

if (APPLY && stale.length) {
  const bak = `${SETTINGS}.bak-prune-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(SETTINGS, bak);
  s.skills = kept;
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
  console.log(`pruned ${stale.length} stale disabled entries -> settings.json (backup: ${path.basename(bak)})`);
} else {
  console.log(`${APPLY ? "APPLIED" : "DRY-RUN"} — stale disabled entries: ${stale.length}`);
}
for (const e of stale.slice(0, 15)) console.log("  -", e.slice(1));
