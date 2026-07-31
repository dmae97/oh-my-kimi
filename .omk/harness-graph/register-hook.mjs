#!/usr/bin/env node
// Register the harness-graph session-drift-audit hook into ~/.omk/agent/hooks.json.
// Idempotent; backs up hooks.json first. Session restart required to take effect.
//
// Usage: node register-hook.mjs [--apply]   (default dry-run)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const APPLY = process.argv.includes("--apply");
const HOOKS = path.join(HOME, ".omk/agent/hooks.json");
const HG = path.join(process.cwd(), ".omk/harness-graph");

let cfg;
try { cfg = JSON.parse(fs.readFileSync(HOOKS, "utf8")); }
catch (e) { console.error(`cannot read hooks.json: ${e.message}`); process.exit(1); }
cfg.hooks ||= {};

const entry = {
  pluginRoot: HG,
  hooksDir: path.join(HG, "hooks"),
  enabled: true,
  hooks: {
    sessionStart: {
      script: "session-drift-audit.sh",
      trigger: "session_start",
      description: "Snapshot harness graph drift each session; surface dead/inactive/drift alerts",
    },
  },
};

const already = JSON.stringify(cfg.hooks["harness-graph"]) === JSON.stringify(entry);
if (already) { console.log("harness-graph hook already registered (no change)"); process.exit(0); }

if (APPLY) {
  const bak = `${HOOKS}.bak-harness-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(HOOKS, bak);
  cfg.hooks["harness-graph"] = entry;
  fs.writeFileSync(HOOKS, JSON.stringify(cfg, null, 1) + "\n");
  console.log(`hook registered -> ${path.relative(HOME, HOOKS)} (backup: ${path.basename(bak)})`);
  console.log("  ⚠ session restart required to activate");
} else {
  console.log("DRY-RUN — would register 'harness-graph' sessionStart hook:");
  console.log("  script: hooks/session-drift-audit.sh  trigger: session_start");
}
