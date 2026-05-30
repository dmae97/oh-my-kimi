import type { OAuthProvider } from "@oh-my-pi/pi-ai/utils/oauth/types";
import { Input, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { OAuthSelectorComponent } from "../../components/oauth-selector";
import { theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const CALLBACK_SERVER_PROVIDERS: Partial<Record<OAuthProvider, true>> = {
	anthropic: true,
	"openai-codex": true,
	"gitlab-duo": true,
	"google-gemini-cli": true,
	"google-antigravity": true,
};

interface PromptState {
	message: string;
	placeholder?: string;
	input: Input;
}

class ProviderSceneController implements SetupSceneController {
	title = "Choose a provider";
	subtitle = "Log in now, or skip and use /login later.";
	#selector: OAuthSelectorComponent;
	#statusLines: string[] = [];
	#prompt: PromptState | undefined;
	#promptResolve: ((value: string) => void) | undefined;
	#loginAbort: AbortController | undefined;
	#loggingInProvider: string | undefined;
	#disposed = false;

	constructor(private readonly host: SetupSceneHost) {
		const authStorage = host.ctx.session.modelRegistry.authStorage;
		this.#selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			providerId => {
				void this.#login(providerId);
			},
			() => host.finish("skipped"),
			{ requestRender: () => host.requestRender() },
		);
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
				this.host.finish("skipped");
			}
			return;
		}
		this.#selector.handleInput(data);
	}

	render(width: number): string[] {
		const lines = [
			theme.fg("muted", "Pick the provider you want to use for your first chat."),
			theme.fg("dim", "Already configured? Press Esc to skip this step."),
			"",
		];
		if (this.#loggingInProvider) {
			lines.push(theme.bold(`Logging in to ${this.#loggingInProvider}`), "");
		} else {
			lines.push(...this.#selector.render(width));
		}
		if (this.#statusLines.length > 0) {
			lines.push("", ...this.#statusLines.map(line => truncateToWidth(line, width)));
		}
		if (this.#prompt) {
			lines.push("", theme.fg("warning", this.#prompt.message));
			if (this.#prompt.placeholder) {
				lines.push(theme.fg("dim", this.#prompt.placeholder));
			}
			lines.push(this.#prompt.input.render(width)[0] ?? "");
		}
		return lines;
	}

	async #login(providerId: string): Promise<void> {
		if (this.#loggingInProvider || this.#disposed) return;
		const useManualInput = CALLBACK_SERVER_PROVIDERS[providerId as OAuthProvider] === true;
		this.#selector.stopValidation();
		this.#loggingInProvider = providerId;
		this.#statusLines = [theme.fg("dim", "Starting OAuth flow…")];
		this.#loginAbort = new AbortController();
		this.host.restoreFocus();
		this.host.requestRender();
		try {
			await this.host.ctx.session.modelRegistry.authStorage.login(providerId as OAuthProvider, {
				signal: this.#loginAbort.signal,
				onAuth: info => {
					this.#statusLines.push(theme.fg("accent", `Open this URL: ${info.url}`));
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
			this.#statusLines.push(theme.fg("success", `${theme.status.success} Logged in to ${providerId}`));
			this.#statusLines.push(theme.fg("dim", `Credentials saved to ${getAgentDbPath()}`));
			this.host.requestRender();
			await Bun.sleep(500);
			if (!this.#disposed) this.host.finish("done");
		} catch (error) {
			if (this.#disposed) return;
			const message = error instanceof Error ? error.message : String(error);
			this.#statusLines.push(theme.fg("error", `Login failed: ${message}`));
			this.#statusLines.push(theme.fg("dim", "Choose another provider or press Esc to skip."));
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

export const providerSetupScene: SetupScene = {
	id: "provider-login",
	title: "Choose a provider",
	minVersion: 1,
	mount: host => new ProviderSceneController(host),
};
