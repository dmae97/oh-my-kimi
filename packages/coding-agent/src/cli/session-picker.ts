import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { SessionSelectorComponent } from "../modes/components/session-selector";
import { HistoryStorage } from "../session/history-storage";
import { type SessionInfo, SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";

/**
 * Show the TUI session selector and return the selected session, or null if
 * cancelled. Tab toggles between current-folder and all-projects scope; the
 * all-projects list is loaded lazily via `SessionManager.listAll`.
 */
export async function selectSession(
	sessions: SessionInfo[],
	options?: { allSessions?: SessionInfo[]; startInAllScope?: boolean },
): Promise<SessionInfo | null> {
	const { promise, resolve } = Promise.withResolvers<SessionInfo | null>();
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
			(session: SessionInfo) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(session);
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
			{
				onDelete: async (session: SessionInfo) => {
					// Delete handler - SessionList will show confirmation internally
					await storage.deleteSessionWithArtifacts(session.path);
					return true;
				},
				historyMatcher,
				loadAllSessions: () => SessionManager.listAll(storage),
				allSessions: options?.allSessions,
				startInAllScope: options?.startInAllScope,
			},
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
