import { addKeyAliases, canonicalKeyId, Editor, type KeyId, parseKey, parseKittySequence } from "@oh-my-pi/pi-tui";
import type { AppKeybinding } from "../../config/keybindings";
import { imageReferenceHyperlink, PLACEHOLDER_REGEX, renderPlaceholders } from "../image-references";
import { highlightMagicKeywords } from "../magic-keywords";
import { theme } from "../theme/theme";

type ConfigurableEditorAction = Extract<
	AppKeybinding,
	| "app.interrupt"
	| "app.clear"
	| "app.exit"
	| "app.suspend"
	| "app.display.reset"
	| "app.thinking.cycle"
	| "app.model.cycleForward"
	| "app.model.cycleBackward"
	| "app.model.select"
	| "app.model.selectTemporary"
	| "app.tools.expand"
	| "app.thinking.toggle"
	| "app.editor.external"
	| "app.history.search"
	| "app.message.dequeue"
	| "app.clipboard.pasteImage"
	| "app.clipboard.pasteTextRaw"
	| "app.clipboard.copyPrompt"
>;

const DEFAULT_ACTION_KEYS: Record<ConfigurableEditorAction, KeyId[]> = {
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.exit": ["ctrl+d"],
	"app.suspend": ["ctrl+z"],
	"app.display.reset": ["ctrl+l"],
	"app.thinking.cycle": ["shift+tab"],
	"app.model.cycleForward": ["ctrl+p"],
	"app.model.cycleBackward": ["shift+ctrl+p"],
	"app.model.select": ["alt+m"],
	"app.model.selectTemporary": ["alt+p"],
	"app.tools.expand": ["ctrl+o"],
	"app.thinking.toggle": ["ctrl+t"],
	"app.editor.external": ["ctrl+g"],
	"app.history.search": ["ctrl+r"],
	"app.message.dequeue": ["alt+up"],
	"app.clipboard.pasteImage": ["ctrl+v"],
	"app.clipboard.pasteTextRaw": ["ctrl+shift+v", "alt+shift+v"],
	"app.clipboard.copyPrompt": ["alt+shift+c"],
};

