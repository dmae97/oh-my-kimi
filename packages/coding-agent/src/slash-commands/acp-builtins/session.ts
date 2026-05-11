import { FileSessionStorage } from "../../session/session-storage";
import { commandConsumed, usage } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const sessionCommand: AcpBuiltinCommandSpec = {
	name: "session",
	description: "Show session information",
	inputHint: "info|delete",
	handle: async (command, runtime) => {
		if (!command.args || command.args === "info") {
			await runtime.output(
				[
					`Session: ${runtime.session.sessionId}`,
					`Title: ${runtime.session.sessionName}`,
					`CWD: ${runtime.cwd}`,
				].join("\n"),
			);
			return commandConsumed();
		}
		if (command.args === "delete") {
			if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
			const sessionFile = runtime.sessionManager.getSessionFile();
			if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
			const storage = new FileSessionStorage();
			const exists = await storage.exists(sessionFile);
			if (!exists) {
				await runtime.output("Session has not been saved yet.");
				return commandConsumed();
			}
			await storage.deleteSessionWithArtifacts(sessionFile);
			await runtime.output(
				`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
			);
			return commandConsumed();
		}
		return usage("Usage: /session [info|delete]", runtime);
	},
};
