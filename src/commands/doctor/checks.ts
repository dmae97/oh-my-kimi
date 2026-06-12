import { join, resolve, isAbsolute, dirname } from "path";
import { execSync } from "child_process";
import YAML from "yaml";
import { checkCommand, getKimiVersion, runShell } from "../../util/shell.js";
import { runOmkSafetySelfTest } from "../../util/native-safety.js";
import { getKimiCapabilities } from "../../kimi/capability.js";
import { readdir } from "fs/promises";
import { pathExists, readTextFile, getUserHome, getKimiConfigPath } from "../../util/fs.js";
import { isGitAvailable, getCurrentBranch, getGitStatus } from "../../util/git.js";
import { t } from "../../util/i18n.js";
import { formatBytes } from "../../util/output-buffer.js";
import { getOmkVersionSync } from "../../util/version.js";
import { resolveBundledLspBinary } from "../lsp.js";
import { detectPackageManager } from "../../mcp/quality-gate.js";
import { buildMcpDoctorReport } from "../mcp.js";
import { discoverRoutingInventory } from "../../orchestration/routing/inventory.js";
import { validateProjectAgentYaml, formatAgentYamlIssues } from "../../util/agent-schema.js";
import {
  getGlobalMemoryConfigPath,
  isGraphMemoryBackend,
  loadMemorySettings,
  usesLocalGraphBackend,
  usesKuzuBackend,
} from "../../memory/memory-config.js";
import {
  type CheckResult,
  type OmkResourceSettings,
  isRecord,
  inspectJsonFile,
  isNpmLauncherCommand,
  redactSecrets,
  rootDiagnosticData,
  semverGt,
  isExpectedGlobalKimiFile,
} from "./utils.js";

interface AgentToolDeclarations {
  hasAgentTool: boolean;
  hasSearchWeb: boolean;
  hasFetchURL: boolean;
  usesDefaultToolSurface: boolean;
}

export function rootChecks(resolution: import("../../util/fs.js").ProjectRootResolution): CheckResult[] {
  const data = rootDiagnosticData(resolution);
  const result: CheckResult = {
    name: "Project Root",
    status: resolution.warning ? "warn" : "ok",
    message: `${data.effectiveProjectRoot ?? resolution.root} (source: ${resolution.source})`,
    metadata: data,
  };
  const checks = [result];
  if (resolution.defaultProjectRootError) {
    checks.push({
      name: "Project Root Default",
      status: "warn",
      message: resolution.defaultProjectRootError,
      metadata: {
        source: process.env.OMK_DEFAULT_PROJECT_ROOT ? "OMK_DEFAULT_PROJECT_ROOT" : "user-config",
      },
    });
  }
  return checks;
}

export async function readAgentToolDeclarations(root: string): Promise<AgentToolDeclarations | null> {
  const rootYamlPath = join(root, ".omk", "agents", "root.yaml");
  if (!(await pathExists(rootYamlPath))) return null;
  const tools = new Set<string>();
  const visited = new Set<string>();
  let rawChain = "";
  let sawExplicitTools = false;

  const addTool = (value: string): void => {
    tools.add(value);
    const tail = value.split(/[.:]/).pop();
    if (tail) tools.add(tail);
  };

  const visitAgentFile = async (filePath: string): Promise<void> => {
    const resolved = resolve(filePath);
    if (visited.has(resolved) || !(await pathExists(resolved))) return;
    visited.add(resolved);

    const raw = await readTextFile(resolved, "");
    rawChain += `\n${raw}`;

    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch {
      return;
    }
    const agent = isRecord(parsed) && isRecord(parsed.agent) ? parsed.agent : null;
    if (!agent) return;

    const declaredTools = agent.tools;
    if (Array.isArray(declaredTools)) {
      sawExplicitTools = true;
      for (const tool of declaredTools) {
        if (typeof tool === "string") addTool(tool);
      }
    }

    const extend = typeof agent.extend === "string" ? agent.extend : undefined;
    if (!extend || extend === "default") return;
    const nextPath = isAbsolute(extend) ? extend : resolve(dirname(resolved), extend);
    await visitAgentFile(nextPath);
  };

  await visitAgentFile(rootYamlPath);
  const usesDefaultToolSurface = !sawExplicitTools;
  return {
    usesDefaultToolSurface,
    hasAgentTool: usesDefaultToolSurface || tools.has("Agent") || /\bAgent\b/.test(rawChain),
    hasSearchWeb: usesDefaultToolSurface || tools.has("SearchWeb") || /\bSearchWeb\b/.test(rawChain),
    hasFetchURL: usesDefaultToolSurface || tools.has("FetchURL") || /\bFetchURL\b/.test(rawChain),
  };
}

// ── Runtime ───────────────────────────────────────────────────

