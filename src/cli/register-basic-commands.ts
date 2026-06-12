import type { Command } from "commander";
import { registerCoreCommands } from "./registry/core.js";
import { registerSystemCommands } from "./registry/system.js";
import { registerSessionCommands } from "./registry/session.js";
import { registerToolingCommands } from "./registry/tooling.js";
import { registerVisualCommands } from "./registry/visual.js";
import { registerConsentCommand } from "../commands/consent.js";

export function registerBasicCommands(program: Command): void {
  registerCoreCommands(program);
  registerSystemCommands(program);
  registerSessionCommands(program);
  registerToolingCommands(program);
  registerVisualCommands(program);
  registerConsentCommand(program);
}
