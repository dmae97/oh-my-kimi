import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { Container, getKeybindings, Input, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import { openPath } from "../../utils/open";
import { DynamicBorder } from "./dynamic-border";

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container {
	#contentContainer: Container;
	#input: Input;
	#tui: TUI;
	#abortController = new AbortController();
	#inputResolver?: (value: string) => void;
	#inputRejecter?: (error: Error) => void;

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
	) {
		super();
		this.#tui = tui;

		const providerInfo = getOAuthProviders().find(p => p.id === providerId);
		const providerName = providerInfo?.name || providerId;

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("warning", `Login to ${providerName}`), 1, 0));

		// Dynamic content area
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		// Input (always present, used when needed)
		this.#input = new Input();
		this.#input.onSubmit = () => {
			if (this.#inputResolver) {
				this.#inputResolver(this.#input.getValue());
				this.#inputResolver = undefined;
				this.#inputRejecter = undefined;
			}
		};
		this.#input.onEscape = () => {
			this.#cancel();
		};

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	#cancel(): void {
		this.#abortController.abort();
		if (this.#inputRejecter) {
			this.#inputRejecter(new Error("Login cancelled"));
			this.#inputResolver = undefined;
			this.#inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Called by the OAuth `onAuth` callback. Renders the full authorization URL
	 * as the primary copy target — that works from any machine, including
	 * SSH/WSL/headless sessions where the OMP-hosted `launchUrl` would resolve
	 * against the user's local browser and fail. When `launchUrl` is present it
	 * is offered as an additional local shortcut so narrow local terminals still
	 * have a truncation-safe copy target (viewport clipping on a long authorize
	 * URL silently drops trailing OAuth query parameters — e.g.
	 * `code_challenge_method=S256`). The OSC 8 hyperlink carries the full URL
	 * for terminals that support click-through.
	 */
	showAuth(url: string, instructions?: string, launchUrl?: string): void {
		this.#contentContainer.clear();
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("accent", url), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.#contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));

		if (launchUrl && launchUrl !== url) {
			this.#contentContainer.addChild(
				new Text(theme.fg("dim", `Local shortcut (this machine only): ${launchUrl}`), 1, 0),
			);
		}

		if (instructions) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		// Open browser (best-effort)
		openPath(url);

		this.#tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		if (!this.#contentContainer.children.includes(this.#input)) {
			this.#contentContainer.addChild(this.#input);
		}
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 1, 0));
		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		if (placeholder) {
			this.#contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		}
		if (!this.#contentContainer.children.includes(this.#input)) {
			this.#contentContainer.addChild(this.#input);
		}
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel, Enter to submit)"), 1, 0));

		this.#input.setValue("");
		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 1, 0));
		this.#tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.#tui.requestRender();
	}

	/** Route non-bracketed paste transports into the active login input. */
	pasteText(text: string): void {
		this.#input.pasteText(text);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.#cancel();
			return;
		}

		// Pass to input
		this.#input.handleInput(data);
	}
}