export async function runtimeChecks(resources: OmkResourceSettings): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.replace("v", "").split(".")[0], 10);
  results.push({
    name: "Node.js",
    status: nodeMajor >= 20 ? "ok" : "warn",
    message: nodeMajor >= 20 ? `${nodeVersion}` : `${nodeVersion} ${t("doctor.nodeRecommend")}`,
  });

  try {
    const npmVersion = execSync("npm --version", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"], timeout: 5000 }).trim();
    const npmMajor = parseInt(npmVersion.split(".")[0], 10);
    results.push({
      name: "npm",
      status: npmMajor >= 10 ? "ok" : "warn",
      message: npmMajor >= 10 ? `v${npmVersion}` : `v${npmVersion} — npm 10+ recommended`,
    });
  } catch {
    results.push({ name: "npm", status: "warn", message: "Unable to detect npm version" });
  }

  try {
    // npm 10+ removed `npm bin -g`; use `npm prefix -g` exclusively
    const prefix = execSync("npm prefix -g", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"], timeout: 5000 }).trim();
    const npmBin = join(prefix, process.platform === "win32" ? "" : "bin");
    if (npmBin) {
      const pathDelimiter = process.platform === "win32" ? ";" : ":";
      const inPath = process.env.PATH?.split(pathDelimiter).some((p) => p === npmBin || npmBin.startsWith(p));
      results.push({
        name: "npm global bin",
        status: inPath ? "ok" : "warn",
        message: inPath ? npmBin : `${npmBin} not in PATH`,
      });

      // PATH diagnosis: check if omk is in npm global bin but not in PATH
      const omkPath = join(npmBin, "omk");
      if (!inPath && (await pathExists(omkPath))) {
        results.push({
          name: "omk in PATH",
          status: "warn",
          message: `omk found at ${omkPath} but not in PATH — add ${npmBin} to your shell profile`,
        });
      }
    } else {
      results.push({ name: "npm global bin", status: "warn", message: "Unable to detect npm global bin" });
    }
  } catch {
    results.push({ name: "npm global bin", status: "warn", message: "npm bin detection failed" });
  }

  // Runtime availability listing
  const opencodeExists = await checkCommand("opencode");
  const codexExists = await checkCommand("codex");
  const kimiExists = await checkCommand("kimi");
  const openrouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);
  const deepseekConfigured = Boolean(process.env.DEEPSEEK_API_KEY);
  const kimiDisabled = process.env.OMK_KIMI_ENABLED === "0";

  results.push({
    name: "opencode-cli",
    status: opencodeExists ? "ok" : "info",
    message: opencodeExists ? "available" : "not found",
  });
  results.push({
    name: "codex-cli",
    status: codexExists ? "ok" : "info",
    message: codexExists ? "available" : "not found",
  });
  results.push({
    name: "kimi-api",
    status: kimiExists ? "ok" : kimiDisabled ? "info" : "warn",
    message: kimiExists ? "available" : kimiDisabled ? "disabled by OMK_KIMI_ENABLED" : "not found",
  });
  results.push({
    name: "openrouter-api",
    status: openrouterConfigured ? "ok" : "info",
    message: openrouterConfigured ? "OPENROUTER_API_KEY set" : "not configured",
  });
  results.push({
    name: "deepseek-api",
    status: deepseekConfigured ? "ok" : "info",
    message: deepseekConfigured ? "DEEPSEEK_API_KEY set" : "not configured",
  });

  results.push({
    name: "OMK Runtime",
    status: resources.profile === "lite" ? "info" : "ok",
    message: `profile=${resources.profile}, RAM=${resources.totalMemoryGb}GB, workers=${resources.maxWorkers}, buffer=${formatBytes(resources.shellMaxBufferBytes)}`,
  });

  const currentVersion = getOmkVersionSync();
  try {
    const latest = execSync("npm view open-multi-agent-kit version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (latest && semverGt(latest, currentVersion)) {
      results.push({
        name: "OMK Version",
        status: "warn",
        message: `${currentVersion} → ${latest} available. Run: npm i -g open-multi-agent-kit`,
      });
    } else {
      results.push({
        name: "OMK Version",
        status: "ok",
        message: `${currentVersion} (latest)`,
      });
    }
  } catch {
    results.push({
      name: "OMK Version",
      status: "info",
      message: `${currentVersion} (offline or registry unreachable)`,
    });
  }

  return results;
}

// ── Toolchain ─────────────────────────────────────────────────

