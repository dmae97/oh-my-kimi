import { buildAuthCenterReport } from "../../../auth.js";
import {
  KNOWN_PROVIDER_IDS,
  listUserModelAliases,
  normalizeProviderId,
  readProviderRegistry,
  resolveUserModelAlias,
} from "../../../../providers/model-registry.js";
import { resolveRuntimeBootstrap } from "../../../../runtime/runtime-bootstrap.js";
import { style } from "../../../../util/theme.js";
import { okSlashResult } from "../result.js";
import type { SlashCommandContext, SlashCommandSpec } from "../types.js";

export function buildRoutingSlashCommands(): SlashCommandSpec[] {
  return [
    {
      name: "/auth",
      aliases: ["/login"],
      group: "routing",
      summary: "Show provider auth status",
      usage: "/auth [provider] [--setup] [--doctor]",
      examples: ["/auth", "/auth codex --doctor"],
      handler: async (ctx, args) => {
        const target = args.positional.find((token) => !token.startsWith("-"));
        const report = await buildAuthCenterReport(target, { env: ctx.env });
        if (args.flags.json) return okSlashResult({ json: report });
        return okSlashResult({
          text: renderAuthReport(
            report,
            Boolean(args.flags.setup || args.flags.doctor),
          ),
        });
      },
    },
    {
      name: "/providers",
      aliases: [":providers"],
      group: "routing",
      summary: "List providers",
      usage: "/providers",
      examples: ["/providers"],
      handler: async (ctx) => {
        const providers = await readProviderRegistry({ env: ctx.env });
        const lines = [style.phosphorBold("\n  Providers:")];
        for (const provider of providers) {
          const current = provider.id === ctx.state.provider ? "*" : " ";
          lines.push(
            style.phosphorDim(
              `  ${current} ${provider.id.padEnd(12)} ${provider.enabled ? "enabled" : "disabled"} ${provider.defaultModel}`,
            ),
          );
        }
        lines.push("");
        return okSlashResult({ text: lines.join("\n") });
      },
    },
    {
      name: "/provider",
      aliases: ["/p"],
      group: "routing",
      summary: "Switch provider for this session",
      usage: "/provider <name>",
      examples: ["/provider codex"],
      handler: async (ctx, args) => {
        const provider = String(args.positional[0] ?? "")
          .trim()
          .toLowerCase();
        const valid = ["auto", ...KNOWN_PROVIDER_IDS];
        const normalized = normalizeProviderId(provider);
        if (!provider || !valid.includes(normalized)) {
          return okSlashResult({
            text: `${style.phosphorDim(`\n  Available: ${valid.join(", ")}`)}\n${style.phosphorDim("  Usage: /provider codex\n")}`,
          });
        }
        return applyProviderOverride(ctx, normalized);
      },
    },
    {
      name: "/models",
      aliases: [":models"],
      group: "routing",
      summary: "List model aliases",
      usage: "/models",
      examples: ["/models"],
      handler: async (ctx) => {
        const aliases = await listUserModelAliases({ env: ctx.env });
        const lines = [style.phosphorBold("\n  User Model Aliases:")];
        const entries = Object.entries(aliases);
        if (entries.length === 0) lines.push(style.phosphorDim("    (none)"));
        for (const [alias, target] of entries)
          lines.push(style.phosphorDim(`    ${alias} -> ${target}`));
        lines.push(
          style.phosphorDim(
            "  Use `omk model alias add fast deepseek/flash` to persist aliases.\n",
          ),
        );
        return okSlashResult({ text: lines.join("\n") });
      },
    },
    {
      name: "/model",
      aliases: ["/m"],
      group: "routing",
      summary: "Set model for this session",
      usage: "/model <provider/model|model>",
      examples: ["/model codex/codex-cli"],
      handler: async (ctx, args) => {
        const model = args.positional.join(" ").trim();
        if (!model) {
          return okSlashResult({
            text: `${style.phosphorDim(`\n  Current model: ${ctx.state.model ?? "auto"}`)}\n${style.phosphorDim("  Usage: /model codex/codex-cli\n")}`,
          });
        }
        return applyModelOverride(ctx, model);
      },
    },
    {
      name: "/use",
      aliases: [":use"],
      group: "routing",
      summary: "Switch provider/model by alias",
      usage: "/use <ref>",
      examples: ["/use codex/codex-cli", "/use fast"],
      handler: async (ctx, args) => {
        const ref = args.positional.join(" ").trim();
        if (!ref)
          return okSlashResult({
            text: style.phosphorDim(
              "\n  Usage: /use codex/codex-cli or /use fast\n",
            ),
          });
        return applyModelOverride(ctx, ref);
      },
    },
  ];
}

