/**
 * Phase 1 — CommandEnvelope builder
 * Assembles the canonical envelope from parsed argv, config, and resolved theme.
 */

import type {
  CommandKind,
  CommandEnvelope,
  OutputProfile,
  ResolvedTheme,
  RuntimeOptions,
  CliResolvedConfig,
  NormalizedInput,
} from "../runtime/types.js";
import { parseArgv, inferInputSource } from "./argv-parser.js";
import { loadProjectConfig, loadUserConfig, resolveConfigValue } from "./config-loader.js";
import { resolveInput } from "./input-resolver.js";
import { validateInput } from "./validator.js";

export interface BuildEnvelopeOptions {
  readonly argv: readonly string[];
  readonly defaultCommand?: CommandKind;
}

export async function buildCommandEnvelope(opts: BuildEnvelopeOptions): Promise<{
  envelope: CommandEnvelope;
  validation: { valid: boolean; errors: readonly import("../runtime/types.js").NormalizedCliError[] };
}> {
  const parsed = parseArgv(opts.argv);
  const cwd = process.cwd();
  const invokedAt = new Date().toISOString();

  const command: CommandKind = (parsed.command as CommandKind) ?? opts.defaultCommand ?? "run";
  const source = inferInputSource(parsed);

  const projectCfg = loadProjectConfig(cwd);
  const userCfg = loadUserConfig();

  const input = await resolveInput({
    source,
    positionalArgs: parsed.positionalArgs,
    flags: parsed.flags,
    hasStdinPipe: parsed.hasStdinPipe,
    cwd,
  });

  const normalizedInput: NormalizedInput = {
    ...input,
    rawArgs: parsed.raw,
    metadata: { cwd, invokedAt, isTty: Boolean(process.stdout.isTTY) },
  };

  const validation = validateInput(normalizedInput);

  const outputProfile: OutputProfile = {
    format: resolveConfigValue(
      parsed.flags["output"] as OutputProfile["format"] | undefined,
      process.env.OMK_OUTPUT as OutputProfile["format"] | undefined,
      projectCfg?.data.outputFormat as OutputProfile["format"] | undefined,
      userCfg?.data.outputFormat as OutputProfile["format"] | undefined,
      "json"
    ),
    pretty: resolveConfigValue(
      Boolean(parsed.flags["pretty"]),
      process.env.OMK_PRETTY === "1",
      projectCfg?.data.pretty as boolean | undefined,
      userCfg?.data.pretty as boolean | undefined,
      false
    ),
    includeMessages: resolveConfigValue(
      Boolean(parsed.flags["messages"]),
      process.env.OMK_MESSAGES !== "0",
      projectCfg?.data.includeMessages as boolean | undefined,
      userCfg?.data.includeMessages as boolean | undefined,
      true
    ),
    includeTrace: resolveConfigValue(
      Boolean(parsed.flags["trace"]),
      process.env.OMK_TRACE === "1",
      projectCfg?.data.includeTrace as boolean | undefined,
      userCfg?.data.includeTrace as boolean | undefined,
      false
    ),
    stream: resolveConfigValue(
      Boolean(parsed.flags["stream"]),
      process.env.OMK_STREAM === "1",
      projectCfg?.data.stream as boolean | undefined,
      userCfg?.data.stream as boolean | undefined,
      false
    ),
    destination: "stdout",
    outputFile: typeof parsed.flags["out"] === "string" ? parsed.flags["out"] : undefined,
  };

  const resolvedTheme: ResolvedTheme = {
    name: resolveConfigValue(
      parsed.flags["theme"] as string | undefined,
      process.env.OMK_THEME,
      projectCfg?.data.theme as string | undefined,
      userCfg?.data.theme as string | undefined,
      "omk"
    ),
    mode: resolveConfigValue(
      parsed.flags["mode"] as ResolvedTheme["mode"] | undefined,
      process.env.OMK_THEME_MODE as ResolvedTheme["mode"] | undefined,
      projectCfg?.data.themeMode as ResolvedTheme["mode"] | undefined,
      userCfg?.data.themeMode as ResolvedTheme["mode"] | undefined,
      "auto"
    ),
  };

  const runtime: RuntimeOptions = {
    runId: typeof parsed.flags["run-id"] === "string" ? parsed.flags["run-id"] : undefined,
    workers: typeof parsed.flags["workers"] === "string" ? parsed.flags["workers"] : undefined,
    provider: typeof parsed.flags["provider"] === "string" ? parsed.flags["provider"] : undefined,
    sudo: Boolean(parsed.flags["sudo"]),
  };

  const config: CliResolvedConfig = {
    cwd,
    env: process.env,
    projectConfig: projectCfg?.data,
    userConfig: userCfg?.data,
  };

  const envelope: CommandEnvelope = {
    kind: command,
    input: normalizedInput,
    config,
    output: outputProfile,
    theme: resolvedTheme,
    runtime,
  };

  return { envelope, validation };
}
