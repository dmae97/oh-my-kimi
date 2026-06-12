/**
 * Section 21 — CLI v2 Provider & Model Commands (Clipanion)
 *
 * Migrates Commander provider/model subcommands to Clipanion classes
 * that delegate to existing command implementations.
 */

import { Command, Option, type Cli } from "clipanion";
import type { ProviderConfigSetInput } from "../../providers/model-registry.js";

type ClipanionRegistrar = Pick<Cli, "register">;

// ──────────────────────────────────────────────
// Provider Commands
// ──────────────────────────────────────────────

export class ProviderListCommand extends Command {
  static override paths = [["provider", "list"]];
  static override usage = Command.Usage({
    description: "List configured model providers without exposing secrets",
  });

  json = Option.Boolean("--json", false, { description: "JSON output" });

  async execute(): Promise<number> {
    const { providerListCommand } = await import("../../commands/provider.js");
    await providerListCommand({ json: this.json });
    return 0;
  }
}

export class ProviderUseCommand extends Command {
  static override paths = [["provider", "use"]];
  static override usage = Command.Usage({
    description: "Set the default provider/model for OMK sessions",
    examples: [["Set provider", "omk provider use mimo --model mimo-v2.5-pro"]],
  });

  provider = Option.String({ required: true });
  model = Option.String("--model", "");
  authority = Option.Boolean("--authority", false);
  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { providerUseCommand } = await import("../../commands/provider.js");
    await providerUseCommand(this.provider, {
      model: this.model || undefined,
      authority: this.authority,
      json: this.json,
    });
    return 0;
  }
}

export class ProviderSetCommand extends Command {
  static override paths = [["provider", "set"]];
  static override usage = Command.Usage({
    description: "Set provider model/base URL/API key env metadata",
  });

  provider = Option.String({ required: true });
  model = Option.String("--model", "");
  baseUrl = Option.String("--base-url", "");
  apiKeyEnv = Option.String("--api-key-env", "");
  kind = Option.String("--kind", "");
  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { providerSetCommand } = await import("../../commands/provider.js");
    await providerSetCommand(this.provider, {
      model: this.model || undefined,
      baseUrl: this.baseUrl || undefined,
      apiKeyEnv: this.apiKeyEnv || undefined,
      kind: (this.kind || undefined) as ProviderConfigSetInput["kind"],
      json: this.json,
    });
    return 0;
  }
}

export class ProviderEnableCommand extends Command {
  static override paths = [["provider", "enable"]];
  static override usage = Command.Usage({
    description: "Enable a provider for routing",
  });

  provider = Option.String({ required: true });
  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { providerEnableCommand } = await import("../../commands/provider.js");
    await providerEnableCommand(this.provider, { json: this.json });
    return 0;
  }
}

export class ProviderDisableCommand extends Command {
  static override paths = [["provider", "disable"]];
  static override usage = Command.Usage({
    description: "Disable a provider and force primary provider fallback",
  });

  provider = Option.String({ required: true });
  reason = Option.String("");
  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { providerDisableCommand } = await import("../../commands/provider.js");
    await providerDisableCommand(this.provider, this.reason || undefined, { json: this.json });
    return 0;
  }
}

export class ProviderDoctorCommand extends Command {
  static override paths = [["provider", "doctor"]];
  static override usage = Command.Usage({
    description: "Check provider availability without exposing credentials",
  });

  provider = Option.String("");
  json = Option.Boolean("--json", false);
  soft = Option.Boolean("--soft", false);

  async execute(): Promise<number> {
    const { providerDoctorCommand } = await import("../../commands/provider.js");
    await providerDoctorCommand(this.provider || undefined, { json: this.json, soft: this.soft });
    return 0;
  }
}

export class ProviderProfilesCommand extends Command {
  static override paths = [["provider", "profiles"]];
  static override usage = Command.Usage({
    description: "List provider compatibility profiles",
  });

  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { providerProfilesCommand } = await import("../../commands/provider.js");
    await providerProfilesCommand({ json: this.json });
    return 0;
  }
}

// ──────────────────────────────────────────────
// Model Commands
// ──────────────────────────────────────────────

export class ModelListCommand extends Command {
  static override paths = [["model", "list"]];
  static override usage = Command.Usage({
    description: "List provider model defaults and aliases",
  });

  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { modelListCommand } = await import("../../commands/model.js");
    await modelListCommand({ json: this.json });
    return 0;
  }
}

export class ModelAliasesCommand extends Command {
  static override paths = [["model", "aliases"]];
  static override usage = Command.Usage({
    description: "List user model aliases",
  });

  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { modelAliasesCommand } = await import("../../commands/model.js");
    await modelAliasesCommand({ json: this.json });
    return 0;
  }
}

export class ModelResolveCommand extends Command {
  static override paths = [["model", "resolve"]];
  static override usage = Command.Usage({
    description: "Resolve a model alias to provider/model metadata",
  });

  model = Option.String({ required: true });
  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { modelResolveCommand } = await import("../../commands/model.js");
    await modelResolveCommand(this.model, { json: this.json });
    return 0;
  }
}

export class ModelUseCommand extends Command {
  static override paths = [["model", "use"]];
  static override usage = Command.Usage({
    description: "Set the default model for OMK sessions",
  });

  model = Option.String({ required: true });
  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { modelUseCommand } = await import("../../commands/model.js");
    await modelUseCommand(this.model, { json: this.json });
    return 0;
  }
}

export class ModelAliasAddCommand extends Command {
  static override paths = [["model", "alias", "add"]];
  static override usage = Command.Usage({
    description: "Add a user model alias",
    examples: [["Add alias", "omk model alias add fast deepseek/flash"]],
  });

  alias = Option.String({ required: true });
  target = Option.String({ required: true });
  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { modelAliasAddCommand } = await import("../../commands/model.js");
    await modelAliasAddCommand(this.alias, this.target, { json: this.json });
    return 0;
  }
}

export class ModelAliasRemoveCommand extends Command {
  static override paths = [["model", "alias", "remove"]];
  static override usage = Command.Usage({
    description: "Remove a user model alias",
  });

  alias = Option.String({ required: true });
  json = Option.Boolean("--json", false);

  async execute(): Promise<number> {
    const { modelAliasRemoveCommand } = await import("../../commands/model.js");
    await modelAliasRemoveCommand(this.alias, { json: this.json });
    return 0;
  }
}

/**
 * Register all provider/model commands on a Clipanion CLI instance.
 */
export function registerProviderCommandsV2(cli: ClipanionRegistrar): void {
  cli.register(ProviderListCommand);
  cli.register(ProviderUseCommand);
  cli.register(ProviderSetCommand);
  cli.register(ProviderEnableCommand);
  cli.register(ProviderDisableCommand);
  cli.register(ProviderDoctorCommand);
  cli.register(ProviderProfilesCommand);
  cli.register(ModelListCommand);
  cli.register(ModelAliasesCommand);
  cli.register(ModelResolveCommand);
  cli.register(ModelUseCommand);
  cli.register(ModelAliasAddCommand);
  cli.register(ModelAliasRemoveCommand);
}