export async function toolchainChecks(root: string): Promise<CheckResult[]> {
  const [gitAvailable, jqExists, tmuxExists, cargoExists, rustcExists, rustSafetyCrateExists] = await Promise.all([
    isGitAvailable(),
    checkCommand("jq"),
    checkCommand("tmux"),
    checkCommand("cargo"),
    checkCommand("rustc"),
    pathExists(join(root, "crates", "omk-safety", "Cargo.toml")),
  ]);

  const results: CheckResult[] = [];

  // Git checks — semantically distinct for correct JSON output
  results.push({
    name: "Git Installed",
    status: gitAvailable ? "ok" : "fail",
    message: gitAvailable ? "Installed" : t("doctor.gitNotFound"),
  });

  results.push({
    name: "Git Available",
    status: gitAvailable ? "ok" : "fail",
    message: gitAvailable ? "Available" : t("doctor.gitNotFound"),
  });

  if (gitAvailable) {
    const repoCheck = await runShell("git", ["rev-parse", "--git-dir"], { cwd: root, timeout: 5000 });
    const isRepo = !repoCheck.failed;
    const safeDirIssueFromRepoCheck = repoCheck.failed && repoCheck.stderr.includes("safe.directory");

    let repoMessage = isRepo ? "Repository detected" : t("doctor.gitNotRepo");
    if (safeDirIssueFromRepoCheck) {
      repoMessage = `Repository detected but blocked by safe.directory — run: git config --global --add safe.directory "${root}"`;
    }
    results.push({
      name: "Git Repo",
      status: isRepo ? "ok" : "warn",
      message: repoMessage,
    });

    if (isRepo) {
      const [branch, gitStatus] = await Promise.all([getCurrentBranch(), getGitStatus()]);
      results.push({
        name: "Git Clean",
        status: gitStatus.clean ? "ok" : "warn",
        message: t("doctor.gitBranchChanges", branch ?? "?", gitStatus.changes),
      });

      const statusResult = await runShell("git", ["status"], { cwd: root, timeout: 5000 });
      const safeDirIssue = statusResult.failed && statusResult.stderr.includes("safe.directory");
      results.push({
        name: "Git Safe Directory",
        status: safeDirIssue ? "warn" : "ok",
        message: safeDirIssue ? "safe.directory configuration needed" : "no safe.directory issues",
      });
    } else {
      results.push({
        name: "Git Clean",
        status: "info",
        message: "not a git repository",
      });
      results.push({
        name: "Git Safe Directory",
        status: safeDirIssueFromRepoCheck ? "warn" : "info",
        message: safeDirIssueFromRepoCheck ? "safe.directory configuration needed" : "not a git repository",
      });
    }
  } else {
    results.push({
      name: "Git Repo",
      status: "info",
      message: t("doctor.gitNotFound"),
    });
    results.push({
      name: "Git Clean",
      status: "info",
      message: t("doctor.gitNotFound"),
    });
    results.push({
      name: "Git Safe Directory",
      status: "info",
      message: t("doctor.gitNotFound"),
    });
  }

  results.push({
    name: "jq",
    status: jqExists ? "ok" : "fail",
    message: jqExists ? t("doctor.jqInstalled") : t("doctor.jqMissing"),
  });

  results.push({
    name: "tmux",
    status: tmuxExists ? "ok" : "info",
    message: tmuxExists ? t("doctor.tmuxInstalled") : t("doctor.tmuxRecommend"),
  });

  results.push({
    name: "Rust Cargo",
    status: cargoExists ? "ok" : "info",
    message: cargoExists ? "cargo available" : "cargo not found — Rust safety harness checks will be skipped",
  });

  results.push({
    name: "Rust Compiler",
    status: rustcExists ? "ok" : "info",
    message: rustcExists ? "rustc available" : "rustc not found — Rust safety harness checks will be skipped",
  });

  results.push({
    name: "Rust Safety Crate",
    status: rustSafetyCrateExists ? "ok" : "info",
    message: rustSafetyCrateExists ? "crates/omk-safety configured" : "no Rust safety crate configured",
  });

  results.push(await rustSafetyNativeCheck(root));

  const pkgMgr = detectPackageManager(root);
  results.push({ name: "Pkg Manager", status: "ok", message: `${pkgMgr} detected` });

  const tsconfigExists = await pathExists(join(root, "tsconfig.json"));
  results.push({
    name: "TypeScript",
    status: tsconfigExists ? "ok" : "info",
    message: tsconfigExists ? "tsconfig.json found" : "No tsconfig.json — TS project?",
  });

  return results;
}

export async function rustSafetyNativeCheck(root: string): Promise<CheckResult> {
  const result = await runOmkSafetySelfTest({ root });
  return {
    name: "Rust Safety Native",
    status: result.status,
    message: result.message,
    metadata: {
      source: result.source,
      platformArch: result.platformArch,
      builtFromSource: result.builtFromSource,
      path: result.path,
      checks: result.checks,
    },
  };
}

// ── Primary Provider CLI (kimi) ───────────────────────────────