function buildMatchKeys(keys: readonly KeyId[]): Set<string> {
	const matchKeys = new Set<string>();
	for (const key of keys) {
		addKeyAliases(matchKeys, key);
	}
	return matchKeys;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const BRACKETED_IMAGE_PATH_REGEX = /\.(?:png|jpe?g|gif|webp)$/i;
const BRACKETED_IMAGE_PATH_BOUNDARY_REGEX = /\.(?:png|jpe?g|gif|webp)(?=$|["']?\s)/gi;
const SHELL_ESCAPED_PATH_CHAR_REGEX = /\\([\\\s'"()[\]{}&;<>|?*!$`])/g;

function isPastedPathSeparator(char: string | undefined): boolean {
	return char === undefined || char === " " || char === "\t" || char === "\r" || char === "\n";
}

function imagePathBoundaryEnd(payload: string, segmentStart: number, extensionEnd: number): number | undefined {
	const quote = payload[segmentStart];
	const afterExtension = payload[extensionEnd];
	if (quote === '"' || quote === "'") {
		return afterExtension === quote && isPastedPathSeparator(payload[extensionEnd + 1])
			? extensionEnd + 1
			: undefined;
	}
	if (isPastedPathSeparator(afterExtension)) return extensionEnd;
	return undefined;
}

function normalizePastedImagePath(path: string): string {
	const trimmed = path.trim();
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	const unquoted =
		trimmed.length > 1 && (first === '"' || first === "'") && last === first ? trimmed.slice(1, -1) : trimmed;
	return unquoted.replace(SHELL_ESCAPED_PATH_CHAR_REGEX, "$1");
}

export function extractBracketedImagePastePaths(data: string): string[] | undefined {
	if (!data.startsWith(BRACKETED_PASTE_START)) return undefined;
	const endIndex = data.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length);
	if (endIndex === -1 || endIndex + BRACKETED_PASTE_END.length !== data.length) return undefined;

	const pasted = data.slice(BRACKETED_PASTE_START.length, endIndex).trim();
	if (!pasted) return undefined;

	const paths: string[] = [];
	let segmentStart = 0;
	BRACKETED_IMAGE_PATH_BOUNDARY_REGEX.lastIndex = 0;
	for (
		let match = BRACKETED_IMAGE_PATH_BOUNDARY_REGEX.exec(pasted);
		match;
		match = BRACKETED_IMAGE_PATH_BOUNDARY_REGEX.exec(pasted)
	) {
		const extensionEnd = match.index + match[0].length;
		const boundaryEnd = imagePathBoundaryEnd(pasted, segmentStart, extensionEnd);
		if (boundaryEnd === undefined) continue;

		const path = normalizePastedImagePath(pasted.slice(segmentStart, boundaryEnd));
		if (!path || !BRACKETED_IMAGE_PATH_REGEX.test(path)) return undefined;
		paths.push(path);

		segmentStart = boundaryEnd;
		while (segmentStart < pasted.length && isPastedPathSeparator(pasted[segmentStart])) {
			segmentStart++;
		}
		BRACKETED_IMAGE_PATH_BOUNDARY_REGEX.lastIndex = segmentStart;
	}

	if (paths.length === 0 || segmentStart !== pasted.length) return undefined;
	return paths;
}

export function extractBracketedImagePastePath(data: string): string | undefined {
	const paths = extractBracketedImagePastePaths(data);
	return paths?.length === 1 ? paths[0] : undefined;
}

/**
 * Custom editor that handles configurable app-level shortcuts for coding-agent.
 */
export class CustomEditor extends Editor {
	imageLinks?: readonly (string | undefined)[];

	/** Treat image/paste markers as indivisible: a stray backspace deletes the whole token
	 *  instead of corrupting `[Paste #1, +30 lines]` into plain text. */
	override atomicTokenPattern = PLACEHOLDER_REGEX;

	/** Gradient-highlight the "ultrathink" / "orchestrate" / "workflowz" keywords as the user types
	 *  them, skipping any occurrence inside code spans, fenced blocks, or XML sections. Also make
	 *  pasted image placeholders visually distinct and hyperlink them once their blob file exists. */
	decorateText = (text: string): string =>
		renderPlaceholders(text, {
			renderText: value => highlightMagicKeywords(value),
			renderReference: (value, kind, index) =>
				kind === "image"
					? imageReferenceHyperlink(value, index, this.imageLinks, label =>
							theme.fg("accent", `\x1b[1m\x1b[4m${label}\x1b[24m\x1b[22m`),
						)
					: theme.fg("accent", `\x1b[1m${value}\x1b[22m`),
		});
	onEscape?: () => void;
	onClear?: () => void;
	onExit?: () => void;
	onDisplayReset?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModel?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onHistorySearch?: () => void;
	onSuspend?: () => void;
	onSelectModelTemporary?: () => void;
	/** Called when the configured copy-prompt shortcut is pressed. */
	onCopyPrompt?: () => void;
	/** Called when the configured image-paste shortcut is pressed. */
	onPasteImage?: () => Promise<boolean>;
	/** Called when a bracketed paste contains one or more image-file paths. */
	onPasteImagePath?: (path: string) => void | Promise<void>;
	/** Called when the configured raw text-paste shortcut is pressed. */
	onPasteTextRaw?: () => void;
	/** Called when the configured dequeue shortcut is pressed. */
	onDequeue?: () => void;
	/** Called when Caps Lock is pressed. */
	onCapsLock?: () => void;
	/** Called when left-arrow is pressed while the editor is empty (cursor necessarily at start). */
	onLeftAtStart?: () => void;

	/** Custom key handlers from extensions and non-built-in app actions. */
	#customKeyHandlers = new Map<KeyId, () => void>();
	#customMatchKeys = new Map<string, () => void>();
	#actionKeys = new Map<ConfigurableEditorAction, KeyId[]>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [action as ConfigurableEditorAction, [...keys]]),
	);
	#actionMatchKeys = new Map<ConfigurableEditorAction, Set<string>>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [
			action as ConfigurableEditorAction,
			buildMatchKeys(keys),
		]),
	);

	setActionKeys(action: ConfigurableEditorAction, keys: KeyId[]): void {
		this.#actionKeys.set(action, [...keys]);
		this.#rebuildActionMatchKeys(action);
	}

	#rebuildActionMatchKeys(action: ConfigurableEditorAction): void {
		this.#actionMatchKeys.set(action, buildMatchKeys(this.#actionKeys.get(action) ?? []));
	}

	#rebuildCustomMatchKeys(): void {
		this.#customMatchKeys.clear();
		for (const [keyId, handler] of this.#customKeyHandlers) {
			for (const alias of buildMatchKeys([keyId])) {
				// Preserve current iteration behavior: the first registered handler for colliding aliases wins.
				if (!this.#customMatchKeys.has(alias)) this.#customMatchKeys.set(alias, handler);
			}
		}
	}

	#matchesAction(canonical: string | undefined, action: ConfigurableEditorAction): boolean {
		return canonical !== undefined && (this.#actionMatchKeys.get(action)?.has(canonical) ?? false);
	}

	/**
	 * Register a custom key handler. Extensions use this for shortcuts.
	 */
	setCustomKeyHandler(key: KeyId, handler: () => void): void {
		this.#customKeyHandlers.set(key, handler);
		this.#rebuildCustomMatchKeys();
	}

	/**
	 * Remove a custom key handler.
	 */
	removeCustomKeyHandler(key: KeyId): void {
		this.#customKeyHandlers.delete(key);
		this.#rebuildCustomMatchKeys();
	}

	/**
	 * Clear all custom key handlers.
	 */
	clearCustomKeyHandlers(): void {
		this.#customKeyHandlers.clear();
		this.#rebuildCustomMatchKeys();
	}

	handleInput(data: string): void {
		const kittyParsed = parseKittySequence(data);
		if (kittyParsed && (kittyParsed.modifier & 64) !== 0 && this.onCapsLock) {
			// Caps Lock is modifier bit 64
			this.onCapsLock();
			return;
		}

		const pastedImagePaths = extractBracketedImagePastePaths(data);
		if (pastedImagePaths && this.onPasteImagePath) {
			void (async () => {
				for (const path of pastedImagePaths) {
					await this.onPasteImagePath?.(path);
				}
			})();
			return;
		}

		const parsedKey = parseKey(data);
		const canonical = parsedKey !== undefined ? canonicalKeyId(parsedKey) : undefined;

		// Left-arrow on an empty editor: surface for the agent-hub double-tap
		// gesture. Plain "left" only — modified arrows and any in-text cursor
		// movement fall through to normal handling.
		if (canonical === "left" && this.onLeftAtStart && this.getText().trim() === "") {
			this.onLeftAtStart();
			return;
		}

		if (canonical !== undefined) {
			// Intercept configured image paste (async - fires and handles result)
			if (this.#matchesAction(canonical, "app.clipboard.pasteImage") && this.onPasteImage) {
				void this.onPasteImage();
				return;
			}

			// Intercept configured raw text paste (fires and handles result)
			if (this.#matchesAction(canonical, "app.clipboard.pasteTextRaw") && this.onPasteTextRaw) {
				this.onPasteTextRaw();
				return;
			}

			// Intercept configured external editor shortcut
			if (this.#matchesAction(canonical, "app.editor.external") && this.onExternalEditor) {
				this.onExternalEditor();
				return;
			}

			// Intercept configured temporary model selector shortcut
			if (this.#matchesAction(canonical, "app.model.selectTemporary") && this.onSelectModelTemporary) {
				this.onSelectModelTemporary();
				return;
			}

			// Intercept configured display reset shortcut
			if (this.#matchesAction(canonical, "app.display.reset") && this.onDisplayReset) {
				this.onDisplayReset();
				return;
			}

			// Intercept configured suspend shortcut
			if (this.#matchesAction(canonical, "app.suspend") && this.onSuspend) {
				this.onSuspend();
				return;
			}

			// Intercept configured thinking block visibility toggle
			if (this.#matchesAction(canonical, "app.thinking.toggle") && this.onToggleThinking) {
				this.onToggleThinking();
				return;
			}

			// Intercept configured model selector shortcut
			if (this.#matchesAction(canonical, "app.model.select") && this.onSelectModel) {
				this.onSelectModel();
				return;
			}

			// Intercept configured history search shortcut
			if (this.#matchesAction(canonical, "app.history.search") && this.onHistorySearch) {
				this.onHistorySearch();
				return;
			}

			// Intercept configured tool output expansion shortcut
			if (this.#matchesAction(canonical, "app.tools.expand") && this.onExpandTools) {
				this.onExpandTools();
				return;
			}

			// Intercept configured backward model cycling (check before forward cycling)
			if (this.#matchesAction(canonical, "app.model.cycleBackward") && this.onCycleModelBackward) {
				this.onCycleModelBackward();
				return;
			}

			// Intercept configured forward model cycling
			if (this.#matchesAction(canonical, "app.model.cycleForward") && this.onCycleModelForward) {
				this.onCycleModelForward();
				return;
			}

			// Intercept configured thinking level cycling
			if (this.#matchesAction(canonical, "app.thinking.cycle") && this.onCycleThinkingLevel) {
				this.onCycleThinkingLevel();
				return;
			}

			// Intercept configured interrupt shortcut.
			// When the autocomplete popup is visible, ESC's first job is to dismiss
			// the popup — let super.handleInput() route it to #cancelAutocomplete().
			// The user can press ESC again afterward to fire the global interrupt
			// handler. This matches the standard TUI/IDE pattern and prevents a
			// single ESC from both closing an @ completion and aborting an active
			// agent run (#1655).
			if (this.#matchesAction(canonical, "app.interrupt") && this.onEscape && !this.isShowingAutocomplete()) {
				this.onEscape();
				return;
			}

			// Intercept configured clear shortcut
			if (this.#matchesAction(canonical, "app.clear") && this.onClear) {
				this.onClear();
				return;
			}

			// Intercept configured exit shortcut. Always consume the shortcut so it
			// never reaches the parent handler; firing onExit is the controller's
			// chance to snapshot the current text as a draft before shutting down.
			if (this.#matchesAction(canonical, "app.exit")) {
				this.onExit?.();
				return;
			}

			// Intercept configured dequeue shortcut (restore queued message to editor)
			if (this.#matchesAction(canonical, "app.message.dequeue") && this.onDequeue) {
				this.onDequeue();
				return;
			}

			// Intercept configured copy-prompt shortcut
			if (this.#matchesAction(canonical, "app.clipboard.copyPrompt") && this.onCopyPrompt) {
				this.onCopyPrompt();
				return;
			}

			// Check custom key handlers (extensions)
			const handler = this.#customMatchKeys.get(canonical);
			if (handler) {
				handler();
				return;
			}
		}

		// Pass to parent for normal handling
		super.handleInput(data);
	}
}
