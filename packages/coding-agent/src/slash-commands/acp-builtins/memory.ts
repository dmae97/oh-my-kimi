import { resolveMemoryBackend } from "../../memory-backend";
import { commandConsumed, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const memoryCommand: AcpBuiltinCommandSpec = {
	name: "memory",
	description: "Manage memory",
	inputHint: "<subcommand>",
	handle: async (command, runtime) => {
		const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
		const backend = resolveMemoryBackend(runtime.settings);
		switch (verb) {
			case "view": {
				const payload = await backend.buildDeveloperInstructions(
					runtime.settings.getAgentDir(),
					runtime.settings,
					runtime.session,
				);
				await runtime.output(payload || "Memory payload is empty.");
				return commandConsumed();
			}
			case "clear":
			case "reset": {
				await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
				await runtime.session.refreshBaseSystemPrompt();
				await runtime.output("Memory cleared.");
				return commandConsumed();
			}
			case "enqueue":
			case "rebuild": {
				await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
				await runtime.output("Memory consolidation enqueued.");
				return commandConsumed();
			}
			case "mm":
				return usage(
					"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
					runtime,
				);
			default:
				return usage("Usage: /memory <view|clear|reset|enqueue|rebuild>", runtime);
		}
	},
};
