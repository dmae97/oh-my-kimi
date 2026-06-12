// ─── OMK Consent CLI ────────────────────────────────────────────────────────
// Dataset consent management: status, preview, enable, disable, revoke, export
//
// Consent levels:
//   L0 — ops stats (anonymous usage metrics)
//   L1 — trace meta (intent, model, duration)
//   L2 — trajectory (tool calls, diffs, test results)
//   L3 — sample pack (redacted, per-case approval)
//   L4 — raw code (FORBIDDEN — never collected)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

export type ConsentLevel = "l0" | "l1" | "l2" | "l3";

export interface ConsentState {
  l0: boolean; // ops stats
  l1: boolean; // trace meta
  l2: boolean; // trajectory
  l3: "off" | "per-case" | "auto"; // sample pack
  updatedAt: string;
}

export interface ConsentPreview {
  level: ConsentLevel;
  description: string;
  sampleData: string[];
  redactionApplied: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CONSENT_DIR = join(homedir(), ".omk");
const CONSENT_FILE = join(CONSENT_DIR, "consent.json");

const LEVEL_DESCRIPTIONS: Record<ConsentLevel, string> = {
  l0: "Anonymous usage metrics (command counts, session duration)",
  l1: "Trace metadata (intent, model, duration, success/failure)",
  l2: "Coding trajectory (tool calls, diffs, test results — no raw source)",
  l3: "Sample pack (redacted trajectory for K-Coding Dataset — per-case approval)",
};

const LEVEL_NAMES: Record<ConsentLevel, string> = {
  l0: "Ops Stats",
  l1: "Trace Meta",
  l2: "Trajectory",
  l3: "Sample Pack",
};

// ── Storage ────────────────────────────────────────────────────────────────

export function loadConsentState(): ConsentState {
  try {
    if (existsSync(CONSENT_FILE)) {
      const raw = readFileSync(CONSENT_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // Corrupted file — return defaults
  }
  return defaultConsentState();
}

export function saveConsentState(state: ConsentState): void {
  mkdirSync(CONSENT_DIR, { recursive: true });
  writeFileSync(CONSENT_FILE, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function defaultConsentState(): ConsentState {
  return {
    l0: false,
    l1: false,
    l2: false,
    l3: "off",
    updatedAt: new Date().toISOString(),
  };
}

// ── Commands ───────────────────────────────────────────────────────────────

export function consentStatus(): void {
  const state = loadConsentState();

  console.log("");
  console.log("  ╭─── OMK Consent Status ────────────────────────╮");
  console.log("  │                                               │");
  console.log(`  │  L0 Ops Stats    ${state.l0 ? "✓ ON " : "✗ OFF"}                       │`);
  console.log(`  │  L1 Trace Meta   ${state.l1 ? "✓ ON " : "✗ OFF"}                       │`);
  console.log(`  │  L2 Trajectory   ${state.l2 ? "✓ ON " : "✗ OFF"}                       │`);
  console.log(`  │  L3 Sample Pack  ${state.l3 === "off" ? "✗ OFF" : state.l3 === "per-case" ? "◐ PER-CASE" : "✓ AUTO"}                     │`);
  console.log(`  │  L4 Raw Code     ✗ FORBIDDEN                  │`);
  console.log("  │                                               │");
  console.log("  ╰───────────────────────────────────────────────╯");
  console.log("");
  console.log(`  Updated: ${state.updatedAt}`);
  console.log("");
  console.log("  Commands:");
  console.log("    omk consent enable <level>   Opt in to a level");
  console.log("    omk consent disable <level>  Opt out of a level");
  console.log("    omk consent preview          See what would be shared");
  console.log("    omk consent export           Export your consent record");
  console.log("    omk consent revoke           Revoke all consent");
  console.log("");
}

export function consentEnable(level: ConsentLevel): void {
  if (level === "l3") {
    console.log("");
    console.log("  L3 Sample Pack requires per-case approval.");
    console.log("  Use: omk consent enable l3 per-case");
    console.log("");
    return;
  }

  const state = loadConsentState();
  state[level] = true;
  state.updatedAt = new Date().toISOString();
  saveConsentState(state);

  console.log("");
  console.log(`  ✓ ${LEVEL_NAMES[level]} (${level}) enabled`);
  console.log(`    ${LEVEL_DESCRIPTIONS[level]}`);
  console.log("");
  console.log("  To disable: omk consent disable " + level);
  console.log("");
}

export function consentDisable(level: ConsentLevel): void {
  const state = loadConsentState();
  if (level === "l3") {
    state.l3 = "off";
  } else {
    state[level] = false;
  }
  state.updatedAt = new Date().toISOString();
  saveConsentState(state);

  console.log("");
  console.log(`  ✓ ${LEVEL_NAMES[level]} (${level}) disabled`);
  console.log("");
}

export function consentPreview(): void {
  const state = loadConsentState();
  const enabled: ConsentLevel[] = [];
  if (state.l0) enabled.push("l0");
  if (state.l1) enabled.push("l1");
  if (state.l2) enabled.push("l2");
  if (state.l3 !== "off") enabled.push("l3");

  console.log("");
  console.log("  ╭─── Consent Preview ──────────────────────────╮");
  console.log("  │  What would be shared with current settings:  │");
  console.log("  ╰──────────────────────────────────────────────╯");
  console.log("");

  if (enabled.length === 0) {
    console.log("  Nothing. All consent levels are OFF.");
    console.log("  OMK operates fully locally with no data sharing.");
    console.log("");
    return;
  }

  for (const level of enabled) {
    console.log(`  ${LEVEL_NAMES[level]} (${level}):`);
    console.log(`    ${LEVEL_DESCRIPTIONS[level]}`);

    // Sample data preview
    const samples = getSampleData(level);
    for (const s of samples) {
      console.log(`    · ${s}`);
    }
    console.log("");
  }

  console.log("  Redaction rules:");
  console.log("    · Raw source code is NEVER shared (L4 forbidden)");
  console.log("    · File paths are anonymized to project-relative hashes");
  console.log("    · API keys, .env values, secrets are stripped");
  console.log("    · Personal identifiers are removed");
  console.log("");
  console.log("  To revoke all: omk consent revoke");
  console.log("");
}

export function consentRevoke(): void {
  const state = defaultConsentState();
  saveConsentState(state);

  console.log("");
  console.log("  ✓ All consent revoked.");
  console.log("  All levels set to OFF. No data will be shared.");
  console.log("");
  console.log("  To re-enable: omk consent enable <level>");
  console.log("");
}

export function consentExport(): void {
  const state = loadConsentState();

  console.log("");
  console.log("  ╭─── Consent Record ──────────────────────────╮");
  console.log(JSON.stringify(state, null, 2).split("\n").map(l => "  │  " + l).join("\n"));
  console.log("  ╰─────────────────────────────────────────────╯");
  console.log("");
  console.log(`  File: ${CONSENT_FILE}`);
  console.log("");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getSampleData(level: ConsentLevel): string[] {
  switch (level) {
    case "l0":
      return [
        "session_count: 47",
        "avg_duration_min: 12.3",
        "commands_used: chat(31), run(8), status(8)",
      ];
    case "l1":
      return [
        "intent: code_edit | model: deepseek-flash | duration: 8.2s | result: success",
        "intent: debug_error | model: kimi-code | duration: 45.1s | result: failure",
      ];
    case "l2":
      return [
        "tool: read_file → src/auth/login.ts (lines 1-50)",
        "tool: edit_file → added 3 lines, removed 1 line",
        "tool: exec → 'npm test' → exit 0, 12/12 passing",
      ];
    case "l3":
      return [
        "redacted_trajectory_id: tr_abc123",
        "task: 'add dark mode toggle' | steps: 3 | tools: 7 | tests: 4/4",
        "preference: user preferred functional component over class",
      ];
  }
}

// ── Register ───────────────────────────────────────────────────────────────

export function registerConsentCommand(program: import("commander").Command): void {
  const consent = program
    .command("consent")
    .description("Manage dataset consent levels (L0-L4)");

  consent
    .command("status")
    .description("Show current consent settings")
    .action(() => consentStatus());

  consent
    .command("enable")
    .description("Enable a consent level")
    .argument("<level>", "Consent level: l0, l1, l2, l3")
    .option("--per-case", "For L3: enable per-case approval mode")
    .action((level: string, opts: { perCase?: boolean }) => {
      const lv = level.toLowerCase() as ConsentLevel;
      if (!["l0", "l1", "l2", "l3"].includes(lv)) {
        console.error(`  Invalid level: ${level}. Use l0, l1, l2, or l3.`);
        process.exit(1);
      }
      if (lv === "l3" && opts.perCase) {
        const state = loadConsentState();
        state.l3 = "per-case";
        state.updatedAt = new Date().toISOString();
        saveConsentState(state);
        console.log("\n  ✓ L3 Sample Pack set to per-case approval\n");
        return;
      }
      consentEnable(lv);
    });

  consent
    .command("disable")
    .description("Disable a consent level")
    .argument("<level>", "Consent level: l0, l1, l2, l3")
    .action((level: string) => {
      const lv = level.toLowerCase() as ConsentLevel;
      if (!["l0", "l1", "l2", "l3"].includes(lv)) {
        console.error(`  Invalid level: ${level}. Use l0, l1, l2, or l3.`);
        process.exit(1);
      }
      consentDisable(lv);
    });

  consent
    .command("preview")
    .description("Preview what data would be shared")
    .action(() => consentPreview());

  consent
    .command("export")
    .description("Export your consent record")
    .action(() => consentExport());

  consent
    .command("revoke")
    .description("Revoke all consent (set all levels to OFF)")
    .action(() => consentRevoke());
}