import { getOAuthProviders } from "@oh-my-pi/pi-ai/utils/oauth";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/utils/oauth/types";
import { Container, extractPrintableText, fuzzyFilter, matchesKey, Spacer, TruncatedText } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { AuthStorage } from "../../session/auth-storage";
import { DynamicBorder } from "./dynamic-border";

const OAUTH_SELECTOR_MAX_VISIBLE = 10;
/**
 * Component that renders an OAuth provider selector.
 */
export class OAuthSelectorComponent extends Container {
	#listContainer: Container;
	#allProviders: OAuthProviderInfo[] = [];
	#filteredProviders: OAuthProviderInfo[] = [];
	#searchQuery = "";
	#selectedIndex: number = 0;
	#mode: "login" | "logout";
	#authStorage: AuthStorage;
	#onSelectCallback: (providerId: string) => void;
	#onCancelCallback: () => void;
	#statusMessage: string | undefined;
	#validateAuthCallback?: (providerId: string) => Promise<boolean>;
	#requestRenderCallback?: () => void;
	#authState: Map<string, "checking" | "valid" | "invalid"> = new Map();
	#spinnerFrame: number = 0;
	#spinnerInterval?: NodeJS.Timeout;
	#validationGeneration: number = 0;
	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		options?: {
			validateAuth?: (providerId: string) => Promise<boolean>;
			requestRender?: () => void;
		},
	) {
		super();
		this.#mode = mode;
		this.#authStorage = authStorage;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#validateAuthCallback = options?.validateAuth;
		this.#requestRenderCallback = options?.requestRender;
		// Load all OAuth providers
		this.#loadProviders();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		// Add title
		const title = mode === "login" ? "Select provider to login:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.bold(title)));
		this.addChild(new Spacer(1));
		// Create list container
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		// Add bottom border
		this.addChild(new DynamicBorder());
		// Initial render
		this.#updateList();
		this.#startValidation();
	}

	stopValidation(): void {
		this.#validationGeneration += 1;
		this.#stopSpinner();
	}
	#hasSelectableAuth(providerId: string): boolean {
		return this.#mode === "logout" ? this.#authStorage.has(providerId) : this.#authStorage.hasAuth(providerId);
	}

	#loadProviders(): void {
		const providers = getOAuthProviders();
		this.#allProviders =
			this.#mode === "logout" ? providers.filter(provider => this.#hasSelectableAuth(provider.id)) : providers;
		this.#filteredProviders = this.#allProviders;
	}

	#startValidation(): void {
		if (!this.#validateAuthCallback) return;
		const generation = this.#validationGeneration + 1;
		this.#validationGeneration = generation;

		let pending = 0;
		for (const provider of this.#allProviders) {
			if (!this.#hasSelectableAuth(provider.id)) {
				this.#authState.delete(provider.id);
				continue;
			}
			this.#authState.set(provider.id, "checking");
			pending += 1;
			void this.#validateProvider(provider.id, generation);
		}

		if (pending > 0) {
			this.#startSpinner();
			this.#updateList();
			this.#requestRenderCallback?.();
		}
	}

	async #validateProvider(providerId: string, generation: number): Promise<void> {
		if (!this.#validateAuthCallback) return;
		let isValid = false;
		try {
			isValid = await this.#validateAuthCallback(providerId);
		} catch {
			isValid = false;
		}

		if (generation !== this.#validationGeneration) return;
		this.#authState.set(providerId, isValid ? "valid" : "invalid");
		if (![...this.#authState.values()].includes("checking")) {
			this.#stopSpinner();
		}
		this.#updateList();
		this.#requestRenderCallback?.();
	}

	#startSpinner(): void {
		if (this.#spinnerInterval) return;
		this.#spinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
			}
			this.#updateList();
			this.#requestRenderCallback?.();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	#getStatusIndicator(providerId: string): string {
		const state = this.#authState.get(providerId);
		if (state === "checking") {
			const frameCount = theme.spinnerFrames.length;
			const spinner = frameCount > 0 ? theme.spinnerFrames[this.#spinnerFrame % frameCount] : theme.status.pending;
			return theme.fg("warning", ` ${spinner} checking`);
		}
		if (state === "invalid") {
			return theme.fg("error", ` ${theme.status.error} invalid`);
		}
		if (state === "valid") {
			return theme.fg("success", ` ${theme.status.success} logged in`);
		}
		return this.#hasSelectableAuth(providerId) ? theme.fg("success", ` ${theme.status.success} logged in`) : "";
	}

	#isSearchEnabled(): boolean {
		return this.#allProviders.length > OAUTH_SELECTOR_MAX_VISIBLE;
	}

	#shouldRenderSearchStatus(): boolean {
		return this.#isSearchEnabled() || this.#searchQuery.length > 0;
	}

	#renderStatusLine(total: number): string {
		const selectedCount = total === 0 ? 0 : this.#selectedIndex + 1;
		const count =
			this.#searchQuery.trim() && total !== this.#allProviders.length
				? `${selectedCount}/${total} of ${this.#allProviders.length}`
				: `${selectedCount}/${total}`;
		const suffix = this.#searchQuery.trim() ? `  Search: ${this.#searchQuery}` : "  Type to search";
		return theme.fg("muted", `  (${count})${suffix}`);
	}

	#getProviderSearchText(provider: OAuthProviderInfo): string {
		let text = `${provider.name} ${provider.id}`;
		if (this.#hasSelectableAuth(provider.id)) {
			text += " logged in authenticated";
		}
		if (!provider.available) {
			text += " unavailable";
		}
		return text;
	}

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		this.#filteredProviders = query.trim()
			? fuzzyFilter(this.#allProviders, query, provider => this.#getProviderSearchText(provider))
			: this.#allProviders;
		this.#selectedIndex = 0;
		this.#statusMessage = undefined;
		this.#updateList();
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length === 0) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText);
		return true;
	}

	#updateList(): void {
		this.#listContainer.clear();

		const total = this.#filteredProviders.length;
		const maxVisible = OAUTH_SELECTOR_MAX_VISIBLE;
		const startIndex =
			total <= maxVisible
				? 0
				: Math.max(0, Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, total);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.#filteredProviders[i];
			if (!provider) continue;
			const isSelected = i === this.#selectedIndex;
			const isAvailable = provider.available;
			const statusIndicator = this.#getStatusIndicator(provider.id);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				const text = isAvailable ? theme.fg("accent", provider.name) : theme.fg("dim", provider.name);
				line = prefix + text + statusIndicator;
			} else {
				const text = isAvailable ? `  ${provider.name}` : theme.fg("dim", `  ${provider.name}`);
				line = text + statusIndicator;
			}
			this.#listContainer.addChild(new TruncatedText(line, 0, 0));
		}

		// Scroll/search indicator when list is windowed or searchable
		if (startIndex > 0 || endIndex < total || this.#shouldRenderSearchStatus()) {
			this.#listContainer.addChild(new TruncatedText(this.#renderStatusLine(total), 0, 0));
		}

		if (total === 0) {
			const message =
				this.#allProviders.length === 0
					? this.#mode === "login"
						? "No OAuth providers available"
						: "No stored provider credentials to log out"
					: "No matching providers";
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 0, 0));
		}
		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new TruncatedText(theme.fg("warning", `  ${this.#statusMessage}`), 0, 0));
		}
	}
	handleInput(keyData: string): void {
		// Escape or Ctrl+C
		if (matchesSelectCancel(keyData)) {
			this.stopValidation();
			this.#onCancelCallback();
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		// Up arrow
		if (matchesSelectUp(keyData)) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === 0 ? this.#filteredProviders.length - 1 : this.#selectedIndex - 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Down arrow
		else if (matchesSelectDown(keyData)) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === this.#filteredProviders.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Page up - jump up by one visible page
		else if (matchesKey(keyData, "pageUp")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - OAUTH_SELECTOR_MAX_VISIBLE);
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Page down - jump down by one visible page
		else if (matchesKey(keyData, "pageDown")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.min(
					this.#filteredProviders.length - 1,
					this.#selectedIndex + OAUTH_SELECTOR_MAX_VISIBLE,
				);
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Enter
		else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selectedProvider = this.#filteredProviders[this.#selectedIndex];
			if (selectedProvider?.available) {
				this.#statusMessage = undefined;
				this.stopValidation();
				this.#onSelectCallback(selectedProvider.id);
			} else if (selectedProvider) {
				this.#statusMessage = "Provider unavailable in this environment.";
				this.#updateList();
			}
		}
	}
}