export async function kimiChecks(root: string, resources: OmkResourceSettings): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const kimiExists = await checkCommand("kimi");
  const opencodeExists = await checkCommand("opencode");
  const codexExists = await checkCommand("codex");
  const openrouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);
  const otherRuntimeAvailable = opencodeExists || codexExists || openrouterConfigured;
  const agentTools = await readAgentToolDeclarations(root);
  const agentYamlDeclaresWebTools = Boolean(agentTools?.hasSearchWeb && agentTools.hasFetchURL);

  if (kimiExists) {
    const version = await getKimiVersion();
    results.push({ name: "Primary CLI", status: "ok", message: version ?? t("doctor.kimiInstalled") });
    results.push({
      name: "Primary Runnable",
      status: version ? "ok" : "warn",
      message: version ? t("doctor.kimiRunnable") : t("doctor.kimiRunFailed"),
    });

    // Session indicator check
    try {
      const kimiConfigPath = getKimiConfigPath();
      const kimiConfig = await readTextFile(kimiConfigPath, "");
      const hasIndicators = /default_model|session|credential/.test(kimiConfig);
      results.push({
        name: "Primary Session",
        status: hasIndicators ? "ok" : "warn",
        message: hasIndicators ? "config indicators present" : "provider login may be required",
      });
    } catch {
      results.push({ name: "Primary Session", status: "warn", message: "config read failed" });
    }
  } else {
    const primaryStatus = otherRuntimeAvailable ? "warn" : "fail";
    results.push({ name: "Primary CLI", status: primaryStatus, message: t("doctor.kimiNotFound") });
    results.push({ name: "Primary Install Guide", status: "info", message: "curl -LsSf https://code.kimi.com/install.sh | bash or see https://github.com/dmae97/open_multi-agent_kit#install" });
    results.push({ name: "Primary Capabilities", status: "info", message: "unknown — primary CLI not installed" });
  }

  const kimiConfigPath = getKimiConfigPath();
  const kimiConfigExists = await pathExists(kimiConfigPath);
  results.push({
    name: "Primary Config",
    status: kimiConfigExists ? "ok" : "warn",
    message: kimiConfigExists ? t("doctor.kimiConfigExists") : t("doctor.kimiConfigMissing"),
  });

  if (kimiConfigExists) {
    const kimiContent = await readTextFile(kimiConfigPath, "");
    const hasOmkHooks = kimiContent.includes("# >>> omk managed hooks");
    const projectHooksConfig = await readTextFile(join(root, ".omk", "kimi.config.toml"), "");
    const hasProjectHooks = resources.hooksScope !== "none" && /\[\[hooks\]\]/.test(projectHooksConfig);
    results.push({
      name: "OMK Hooks",
      status: hasOmkHooks || hasProjectHooks ? "ok" : "warn",
      message: hasOmkHooks ? t("doctor.hooksSynced") : hasProjectHooks ? `project hooks active (${resources.hooksScope})` : t("doctor.hooksRecommendSync"),
    });
  }

  // Capability probe
  if (kimiExists) {
    const caps = getKimiCapabilities();
    const supported = [
      caps.model && "model",
      caps.thinking && "thinking",
      caps.temperature && "temperature",
      caps.topP && "top-p",
      caps.variant && "variant",
    ].filter(Boolean);
    results.push({
      name: "Primary Capabilities",
      status: supported.length > 0 ? "ok" : "info",
      message: supported.length > 0 ? supported.join(", ") : "no extended sampling flags",
    });

    results.push({
      name: "Primary Agent File",
      status: caps.agentFile ? "ok" : "warn",
      message: caps.agentFile ? "--agent-file supported" : "--agent-file not detected — update primary CLI",
    });

    const webToolStatus = caps.webTools ? "ok" : agentYamlDeclaresWebTools ? "info" : "warn";
    results.push({
      name: "Primary Web Tools",
      status: webToolStatus,
      message: caps.webTools
        ? "SearchWeb / FetchURL available"
        : agentYamlDeclaresWebTools
          ? "web tool declarations present; CLI help does not expose tool availability"
          : "web search tools not detected — may be unavailable",
    });

    results.push({
      name: "Primary Swarm",
      status: caps.swarmStatus === "available" ? "ok" : caps.swarmStatus === "unavailable" ? "info" : "warn",
      message: caps.swarmStatus === "available"
        ? "K2.6 Agent Swarm platform capability detected"
        : caps.swarmStatus === "unavailable"
          ? "swarm APIs not available in this primary CLI version"
          : "unable to detect swarm capability from version",
    });
  }

  // Agent YAML tools check
  if (agentTools) {
    const { hasAgentTool, hasSearchWeb, hasFetchURL, usesDefaultToolSurface } = agentTools;
    const agentToolStatus = hasAgentTool && hasSearchWeb && hasFetchURL ? "ok" : "warn";
    results.push({
      name: "Agent YAML Tools",
      status: agentToolStatus,
      message: hasAgentTool && hasSearchWeb && hasFetchURL
        ? usesDefaultToolSurface
          ? "agent inheritance includes Agent, SearchWeb, FetchURL via default tool surface"
          : "agent inheritance includes Agent, SearchWeb, FetchURL"
        : `agent inheritance missing tools: ${[!hasAgentTool && "Agent", !hasSearchWeb && "SearchWeb", !hasFetchURL && "FetchURL"].filter(Boolean).join(", ")}`,
    });
  }

  return results;
}

