import { style, status, header, separator } from "../../util/theme.js";
import { t } from "../../util/i18n.js";
import { maybePromptForOmkUpdate } from "../../util/update-check.js";
import {
  type CheckResult,
  type DoctorOptions,
  type OmkResourceSettings,
  rootDiagnosticData,
} from "./utils.js";
import { type DoctorFixReport } from "./fix-plan.js";

export function emitDoctorJsonReport(
  allResults: CheckResult[],
  rootResolution: import("../../util/fs.js").ProjectRootResolution,
  resources: OmkResourceSettings,
  fixes: DoctorFixReport | undefined,
  options: DoctorOptions
): void {
  const find = (name: string) => allResults.find((r) => r.name === name);
  const findMsg = (name: string) => find(name)?.message ?? null;
  const findOk = (name: string) => find(name)?.status === "ok";
  const findMeta = (name: string, key: string) => find(name)?.metadata?.[key] ?? null;

  const warnings = allResults
    .filter((r) => r.status === "warn")
    .map((r) => ({ name: r.name, message: r.message }));
  const errors = allResults
    .filter((r) => r.status === "fail")
    .map((r) => ({ name: r.name, message: r.message }));
  const info = allResults
    .filter((r) => r.status === "info")
    .map((r) => ({ name: r.name, message: r.message }));

  const data = {
    root: rootDiagnosticData(rootResolution),
    environment: {
      platform: process.platform,
      arch: process.arch,
      omkRuntime: {
        profile: resources.profile,
        ramGb: resources.totalMemoryGb,
        workers: resources.maxWorkers,
        bufferBytes: resources.shellMaxBufferBytes,
      },
      npmGlobalBin: findMsg("npm global bin"),
    },
    kimi: {
      installed: findOk("Primary CLI"),
      version: findMsg("Primary CLI"),
      runnable: findOk("Primary Runnable"),
      session: findMsg("Primary Session"),
      config: findOk("Primary Config"),
      hooks: findOk("OMK Hooks"),
      capabilities: findMsg("Primary Capabilities"),
      agentFile: findOk("Primary Agent File"),
      webTools: findOk("Primary Web Tools"),
      swarmStatus: findMsg("Primary Swarm"),
      installGuide: "curl -LsSf https://code.kimi.com/install.sh | bash or see https://github.com/dmae97/open_multi-agent_kit#install",
    },
    git: {
      installed: findOk("Git Installed"),
      available: findOk("Git Available"),
      isRepo: findOk("Git Repo"),
      clean: findOk("Git Clean"),
      safeDirectoryWarning: !findOk("Git Safe Directory"),
      warning:
        allResults
          .filter((r) => r.status === "warn" && r.name.startsWith("Git"))
          .map((r) => r.message)[0] ?? null,
    },
    node: {
      version: process.version,
      npmGlobalBin: findMsg("npm global bin"),
    },
    scaffold: {
      initialized: findOk(".omk dir"),
      writable: findOk(".omk writable"),
      rootYaml: findOk("root.yaml"),
      okabeAgents: findMsg("Okabe Agents"),
      rootPrompt: findMsg("Root Prompt"),
      hooksExecutable: findOk("Hooks Exec"),
    },
    globalSync: {
      memory: findMsg("Global Memory"),
      graphMemory: findMsg("Graph Memory"),
      globalPollution: findMsg("Global Pollution"),
      mcp: findMsg("OMK MCP"),
      skills: findMsg(".kimi/skills"),
      agentSkills: findMsg(".agents/skills"),
      globalMcp: findMsg("Global MCP"),
      globalSkills: findMsg("Global Skills"),
    },
    security: {
      dangerousConfig: findMsg("Dangerous Config"),
      childEnvIsolation: findMsg("Child Env Isolation"),
      sandboxEnforcement: findMsg("Sandbox Enforcement"),
      sandboxMetadata: find("Sandbox Enforcement")?.metadata ?? null,
    },
    rustSafety: {
      cargo: findMsg("Rust Cargo"),
      rustc: findMsg("Rust Compiler"),
      crate: findMsg("Rust Safety Crate"),
      native: findMsg("Rust Safety Native"),
      nativeSource: findMeta("Rust Safety Native", "source"),
      nativePlatformArch: findMeta("Rust Safety Native", "platformArch"),
      nativeBuiltFromSource: findMeta("Rust Safety Native", "builtFromSource"),
      nativePath: findMeta("Rust Safety Native", "path"),
    },
  };
  const output = {
    ok: errors.length === 0,
    command: "doctor",
    checkedAt: new Date().toISOString(),
    data,
    ...data,
    warnings,
    errors,
    info,
    fixes,
  };
  console.log(JSON.stringify(output, null, 2));
  if (errors.length > 0 && !options.soft) process.exit(1);
}

export async function emitDoctorConsoleReport(
  categoryResults: Array<{ title: string; results: CheckResult[] }>,
  allResults: CheckResult[],
  fixes: DoctorFixReport | undefined,
  options: DoctorOptions
): Promise<void> {
  console.log(header("open_multi-agent_kit doctor"));
  console.log(separator());

  for (const { title, results } of categoryResults) {
    console.log(style.purpleBold(`\n  ${title}`));
    for (const r of results) {
      const icon = r.status === "ok" ? "✅" : r.status === "warn" ? "⚠️" : r.status === "fail" ? "❌" : "ℹ️";
      console.log(`    ${icon} ${r.name.padEnd(16)} ${r.message}`);
    }
  }

  if (fixes) {
    console.log(style.purpleBold("\n  Fixes"));
    if (fixes.actions.length === 0 && fixes.skipped.length === 0) {
      console.log(`    ${style.gray("ℹ")} no safe repairs were needed`);
    }
    for (const action of fixes.actions) {
      console.log(`    ${style.mint("✓")} ${action}`);
    }
    for (const item of fixes.skipped) {
      console.log(`    ${style.skin("⚠")} ${item}`);
    }
  }

  console.log();
  const fails = allResults.filter((r) => r.status === "fail").length;
  const warns = allResults.filter((r) => r.status === "warn").length;

  if (fails > 0) {
    console.log(status.error(t("doctor.failures", fails, warns)));
    if (!options.soft) process.exit(1);
  } else if (warns > 0) {
    console.log(status.warn(t("doctor.warnings", warns)));
  } else {
    console.log(status.ok(t("doctor.allPassed")));
  }

  const omkVersionResult = allResults.find((r) => r.name === "OMK Version");
  if (omkVersionResult?.status === "warn" && !options.json) {
    const updatePrompt = await maybePromptForOmkUpdate();
    if (updatePrompt.shouldExit) process.exit(updatePrompt.exitCode ?? 0);
  }
}