async function applyProviderOverride(
  ctx: SlashCommandContext,
  provider: string,
  model?: string,
) {
  const bootstrap = await resolveRuntimeBootstrap({
    provider,
    model: model ?? ctx.state.model,
    cwd: ctx.input.root,
    env: ctx.env,
  });
  if (!bootstrap.ok) {
    const lines = [style.metricsRed(`\n  Provider not ready: ${provider}`)];
    if (bootstrap.reason)
      lines.push(style.phosphorDim(`  ${bootstrap.reason}`));
    for (const hint of bootstrap.setupHints.slice(0, 3))
      lines.push(style.phosphorDim(`  - ${hint}`));
    lines.push(
      style.phosphorDim(`  Restart/setup: omk auth ${provider} --setup\n`),
    );
    return okSlashResult({ text: lines.join("\n") });
  }
  const statePatch = {
    bootstrap,
    provider: bootstrap.provider,
    model: bootstrap.selectedModel,
    updatedAt: new Date().toISOString(),
  };
  if (bootstrap.selectedModel)
    ctx.env.OMK_PROVIDER_MODEL = bootstrap.selectedModel;
  else delete ctx.env.OMK_PROVIDER_MODEL;
  return okSlashResult({
    statePatch,
    text: [
      style.phosphor(
        `\n  Provider switched for this session: ${bootstrap.provider}`,
      ),
      style.phosphorDim(
        `  Runtime: ${bootstrap.selectedRuntimeId ?? "auto"} | Model: ${bootstrap.selectedModel ?? "auto"}`,
      ),
      style.phosphorDim(
        "  Persistent default unchanged; use `omk provider use` to persist.\n",
      ),
    ].join("\n"),
  });
}

async function applyModelOverride(ctx: SlashCommandContext, ref: string) {
  const resolved = await resolveUserModelAlias(ref, { env: ctx.env });
  const updatedAt = new Date().toISOString();
  const lines = [
    style.phosphor(
      `\n  Model override for this session: ${ref} → ${resolved.model}`,
    ),
  ];
  if (resolved.provider)
    lines.push(style.phosphorDim(`  Provider: ${resolved.provider}`));
  lines.push(
    style.phosphorDim(
      "  Persistent default unchanged; use `omk model use` to persist.\n",
    ),
  );

  if (resolved.provider && resolved.provider !== ctx.state.provider) {
    const providerResult = await applyProviderOverride(
      ctx,
      resolved.provider,
      resolved.model,
    );
    if (providerResult.statePatch?.provider !== resolved.provider)
      return providerResult;
    const providerPatch = providerResult.statePatch ?? {};
    const bootstrap = {
      ...(providerPatch.bootstrap ?? ctx.state.bootstrap),
      selectedModel: resolved.model,
    };
    ctx.env.OMK_PROVIDER_MODEL = resolved.model;
    return okSlashResult({
      statePatch: {
        ...providerPatch,
        bootstrap,
        model: resolved.model,
        updatedAt,
      },
      text: [providerResult.text?.trimEnd(), ...lines]
        .filter(Boolean)
        .join("\n"),
    });
  }

  const statePatch = {
    bootstrap: {
      ...ctx.state.bootstrap,
      selectedModel: resolved.model,
    },
    model: resolved.model,
    updatedAt,
  };
  ctx.env.OMK_PROVIDER_MODEL = resolved.model;
  return okSlashResult({ statePatch, text: lines.join("\n") });
}

function renderAuthReport(
  report: Awaited<ReturnType<typeof buildAuthCenterReport>>,
  verbose: boolean,
): string {
  const lines = [
    style.phosphorBold("OMK Auth Center"),
    style.phosphorDim(`Default provider: ${report.defaultProvider}`),
    style.phosphorDim(`Authority: ${report.authorityProvider}`),
  ];
  if (report.model) lines.push(style.phosphorDim(`Model: ${report.model}`));
  lines.push("");
  for (const provider of report.providers) {
    const mark = provider.available
      ? style.phosphorBold("✓")
      : provider.enabled
        ? style.phosphorDim("○")
        : style.phosphorDim("×");
    const state = provider.available
      ? "runtime ready"
      : provider.enabled
        ? "needs setup"
        : "disabled";
    const auth = provider.apiKeyEnv
      ? `${provider.authMethod} ${provider.apiKeyEnv}`
      : provider.authMethod;
    lines.push(
      `  ${mark} ${style.phosphor(provider.provider.padEnd(12))} ${style.phosphorDim(state.padEnd(14))} ${style.phosphorDim(auth)}`,
    );
    if (verbose && provider.nextActions.length > 0) {
      for (const action of provider.nextActions.slice(0, 3))
        lines.push(style.phosphorDim(`      - ${action}`));
    }
  }
  lines.push("");
  lines.push(
    style.phosphorDim(
      "Secret policy: tokenFilesRead=false, secretValuesPrinted=false",
    ),
  );
  lines.push(
    style.phosphorDim("Use `omk auth <provider> --setup` for setup actions."),
  );
  return lines.join("\n");
}
