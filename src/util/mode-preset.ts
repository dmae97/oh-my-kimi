/**
 * Mode-preset system for open_multi-agent_kit.
 *
 * Three tabs/modes:
 *   - agent   : interactive orchestrator (execution choice → plan → execute/review)
 *   - plan    : plan-only mode — generates enriched prompt & plan, waits for user approval
 *   - chat    : chat-only mode — GPT-like conversation without code modification
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { getProjectRoot } from "./fs.js";

export type OmkMode = "agent" | "plan" | "chat" | "debugging" | "review";

export interface ModePreset {
  name: OmkMode;
  label: string;
  description: string;
  icon: string;
  behavior: {
    autoExecute: boolean;
    planOnly: boolean;
    chatOnly: boolean;
    requireApproval: boolean;
    useDag: boolean;
  };
  /** Default CLI command launched when this mode is selected from the TTY selector. */
  launchCommand: "chat" | "parallel" | "menu" | "review" | "doctor";
}

const PRESETS: ModePreset[] = [
  {
    name: "agent",
    label: "Agent Orchestrator",
    description: "Interactive orchestrator: asks parallel vs one-by-one, then coordinates plan/run/review",
    icon: "◇",
    behavior: {
      autoExecute: true,
      planOnly: false,
      chatOnly: false,
      requireApproval: false,
      useDag: true,
    },
    launchCommand: "chat",
  },
  {
    name: "plan",
    label: "Plan",
    description: "Plan-only mode: generates plan and enriched prompt, waits for your approval before executing",
    icon: "▣",
    behavior: {
      autoExecute: false,
      planOnly: true,
      chatOnly: false,
      requireApproval: true,
      useDag: false,
    },
    launchCommand: "menu",
  },
  {
    name: "chat",
    label: "Chat",
    description: "Chat-only mode: conversation about the project without code modification",
    icon: "◌",
    behavior: {
      autoExecute: false,
      planOnly: false,
      chatOnly: true,
      requireApproval: false,
      useDag: false,
    },
    launchCommand: "chat",
  },
  {
    name: "debugging",
    label: "Debug",
    description: "Debugging mode: focused on bug reproduction, root-cause analysis, and minimal fixes",
    icon: "⟁",
    behavior: {
      autoExecute: true,
      planOnly: false,
      chatOnly: false,
      requireApproval: false,
      useDag: true,
    },
    launchCommand: "chat",
  },
  {
    name: "review",
    label: "Review",
    description: "Review mode: focused on code audit, security scan, and quality assessment",
    icon: "◆",
    behavior: {
      autoExecute: true,
      planOnly: false,
      chatOnly: false,
      requireApproval: false,
      useDag: true,
    },
    launchCommand: "chat",
  },
];

const MODE_CONFIG_KEY = "mode.preset";

export function getModePresets(): ModePreset[] {
  return PRESETS;
}

export function getModePreset(mode: OmkMode): ModePreset | undefined {
  return PRESETS.find((p) => p.name === mode);
}

export function isValidMode(mode: string): mode is OmkMode {
  if (mode === "default") return true; // backward compatibility
  return PRESETS.some((p) => p.name === mode);
}

export async function getCurrentMode(): Promise<OmkMode> {
  const envMode = process.env.OMK_MODE;
  if (envMode) {
    if (envMode === "default") return "agent"; // backward compatibility
    if (isValidMode(envMode)) return envMode;
  }

  const config = await readSimpleToml(join(getProjectRoot(), ".omk", "config.toml"));
  const cfg = config[MODE_CONFIG_KEY];
  if (cfg) {
    if (cfg === "default") return "agent"; // backward compatibility
    if (isValidMode(cfg)) return cfg;
  }

  return "agent";
}

export async function setCurrentMode(mode: OmkMode): Promise<void> {
  const root = getProjectRoot();
  const configPath = join(root, ".omk", "config.toml");
  let content = "";
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    // config.toml does not exist yet
  }

  const newContent = upsertConfigValue(content, "mode", "preset", mode);
  await writeFile(configPath, newContent, "utf-8");
}

/** Read a simple TOML file into a flat record. */
async function readSimpleToml(path: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(path, "utf-8");
    return parseSimpleToml(content);
  } catch {
    return {};
  }
}

function parseSimpleToml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  let section = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = section ? `${section}.${kv[1].trim()}` : kv[1].trim();
    result[key] = normalizeTomlValue(kv[2].trim());
  }
  return result;
}

function stripComment(line: string): string {
  // naive: remove everything after first unquoted #
  let inString = false;
  let quoteChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!inString && (ch === '"' || ch === "'")) {
      inString = true;
      quoteChar = ch;
    } else if (inString && ch === quoteChar && line[i - 1] !== "\\") {
      inString = false;
    } else if (!inString && ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function normalizeTomlValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function upsertConfigValue(content: string, section: string, key: string, value: string): string {
  const sectionHeader = `[${section}]`;
  const lineToSet = `${key} = "${value}"`;

  // If file is empty, just write the section
  if (!content.trim()) {
    return `${sectionHeader}\n${lineToSet}\n`;
  }

  const lines = content.split(/\r?\n/);
  const sectionIdx = lines.findIndex((l) => l.trim() === sectionHeader);

  if (sectionIdx === -1) {
    // Section does not exist — append at the end
    return content.trimEnd() + "\n\n" + sectionHeader + "\n" + lineToSet + "\n";
  }

  // Section exists — look for existing key
  let keyIdx = -1;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[")) break; // next section
    const kv = trimmed.match(new RegExp(`^${key}\\s*=`));
    if (kv) {
      keyIdx = i;
      break;
    }
  }

  if (keyIdx !== -1) {
    lines[keyIdx] = lineToSet;
  } else {
    // Insert at the end of the section (before next section or end)
    let insertIdx = lines.length;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith("[")) {
        insertIdx = i;
        break;
      }
    }
    lines.splice(insertIdx, 0, lineToSet);
  }

  return lines.join("\n") + "\n";
}
