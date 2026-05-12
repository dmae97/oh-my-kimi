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
			// Route through the active SessionManager so the persist writer is
			// closed before the file is deleted. Constructing a fresh
			// FileSessionStorage and calling deleteSessionWithArtifacts leaves
			// the active writer attached to the now-deleted path, so the next
			// prompt would silently resurrect or corrupt the "deleted" file.
			try {
				await runtime.sessionManager.dropSession(sessionFile);
			} catch (err) {
				return usage(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`, runtime);
			}
			await runtime.output(
				`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
			);
			return commandConsumed();
		}
		return usage("Usage: /session [info|delete]", runtime);
	},
};
