import type { SlashCommandSpec } from "../types.js";
import { buildControlPlaneSlashCommands } from "./control.js";
import { buildDiagnosticsSlashCommands } from "./diagnostics.js";
import { buildHarnessSlashCommands } from "./harness.js";
import { buildRoutingSlashCommands } from "./routing.js";
import { buildSessionSlashCommands } from "./session.js";
import { buildToolPlaneSlashCommands } from "./tool-plane.js";
import { buildUiSlashCommands } from "./ui.js";

export function buildNativeChatSlashCommands(): SlashCommandSpec[] {
  return [
    ...buildSessionSlashCommands(),
    ...buildRoutingSlashCommands(),
    ...buildControlPlaneSlashCommands(),
    ...buildToolPlaneSlashCommands(),
    ...buildUiSlashCommands(),
    ...buildDiagnosticsSlashCommands(),
    ...buildHarnessSlashCommands(),
  ];
}