// ── Project ───────────────────────────────────────────────────

export async function projectChecks(root: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const agentsMdPath = join(root, "AGENTS.md");
  const kimiAgentsMdPath = join(root, ".kimi", "AGENTS.md");
  const [agentsMdExists, kimiAgentsMdExists, agentsMdContent, kimiAgentsMdContent] = await Promise.all([
    pathExists(agentsMdPath),
    pathExists(kimiAgentsMdPath),
    readTextFile(agentsMdPath, ""),
    readTextFile(kimiAgentsMdPath, ""),
  ]);
  const agentsMdNonEmpty = agentsMdContent.trim().length > 0;
  const kimiAgentsMdNonEmpty = kimiAgentsMdContent.trim().length > 0;
  results.push({
    name: "AGENTS.md",
    status: agentsMdNonEmpty ? "ok" : agentsMdExists ? "fail" : "warn",
    message: agentsMdNonEmpty
      ? t("doctor.agentsMdExists")
      : agentsMdExists
        ? "AGENTS.md is empty"
        : t("doctor.agentsMdMissing"),
  });
  results.push({
    name: ".kimi/AGENTS.md",
    status: kimiAgentsMdNonEmpty ? "ok" : kimiAgentsMdExists ? "fail" : "warn",
    message: kimiAgentsMdNonEmpty
      ? t("doctor.kimiAgentsMdExists")
      : kimiAgentsMdExists
        ? ".kimi/AGENTS.md is empty"
        : t("doctor.kimiAgentsMdMissing"),
  });

  return results;
}

// ── OMK Scaffold ──────────────────────────────────────────────

export async function omkChecks(root: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const omkDir = join(root, ".omk");
  const omkExists = await pathExists(omkDir);

  results.push({
    name: ".omk dir",
    status: omkExists ? "ok" : "warn",
    message: omkExists ? t("doctor.omkInitialized") : t("doctor.omkInitNeeded"),
  });

  if (omkExists) {
    try {
      const testFile = join(omkDir, ".doctor-write-test");
      const fs = await import("fs/promises");
      await fs.writeFile(testFile, "ok", "utf-8");
      await fs.rm(testFile);
      results.push({ name: ".omk writable", status: "ok", message: "write test passed" });
    } catch {
      results.push({ name: ".omk writable", status: "fail", message: ".omk is not writable" });
    }
  }

  const rootYamlExists = await pathExists(join(omkDir, "agents", "root.yaml"));
  results.push({
    name: "root.yaml",
    status: rootYamlExists ? "ok" : "warn",
    message: rootYamlExists ? t("doctor.rootYamlExists") : t("doctor.rootYamlMissing"),
  });

  const agentYamlPaths = [join(omkDir, "agents", "root.yaml")];
  const rolesDir = join(omkDir, "agents", "roles");
  if (await pathExists(rolesDir)) {
    try {
      const entries = await readdir(rolesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".yaml")) {
          agentYamlPaths.push(join(rolesDir, entry.name));
        }
      }
    } catch { /* ignore */ }
  }
  const agentChecks = await Promise.all(
    agentYamlPaths.map(async (agentPath) => {
      if (!(await pathExists(agentPath))) return { exists: false, extendsOkabe: false };
      const content = await readTextFile(agentPath, "");
      const extendsOkabe = /^\s*extend:\s*(?:\.\.\/|\.)?\/?okabe\.yaml\b/m.test(content);
      return { exists: true, extendsOkabe };
    })
  );
  const totalAgentCount = agentChecks.filter((c) => c.exists).length;
  const okabeAgentCount = agentChecks.filter((c) => c.extendsOkabe).length;
  const okabeBase = await readTextFile(join(omkDir, "agents", "okabe.yaml"), "");
  const okabeBaseHasRequiredTools =
    okabeBase.includes("kimi_cli.tools.agent:Agent") &&
    okabeBase.includes("kimi_cli.tools.dmail:SendDMail") &&
    /^\s*tools:\s*$/m.test(okabeBase);
  results.push({
    name: "Okabe Agents",
    status: totalAgentCount > 0 && okabeAgentCount === totalAgentCount && okabeBaseHasRequiredTools ? "ok" : "warn",
    message: totalAgentCount > 0 && okabeBaseHasRequiredTools
      ? `${okabeAgentCount}/${totalAgentCount} agents inherit okabe.yaml (Agent + SendDMail)`
      : t("doctor.okabeMissing"),
  });

  const rootPromptPath = join(omkDir, "prompts", "root.md");
  let rootPromptValid = false;
  let rootPromptHasAgentsMd = false;
  let rootPromptHasSkills = false;
  if (await pathExists(rootPromptPath)) {
    const rootPrompt = await readTextFile(rootPromptPath, "");
    rootPromptHasAgentsMd = rootPrompt.includes("${KIMI_AGENTS_MD}");
    rootPromptHasSkills = rootPrompt.includes("${KIMI_SKILLS}");
    rootPromptValid = rootPromptHasAgentsMd && rootPromptHasSkills;
  }
  results.push({
    name: "Root Prompt",
    status: rootPromptValid ? "ok" : "warn",
    message: rootPromptValid
      ? t("doctor.rootPromptInjected")
      : t("doctor.rootPromptPartial", !rootPromptHasAgentsMd ? "AGENTS_MD " : "", !rootPromptHasSkills ? "SKILLS" : ""),
  });

  const hooksDir = join(omkDir, "hooks");
  let hooksExecutable = true;
  if (await pathExists(hooksDir)) {
    try {
      const fs = await import("fs/promises");
      const entries = await fs.readdir(hooksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".sh")) {
          const stat = await fs.stat(join(hooksDir, entry.name));
          if ((stat.mode & 0o111) === 0) hooksExecutable = false;
        }
      }
    } catch { /* ignore */ }
  }
  results.push({
    name: "Hooks Exec",
    status: hooksExecutable ? "ok" : "warn",
    message: hooksExecutable ? t("doctor.hooksExecutable") : t("doctor.hooksNotExecutable"),
  });

  return results;
}

