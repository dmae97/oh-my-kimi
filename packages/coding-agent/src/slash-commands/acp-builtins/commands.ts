import { browserCommand } from "./browser";
import { changelogCommand } from "./changelog";
import { compactCommand } from "./compact";
import { contextCommand } from "./context";
import { dumpCommand } from "./dump";
import { exportCommand } from "./export";
import { fastCommand } from "./fast";
import { forceCommand } from "./force";
import { jobsCommand } from "./jobs";
import { marketplaceCommand } from "./marketplace";
import { mcpCommand } from "./mcp";
import { memoryCommand } from "./memory";
import { modelCommand } from "./model";
import { moveCommand } from "./move";
import { pluginsCommand } from "./plugins";
import { reloadPluginsCommand } from "./reload-plugins";
import { renameCommand } from "./rename";
import { sessionCommand } from "./session";
import { shareCommand } from "./share";
import { sshCommand } from "./ssh";
import { todoCommand } from "./todo";
import { toolsCommand } from "./tools";
import type { AcpBuiltinCommandSpec } from "./types";
import { usageCommand } from "./usage";

export const ACP_BUILTIN_COMMANDS: ReadonlyArray<AcpBuiltinCommandSpec> = [
	fastCommand,
	browserCommand,
	usageCommand,
	dumpCommand,
	contextCommand,
	toolsCommand,
	modelCommand,
	jobsCommand,
	changelogCommand,
	exportCommand,
	shareCommand,
	todoCommand,
	sessionCommand,
	mcpCommand,
	sshCommand,
	compactCommand,
	memoryCommand,
	renameCommand,
	moveCommand,
	marketplaceCommand,
	pluginsCommand,
	reloadPluginsCommand,
	forceCommand,
];
