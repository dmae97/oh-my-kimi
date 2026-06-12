import { style, omkCliHero, label, separator } from "../util/theme.js";
import { t, initI18n } from "../util/i18n.js";
import { orchestratePrompt } from "../orchestration/orchestrate-prompt.js";
import { getCurrentMode, getModePresets } from "../util/mode-preset.js";

export async function menuCommand(options: { runId?: string; workers?: string }): Promise<void> {
  await initI18n();

  const currentMode = await getCurrentMode();
  const preset = getModePresets().find((p) => p.name === currentMode);

  const { renderHudDashboard } = await import("./hud.js");
  try {
    const hud = await renderHudDashboard({
      runId: options.runId,
      terminalWidth: process.stdout.columns || 120,
    });
    console.log(hud);
  } catch {
    console.log(omkCliHero());
  }

  // Show current mode badge
  if (preset) {
    console.log("");
    console.log(label("Mode", `${preset.icon} ${preset.label} (${preset.name})`));
    console.log(separator(50));
  }

  const hasTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (!hasTty) {
    console.log(style.gray("\n  ⟡ omk chat  — " + t("cli.suggestionChat").replace("  ⟡ omk chat  — ", "")));
    console.log(style.gray("  ⟡ omk hud   — " + t("cli.suggestionHud").replace("  ⟡ omk hud   — ", "")));
    console.log(style.gray("  ⟡ omk --help — " + t("cli.suggestionHelp").replace("  ⟡ omk --help — ", "").trim()));
    return;
  }

  const { buildCustomHelp } = await import("../util/help-text.js");
  const customHelp = buildCustomHelp();

  let answer: string;
  try {
    const { select } = await import("@inquirer/prompts");
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 30_000);
    answer = await select(
      {
        message: t("cli.mainMenu"),
        choices: [
          { name: t("cli.menuChat"), value: "1" },
          { name: t("cli.menuHud"), value: "2" },
          { name: t("cli.menuPlan"), value: "3" },
          { name: t("cli.menuParallel"), value: "4" },
          { name: t("cli.menuMode"), value: "m" },
          { name: t("cli.menuPrevious"), value: "0" },
          { name: t("cli.menuHelp"), value: "5" },
          { name: t("cli.menuExit"), value: "q" },
        ],
      },
      { signal: ac.signal }
    );
    clearTimeout(timeoutId);
  } catch (err) {
    if (err instanceof Error && err.name === "ExitPromptError") {
      console.log("\n" + style.gray("Cancelled."));
      process.exit(0);
    }
    console.log(style.gray(t("cli.menuUnavailable")));
    console.log(customHelp);
    return;
  }

  switch (answer) {
    case "1": {
      const { spawnSync } = await import("child_process");
      const chatArgs = [process.argv[1]!, "chat", "--layout", "auto", "--brand", "minimal"];
      if (options.runId) chatArgs.push("--run-id", options.runId);
      if (options.workers) chatArgs.push("--workers", options.workers);
      const result = spawnSync(process.execPath, chatArgs, { stdio: "inherit" });
      if (result.status && result.status !== 0) {
        process.exitCode = result.status;
      }
      break;
    }
    case "2": {
      const { hudCommand } = await import("./hud.js");
      await hudCommand({ runId: options.runId, watch: true, refreshMs: 2000 });
      break;
    }
    case "3": {
      const { planCommand } = await import("./plan.js");
      const { input } = await import("@inquirer/prompts");
      let goal: string;
      try {
        goal = await input({ message: "Goal:" });
      } catch (err) {
        if (err instanceof Error && err.name === "ExitPromptError") {
          console.log(style.purple("🐾 See you, onii-chan~ 💜"));
          process.exit(0);
        }
        throw err;
      }
      await planCommand(goal, { runId: options.runId });
      break;
    }
    case "4": {
      const { spawnSync } = await import("child_process");
      const { input } = await import("@inquirer/prompts");
      let goal: string;
      try {
        goal = await input({ message: "Goal:" });
      } catch (err) {
        if (err instanceof Error && err.name === "ExitPromptError") {
          console.log(style.purple("🐾 See you, onii-chan~ 💜"));
          process.exit(0);
        }
        throw err;
      }
      const parallelArgs = [process.argv[1]!, "parallel", goal];
      if (options.runId) parallelArgs.push("--run-id", options.runId);
      if (options.workers) parallelArgs.push("--workers", options.workers);
      const result = spawnSync(process.execPath, parallelArgs, { stdio: "inherit" });
      if (result.status !== 0) {
        process.exit(result.status ?? 1);
      }
      break;
    }
    case "0": {
      const { selectLatestRunName, listRunCandidates } = await import("./hud.js");
      const { getOmkPath, pathExists } = await import("../util/fs.js");
      const runsDir = getOmkPath("runs");
      let prevRunId: string | null = options.runId ?? null;
      if (!prevRunId && (await pathExists(runsDir))) {
        const candidates = await listRunCandidates(runsDir);
        prevRunId = selectLatestRunName(candidates);
      }
      if (prevRunId) {
        const { hudCommand } = await import("./hud.js");
        await hudCommand({ runId: prevRunId, watch: true, refreshMs: 2000 });
      } else {
        console.log(style.gray("  No previous run found."));
      }
      break;
    }
    case "m":
    case "mode": {
      const { modeCommand } = await import("./mode.js");
      await modeCommand(undefined, { list: false });
      // After showing current mode, prompt to switch
      const { select } = await import("@inquirer/prompts");
      const presets = getModePresets();
      const modeAnswer = await select(
        {
          message: "Select mode:",
          choices: [
            ...presets.map((p) => ({
              name: `${p.icon} ${p.label} — ${p.description}`,
              value: p.name,
            })),
            { name: "Cancel", value: "cancel" },
          ],
        },
        { signal: AbortSignal.timeout(30_000) }
      );
      if (modeAnswer !== "cancel") {
        await modeCommand(modeAnswer, { list: false });
      }
      break;
    }
    case "5":
    case "help":
    case "h": {
      console.log(customHelp);
      break;
    }
    case "q":
    case "quit":
    case "exit": {
      console.log(style.purple("🐾 See you, onii-chan~ 💜"));
      process.exit(0);
      break;
    }
    default: {
      console.log(style.orange(t("cli.unknownChoice", answer)));
      const { input } = await import("@inquirer/prompts");
      let rawPrompt: string;
      try {
        rawPrompt = await input({ message: "Prompt:" });
      } catch (err) {
        if (err instanceof Error && err.name === "ExitPromptError") {
          console.log(style.purple("🐾 See you, onii-chan~ 💜"));
          process.exit(0);
        }
        throw err;
      }
      try {
        await orchestratePrompt(rawPrompt, {
          sourceCommand: "default",
          runId: options.runId,
          workers: options.workers,
        });
      } catch {
        const { spawnSync } = await import("child_process");
        const chatArgs = [process.argv[1]!, "chat"];
        if (options.runId) chatArgs.push("--run-id", options.runId);
        if (options.workers) chatArgs.push("--workers", options.workers);
        const result = spawnSync(process.execPath, chatArgs, { stdio: "inherit" });
        if (result.status !== 0) {
          process.exit(result.status ?? 1);
        }
      }
    }
  }
}