export async function agentYamlChecks(root: string): Promise<CheckResult[]> {
  const report = await validateProjectAgentYaml(root);
  if (report.errors.length > 0) {
    return [{
      name: "Agent YAML Schema",
      status: "fail",
      message: formatAgentYamlIssues(report),
      metadata: {
        errors: report.errors.map((item) => `${item.file}: ${item.message}`),
        warnings: report.warnings.map((item) => `${item.file}: ${item.message}`),
      },
    }];
  }
  if (
    report.warnings.length === 1 &&
    report.warnings[0]?.code === "project-agents-not-initialized"
  ) {
    return [{
      name: "Agent YAML Schema",
      status: "info",
      message: report.warnings[0].message,
      metadata: {
        warnings: report.warnings.map((item) => `${item.file}: ${item.message}`),
      },
    }];
  }
  if (report.warnings.length > 0) {
    return [{
      name: "Agent YAML Schema",
      status: "warn",
      message: formatAgentYamlIssues(report),
      metadata: {
        warnings: report.warnings.map((item) => `${item.file}: ${item.message}`),
      },
    }];
  }
  return [{ name: "Agent YAML Schema", status: "ok", message: "agent YAML schema is valid" }];
}

// ── MCP & Skills ──────────────────────────────────────────────

export async function mcpSkillsChecks(root: string, resources: OmkResourceSettings): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const kimiSkillsDir = join(root, ".kimi", "skills");
  const agentsSkillsDir = join(root, ".agents", "skills");
  const projectKimiMcpPath = join(root, ".kimi", "mcp.json");
  const omkMcpPath = join(root, ".omk", "mcp.json");
  const globalMcpPath = join(getUserHome(), ".kimi", "mcp.json");
  const [projectKimiMcp, omkMcp, globalMcp, kimiSkillsCount, agentsSkillsCount] = await Promise.all([
    inspectJsonFile(projectKimiMcpPath),
    inspectJsonFile(omkMcpPath),
    inspectJsonFile(globalMcpPath),
    (async () => {
      if (!(await pathExists(kimiSkillsDir))) return 0;
      try {
        const fs = await import("fs/promises");
        const entries = await fs.readdir(kimiSkillsDir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).length;
      } catch { return 0; }
    })(),
    (async () => {
      if (!(await pathExists(agentsSkillsDir))) return 0;
      try {
        const fs = await import("fs/promises");
        const entries = await fs.readdir(agentsSkillsDir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).length;
      } catch { return 0; }
    })(),
  ]);
  results.push({
    name: "Project MCP",
    status: projectKimiMcp.exists ? "ok" : "info",
    message: projectKimiMcp.exists ? t("doctor.mcpExists") : t("doctor.mcpMissing"),
  });
  results.push({
    name: "OMK MCP",
    status: resources.mcpScope === "none" ? "info" : "ok",
    message: resources.mcpScope === "none"
      ? "omk-project virtual runtime MCP injection disabled by MCP scope none"
      : "omk-project virtual runtime MCP injected at chat/runtime startup (not written to project/global MCP files)",
  });
  const activeDiagnostics = resources.mcpScope === "all" ? [omkMcp, projectKimiMcp, globalMcp] : [omkMcp, projectKimiMcp];
  for (const diagnostic of activeDiagnostics) {
    if (!diagnostic.exists || diagnostic.valid) continue;
    results.push({
      name: "MCP JSON",
      status: "fail",
      message: `${diagnostic.path}: ${diagnostic.error ?? "Invalid JSON"}`,
    });
  }
  if (globalMcp.exists && !globalMcp.valid && resources.mcpScope !== "all") {
    results.push({
      name: "Global MCP JSON",
      status: "info",
      message: `${globalMcp.path}: invalid but inactive in project MCP scope`,
    });
  }
  results.push({
    name: ".kimi/skills",
    status: kimiSkillsCount > 0 ? "ok" : "warn",
    message: kimiSkillsCount > 0 ? t("doctor.skillsExist", kimiSkillsCount) : t("doctor.skillsMissing"),
  });
  results.push({
    name: ".agents/skills",
    status: agentsSkillsCount > 0 ? "ok" : "warn",
    message: agentsSkillsCount > 0 ? t("doctor.agentSkillsExist", agentsSkillsCount) : t("doctor.agentSkillsMissing"),
  });

  const lspConfigPath = join(root, ".omk", "lsp.json");
  const tsLspBinary = resolveBundledLspBinary("typescript");
  const [lspConfigExists, tsLspAvailable] = await Promise.all([
    pathExists(lspConfigPath),
    tsLspBinary.includes("/") || tsLspBinary.includes("\\")
      ? pathExists(tsLspBinary)
      : checkCommand(tsLspBinary),
  ]);
  let lspConfigValid = false;
  if (lspConfigExists) {
    try {
      const parsed = JSON.parse(await readTextFile(lspConfigPath, "{}")) as {
        enabled?: boolean;
        servers?: Record<string, unknown>;
      };
      lspConfigValid = parsed.enabled === true && typeof parsed.servers?.typescript === "object";
    } catch { /* ignore */ }
  }
  results.push({
    name: "Built-in LSP",
    status: lspConfigValid && tsLspAvailable ? "ok" : "warn",
    message: lspConfigValid && tsLspAvailable
      ? `.omk/lsp.json + TypeScript LSP (${tsLspBinary})`
      : t("doctor.lspMissing"),
  });

  let globalMcpCount = 0;
  const stdioMcpServers: string[] = [];
  const npxMcpServers: string[] = [];
  if (globalMcp.valid) {
    const content = await readTextFile(globalMcpPath, "{}");
    const parsed = redactSecrets(JSON.parse(content)) as {
      mcpServers?: Record<string, { command?: string; type?: string }>;
    };
    const servers: Record<string, { command?: string; type?: string }> = parsed.mcpServers ?? {};
    globalMcpCount = Object.keys(servers).length;
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg.type === "stdio" || !cfg.type) {
        stdioMcpServers.push(name);
        if (isNpmLauncherCommand(cfg.command)) {
          npxMcpServers.push(name);
        }
      }
    }
  }
  results.push({
    name: "Global MCP",
    status: globalMcp.valid && globalMcpCount > 0 ? "ok" : resources.mcpScope === "all" ? "warn" : "info",
    message: globalMcp.valid && globalMcpCount > 0
      ? t("doctor.globalMcpSynced", globalMcpCount)
      : resources.mcpScope === "all"
        ? t("doctor.globalMcpMissing")
        : `${t("doctor.globalMcpMissing")} (optional in project MCP scope)`,
  });
  if (stdioMcpServers.length > 0) {
    results.push({
      name: "Global MCP (stdio)",
      status: npxMcpServers.length > 0 ? "warn" : "info",
      message:
        `${stdioMcpServers.join(", ")} — ` +
        (npxMcpServers.length > 0
          ? `npx-based servers (${npxMcpServers.join(", ")}) may fail to connect and crash the primary provider sessions. Remove or fix them in ~/.kimi/mcp.json if unused.`
          : "stdio servers detected. Ensure they are available."),
    });
  }

  const globalSkillsDir = join(getUserHome(), ".kimi", "skills");
  const globalSkillsExists = await pathExists(globalSkillsDir);
  let globalSkillCount = 0;
  if (globalSkillsExists) {
    try {
      const fs = await import("fs/promises");
      const entries = await fs.readdir(globalSkillsDir, { withFileTypes: true });
      globalSkillCount = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).length;
    } catch { /* ignore */ }
  }
  results.push({
    name: "Global Skills",
    status: globalSkillCount > 0 ? "ok" : "info",
    message: globalSkillCount > 0 ? t("doctor.globalSkillsSynced", globalSkillCount) : t("doctor.globalSkillsMissing"),
  });

  try {
    const mcpDoctor = await buildMcpDoctorReport();
    results.push({
      name: "MCP Doctor",
      status: mcpDoctor.ok ? "ok" : "fail",
      message: mcpDoctor.ok
        ? `activeScope=${mcpDoctor.activeScope}, servers=${mcpDoctor.servers.length}`
        : `${mcpDoctor.issueCount} issue(s): ${mcpDoctor.errors[0] ?? "MCP diagnostics failed"}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "MCP Doctor", status: "fail", message });
  }

  // Advanced: routing inventory discovery (uses skills + mcp)
  try {
    const inventory = discoverRoutingInventory(root);
    const skillNames = [...inventory.skills.keys()];
    const mcpNames = [...inventory.mcpServers.keys()];
    const toolNames = [...inventory.tools];
    results.push({
      name: "Routing",
      status: "ok",
      message: `${skillNames.length} skills, ${mcpNames.length} MCPs, ${toolNames.length} tools discovered`,
    });
  } catch {
    results.push({ name: "Routing", status: "warn", message: "routing inventory discovery failed" });
  }

  return results;
}

// ── Memory ────────────────────────────────────────────────────

export async function memoryChecks(root: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const globalMemoryConfigPath = getGlobalMemoryConfigPath();
  const globalKimiDir = join(getUserHome(), ".kimi");
  const [globalMemoryConfigExists, memorySettings, globalKimiDirExists] = await Promise.all([
    pathExists(globalMemoryConfigPath),
    loadMemorySettings(root),
    pathExists(globalKimiDir),
  ]);

  results.push({
    name: "Global Memory",
    status: globalMemoryConfigExists ? "ok" : isGraphMemoryBackend(memorySettings.backend) ? "info" : "warn",
    message: globalMemoryConfigExists
      ? t("doctor.memorySynced")
      : isGraphMemoryBackend(memorySettings.backend)
        ? `${t("doctor.memoryMissing")} (optional with ${memorySettings.backend} backend)`
        : t("doctor.memoryMissing"),
  });

  results.push({
    name: "Graph Memory",
    status: isGraphMemoryBackend(memorySettings.backend) ? "ok" : "info",
    message: isGraphMemoryBackend(memorySettings.backend)
      ? usesLocalGraphBackend(memorySettings.backend)
        ? `backend=local_graph, ontology=${memorySettings.localGraph.ontology}, state=${memorySettings.localGraph.path}`
        : usesKuzuBackend(memorySettings.backend)
          ? `backend=kuzu, path=${join(memorySettings.project.root, ".omk", "memory", "kuzu.db")}, project=${memorySettings.project.key}`
          : `backend=${memorySettings.backend}, project=${memorySettings.project.key}`
      : t("doctor.memoryFileBackend"),
  });

  let globalPollution = false;
  if (globalKimiDirExists) {
    try {
      const fs = await import("fs/promises");
      const entries = await fs.readdir(globalKimiDir, { withFileTypes: true });
      const unexpected = entries.filter((e) => e.isFile() && !isExpectedGlobalKimiFile(e.name)).map((e) => e.name);
      if (unexpected.length > 0) globalPollution = true;
    } catch { /* ignore */ }
  }
  results.push({
    name: "Global Pollution",
    status: globalPollution ? "warn" : "ok",
    message: globalPollution ? t("doctor.globalPollution") : t("doctor.globalClean"),
  });

  return results;
}

// ── Security ──────────────────────────────────────────────────

export async function securityChecks(root: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const configPath = join(root, ".omk", "config.toml");
  const configExists = await pathExists(configPath);

  results.push({
    name: "Child Env Isolation",
    status: "ok",
    message: "parent env not inherited by default; secret-like env drops require explicit grants",
    metadata: {
      inheritEnv: false,
      secretEnvPolicy: "drop-by-default",
      explicitSecretGrants: true,
    },
  });

  results.push({
    name: "Sandbox Enforcement",
    status: "info",
    message: "env-only active; OS-level filesystem, process, and network sandboxing is not enforced",
    metadata: {
      enforcement: "env-only",
      osSandbox: "not-enforced",
      networkPolicy: "not-enforced",
    },
  });

  if (!configExists) {
    results.push({ name: "Config Audit", status: "info", message: ".omk/config.toml not found" });
    return results;
  }

  const config = await readTextFile(configPath, "");
  const warnings: string[] = [];

  if (/^\s*yolo_mode\s*=\s*true\b/m.test(config)) {
    warnings.push("yolo_mode=true");
  }

  const approvalMatch = config.match(/^approval_policy\s*=\s*"([^"]+)"/m);
  const approvalPolicy = approvalMatch?.[1]?.trim();
  if (approvalPolicy === "yolo") {
    warnings.push("approval_policy=yolo");
  }

  if (process.env.OMK_TRUST_ABSOLUTE_LOGO_PATH) {
    warnings.push("OMK_TRUST_ABSOLUTE_LOGO_PATH set");
  }

  if (/^\s*allow_write_config\s*=\s*true\b/m.test(config)) {
    warnings.push("allow_write_config=true");
  }

  if (warnings.length > 0) {
    results.push({
      name: "Dangerous Config",
      status: "warn",
      message: warnings.join(", ") + " — review security implications",
    });
  } else {
    results.push({
      name: "Dangerous Config",
      status: "ok",
      message: "no dangerous settings detected",
    });
  }

  return results;
}
