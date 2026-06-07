import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/utils/oauth/types";
import { Input, matchesKey, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { OAuthSelectorComponent } from "../../components/oauth-selector";
import { theme } from "../../theme/theme";
import type { SetupSceneHost, SetupTab } from "./types";

/** Providers whose OAuth flow needs a pasted code/redirect URL rather than a callback server. */
const CALLBACK_SERVER_PROVIDERS: Partial<Record<OAuthProvider, true>> = {
	anthropic: true,
	"openai-codex": true,
	"gitlab-duo": true,
	"google-gemini-cli": true,
	"google-antigravity": true,
};

function loginUrlLink(url: string): string {
	return `\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`;
}

interface PromptState {
	message: string;
	placeholder?: string;
	input: Input;
}

/**
 * "Sign in" panel: lets the user authenticate one or more model providers via
 * OAuth. Unlike a standalone scene it never auto-advances the wizard — the user
 * may sign in to several providers and then continue with Esc.
 */
export class SignInTab implements SetupTab {
	readonly id = "sign-in";
	readonly label = "Sign in";

	#authStorage: AuthStorage;
	#selector: OAuthSelectorComponent;
	#statusLines: string[] = [];
	#authUrl: string | undefined;
	#prompt: PromptState | undefined;
	#promptResolve: ((value: string) => void) | undefined;
	#loginAbort: AbortController | undefined;
	#loggingInProvider: string | undefined;
	#disposed = false;

	constructor(private readonly host: SetupSceneHost) {
		this.#authStorage = host.ctx.session.modelRegistry.authStorage;
		this.#selector = this.#createSelector();
	}

	/** Modal while an OAuth flow is running so the scene won't switch tabs or finish. */
	get modal(): boolean {
		return this.#loggingInProvider !== undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.#selector.stopValidation();
		this.#loginAbort?.abort();
		this.#resolvePrompt("");
	}

	invalidate(): void {
		this.#selector.invalidate();
		this.#prompt?.input.invalidate();
	}

	handleInput(data: string): void {
		if (this.#loggingInProvider) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.#loginAbort?.abort();
			}
			return;
		}
		this.#selector.handleInput(data);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.#loggingInProvider) {
			lines.push(theme.bold(`Signing in to ${this.#loggingInProvider}`));
		} else {
			lines.push(theme.fg("muted", "Pick a provider to sign in — you can connect more than one."), "");
			lines.push(...this.#selector.render(width));
		}

		const urlLines = this.#authUrl ? wrapTextWithAnsi(theme.fg("dim", this.#authUrl), width) : [];
		if (this.#authUrl) {
			lines.push(theme.fg("accent", `Browser login: ${loginUrlLink(this.#authUrl)}`), ...urlLines.slice(0, 2));
		}
		if (this.#prompt) {
			lines.push(theme.fg("warning", this.#prompt.message));
			if (this.#prompt.placeholder) {
				lines.push(theme.fg("dim", this.#prompt.placeholder));
			}
			lines.push(this.#prompt.input.render(width)[0] ?? "");
		}
		if (urlLines.length > 2) {
			lines.push(...urlLines);
		}
		if (this.#statusLines.length > 0) {
			lines.push(...this.#statusLines.flatMap(line => wrapTextWithAnsi(line, width)));
		}
		return lines;
	}

	#createSelector(): OAuthSelectorComponent {
		return new OAuthSelectorComponent(
			"login",
			this.#authStorage,
			providerId => {
				void this.#login(providerId);
			},
			() => this.host.finish("skipped"),
			{ requestRender: () => this.host.requestRender() },
		);
	}

	async #login(providerId: string): Promise<void> {
		if (this.#loggingInProvider || this.#disposed) return;
		const useManualInput = CALLBACK_SERVER_PROVIDERS[providerId as OAuthProvider] === true;
		this.#selector.stopValidation();
		this.#loggingInProvider = providerId;
		this.#statusLines = [theme.fg("dim", "Starting OAuth flow…")];
		this.#authUrl = undefined;
		this.#loginAbort = new AbortController();
		this.host.restoreFocus();
		this.host.requestRender();
		try {
			await this.#authStorage.login(providerId as OAuthProvider, {
				signal: this.#loginAbort.signal,
				onAuth: info => {
					this.#authUrl = info.url;
					this.#statusLines = [];
					if (info.instructions) {
						this.#statusLines.push(theme.fg("warning", info.instructions));
					}
					if (useManualInput) {
						this.#statusLines.push(theme.fg("dim", "Paste the returned code or redirect URL when prompted."));
					}
					this.host.ctx.openInBrowser(info.url);
					this.host.requestRender();
				},
				onPrompt: prompt => this.#showPrompt(prompt),
				onProgress: message => {
					this.#statusLines.push(theme.fg("dim", message));
					this.host.requestRender();
				},
				onManualCodeInput: () =>
					this.#showPrompt({ message: "Paste the authorization code (or full redirect URL):" }),
			});
			await this.host.ctx.session.modelRegistry.refresh();
			if (this.#disposed) return;
			this.#statusLines = [
				theme.fg("success", `${theme.status.success} Signed in to ${providerId}`),
				theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`),
			];
			this.#authUrl = undefined;
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.#selector.stopValidation();
			this.#selector = this.#createSelector();
			this.host.restoreFocus();
			this.host.requestRender();
		} catch (error) {
			if (this.#disposed) return;
			if (this.#loginAbort?.signal.aborted) {
				this.#statusLines = [theme.fg("dim", "Login cancelled.")];
				this.#authUrl = undefined;
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.#statusLines = [
					theme.fg("error", `Login failed: ${message}`),
					theme.fg("dim", "Choose another provider or press Esc to continue."),
				];
				this.#authUrl = undefined;
			}
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.host.restoreFocus();
			this.host.requestRender();
		}
	}

	#showPrompt(prompt: { message: string; placeholder?: string }): Promise<string> {
		this.#resolvePrompt("");
		const input = new Input();
		const pending = Promise.withResolvers<string>();
		this.#promptResolve = pending.resolve;
		this.#prompt = { message: prompt.message, placeholder: prompt.placeholder, input };
		input.onSubmit = value => {
			this.#resolvePrompt(value);
		};
		input.onEscape = () => {
			this.#loginAbort?.abort();
			this.#resolvePrompt("");
		};
		this.host.setFocus(input);
		this.host.requestRender();
		return pending.promise;
	}

	#resolvePrompt(value: string): void {
		const resolve = this.#promptResolve;
		if (!resolve) return;
		this.#promptResolve = undefined;
		this.#prompt = undefined;
		this.host.restoreFocus();
		resolve(value);
		this.host.requestRender();
	}
}
