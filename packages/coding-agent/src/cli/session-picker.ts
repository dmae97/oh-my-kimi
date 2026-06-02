import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { SessionSelectorComponent } from "../modes/components/session-selector";
import { HistoryStorage } from "../session/history-storage";
import type { SessionInfo } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(sessions: SessionInfo[]): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const ui = new TUI(new ProcessTerminal());
	let resolved = false;
	const storage = new FileSessionStorage();

	// Rank sessions with prompt-history matches too, recovering prompts the 4KB
	// session-list prefix never sees. Best-effort: a missing/locked history.db
	// must not break the picker.
	let historyMatcher: ((query: string) => string[]) | undefined;
	try {
		const history = HistoryStorage.open();
		historyMatcher = (query: string) => history.matchingSessionIds(query);
	} catch (error) {
		logger.warn("History storage unavailable for session ranking", { error: String(error) });
	}

	const showSelector = () => {
		const selector = new SessionSelectorComponent(
			sessions,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					process.exit(0);
				}
			},
			async (session: SessionInfo) => {
				// Delete handler - SessionList will show confirmation internally
				await storage.deleteSessionWithArtifacts(session.path);
				return true;
			},
			historyMatcher,
		);
		return selector;
	};

	const selector = showSelector();
	selector.setOnRequestRender(() => ui.requestRender());
	ui.addChild(selector);
	ui.setFocus(selector);
	ui.start();
	return promise;
}
