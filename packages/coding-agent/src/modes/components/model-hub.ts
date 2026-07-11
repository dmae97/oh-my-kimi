/**
 * Fullscreen /models hub, shown on the alternate screen like /settings.
 *
 * Layout: a sidebar of scopes (recently used, role management, all models,
 * one entry per provider — locked providers included, dimmed) beside a
 * {@link ModelBrowser} body. The Roles view manages assignments directly:
 * pick a role, pick a model, adjust thinking in an inline strip, or clear the
 * role back to auto-selection. Locked providers forward to the /login flow.
 * Fully mouse-navigable (hover, wheel, click).
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getCatalogProviderEntry } from "@oh-my-pi/pi-catalog/provider-models";
import {
	type Component,
	extractPrintableText,
	fuzzyFilter,
	matchesKey,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	getConfiguredThinkingLevelMetadata,
	parseConfiguredThinkingLevel,
} from "../../thinking";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	type RoleAssignments,
	sortModelItems,
	thinkingLevelGlyph,
} from "./model-browser";
import { bottomBorder, dividerSplit, row, splitBodyWidth, splitRow, topBorderSplit } from "./overlay-box";

/** `roles` is the full /models hub; `pick` is a one-shot session/embedded picker. */
export type ModelHubMode = "roles" | "pick";

export type ModelHubAction = "modelRole" | "retryFallback";

/** A `--models` scope entry (mirrors the session's scoped model list). */
export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export interface ModelHubCallbacks {
	/** Persist a role assignment (or a retry-fallback registration). */
	onAssign: (
		model: Model,
		role: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
		action: ModelHubAction,
	) => void;
	/** Clear a configured role back to auto-selection. */
	onUnassign: (role: string) => void;
	/** Pick-mode activation: session-only switch or embedded pick. */
	onPick?: (model: Model, selector: string) => void;
	/** Locked provider activation: forward to the /login flow. */
	onLoginRequest?: (providerId: string) => void;
	onCancel: () => void;
}

export interface ModelHubOptions {
	mode?: ModelHubMode;
	/** Session token count; in pick mode, models with smaller context windows are disabled. */
	currentContextTokens?: number;
	/** Preselect this provider's sidebar entry (e.g. when reopening after /login). */
	initialProviderId?: string;
	/** Status-row hint shown in pick mode. */
	pickerHint?: string;
	initialQuery?: string;
}

interface SidebarEntry {
	id: string;
	kind: "recent" | "roles" | "all" | "separator" | "provider";
	label: string;
	providerId?: string;
	locked?: boolean;
	/** Right-aligned annotation: model count, `assigned/total`, or `login`. */
	annotation?: string;
	oauth?: boolean;
	catalogCount?: number;
}

interface StripChip {
	label: string;
	/** Pre-styled label body (without selection decoration). */
	styled: string;
	role?: string;
	action: "assign" | "unassign" | "fallback" | "thinking";
	thinkingLevel?: ConfiguredThinkingLevel;
}

interface StripState {
	kind: "role" | "thinking";
	item: ModelBrowserItem;
	role?: string;
	chips: StripChip[];
	index: number;
	/** Where to land when a thinking strip closes. */
	returnToRoles: boolean;
}

/** Recorded chip hit-range on the footer row (columns relative to frame col 0). */
interface ChipRange {
	start: number;
	end: number;
	index: number;
}

const PROVIDER_REFRESH_DEBOUNCE_MS = 120;
const RECENT_LIMIT = 15;
const SIDEBAR_MIN_WIDTH = 18;
const SIDEBAR_MAX_WIDTH = 26;

const PICK_MODE_HINT = "Session-only switch — role models stay unchanged";

/**
 * Providers already auto-refreshed this process. Selecting a provider fetches
 * its live model list at most once per application lifetime (surviving hub
 * close/reopen); F5 re-fetches on demand.
 */
const autoRefreshedProviders = new Set<string>();

/** Test hook: forget which providers were auto-refreshed this process. */
export function resetProviderAutoRefreshGuard(): void {
	autoRefreshedProviders.clear();
}

/**
 * The fullscreen model hub component. Hosted via `ui.showOverlay(..., { fullscreen: true })`;
 * the host must call {@link ModelHubComponent.dispose} when the overlay closes.
 */
export class ModelHubComponent implements Component {
	#tui: TUI;
	#settings: Settings;
	#registry: ModelRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#callbacks: ModelHubCallbacks;
	#mode: ModelHubMode;
	#pickerHint: string;

	#browser: ModelBrowser;
	#roles: RoleAssignments = {};
	#availableItems: ModelBrowserItem[] = [];
	#recentItems: ModelBrowserItem[] = [];
	#configError: string | undefined;

	#entries: SidebarEntry[] = [];
	#activeEntryId = "all";
	#sidebarScroll = 0;
	#sidebarHover: number | null = null;
	/**
	 * Arrow-key ownership: `scope` (default) hops the sidebar even while the
	 * search bar holds the caret; `list` navigates rows (browser models or
	 * role rows). Tab toggles.
	 */
	#focus: "scope" | "list" = "scope";

	#roleIds: string[] = [];
	#roleIndex = 0;
	#roleHover: number | null = null;

	#assigningRole: string | null = null;
	#strip: StripState | null = null;
	/** Per-provider fuzzy match counts while a query is active; null when not searching. */
	#searchCounts: Map<string, number> | null = null;

	// Provider discovery refresh (debounced per sidebar selection, with spinner).
	#refreshingProviders = new Set<string>();
	#scheduledProviderRefreshes = new Map<string, Timer>();
	#refreshSpinnerFrame = 0;
	#refreshSpinnerInterval?: Timer;

	// Frame geometry from the last render, for mouse hit-testing (the
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1).
	#contentRowStart = 1;
	#contentRowCount = 0;
	#sidebarWidthLast = SIDEBAR_MIN_WIDTH;
	#footerRow = 0;
	#chipRanges: ChipRange[] = [];
	#lockedLoginLine: number | null = null;
	#rolesRowStart = 2;

	constructor(
		tui: TUI,
		settings: Settings,
		registry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelHubCallbacks,
		options: ModelHubOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#callbacks = callbacks;
		this.#mode = options.mode ?? "roles";
		this.#pickerHint = options.pickerHint ?? PICK_MODE_HINT;

		this.#browser = new ModelBrowser(settings, {
			currentContextTokens: options.currentContextTokens,
			disableOverContext: this.#mode === "pick",
			emptyText: () => this.#emptyStateMessage(),
			initialQuery: options.initialQuery,
		});
		this.#browser.onActivate = item => this.#activateItem(item);
		this.#browser.onCancel = () => this.#callbacks.onCancel();
		this.#browser.onQueryChange = query => this.#onQueryChanged(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();

		const initialProvider = options.initialProviderId;
		if (initialProvider && this.#entries.some(entry => entry.providerId === initialProvider)) {
			this.#setActiveEntry(`provider:${initialProvider}`);
		} else if (this.#recentItems.length > 0) {
			this.#setActiveEntry("recent");
		} else {
			this.#setActiveEntry("all");
		}

		// Reconcile with cached discovery state in the background. A --models
		// scope is registry-independent, so the offline reload would only repeat
		// the synchronous hydration above.
		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	/** Cancel pending provider refresh timers and the spinner. Host calls this on overlay close. */
	dispose(): void {
		for (const [, timer] of this.#scheduledProviderRefreshes) clearTimeout(timer);
		this.#scheduledProviderRefreshes.clear();
		this.#refreshingProviders.clear();
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
	}

	invalidate(): void {}

	// ═══════════════════════════════════════════════════════════════════════
	// Data pipeline
	// ═══════════════════════════════════════════════════════════════════════

	#visibleRoleIds(): string[] {
		return getKnownRoleIds(this.#settings).filter(role => !getRoleInfo(role, this.#settings).hidden);
	}

	#getResolvedRoleThinkingLevel(
		role: string,
		resolved: { explicitThinkingLevel: boolean; thinkingLevel?: ConfiguredThinkingLevel },
	): ConfiguredThinkingLevel {
		if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined) {
			return resolved.thinkingLevel;
		}
		if (role === "default") {
			return parseConfiguredThinkingLevel(this.#settings.get("defaultThinkingLevel")) ?? ThinkingLevel.Inherit;
		}
		return ThinkingLevel.Inherit;
	}

	/** Resolve every known role: configured values first, auto-selection for the rest. */
	#reloadRoles(autoCandidates: ReadonlyArray<Model>): void {
		const nextRoles: RoleAssignments = {};
		const allModels = this.#scopedModels.length > 0 ? [...autoCandidates] : this.#registry.getAll();
		const matchPreferences = getModelMatchPreferences(this.#settings);
		const knownRoles = getKnownRoleIds(this.#settings);
		const configuredRoles = new Set<string>();

		for (const role of knownRoles) {
			const roleValue = this.#settings.getModelRole(role);
			if (!roleValue) continue;
			configuredRoles.add(role);
			const resolved = resolveModelRoleValue(roleValue, allModels, {
				settings: this.#settings,
				matchPreferences,
			});
			if (resolved.model) {
				nextRoles[role] = {
					model: resolved.model,
					thinkingLevel: this.#getResolvedRoleThinkingLevel(role, resolved),
					autoSelected: false,
				};
			}
		}

		if (autoCandidates.length > 0) {
			const candidates = [...autoCandidates];
			for (const role of knownRoles) {
				if (configuredRoles.has(role)) continue;
				const resolved = resolveModelRoleValue(`pi/${role}`, candidates, {
					settings: this.#settings,
					matchPreferences,
				});
				if (!resolved.model) continue;
				nextRoles[role] = {
					model: resolved.model,
					thinkingLevel: this.#getResolvedRoleThinkingLevel(role, resolved),
					autoSelected: true,
				};
			}
		}

		this.#roles = nextRoles;
	}

	/** Rebuild items, roles, and the sidebar from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		let allModels: ReadonlyArray<Model>;
		let availableModels: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			allModels = this.#scopedModels.map(scoped => scoped.model);
			availableModels = allModels;
			this.#configError = undefined;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			allModels = this.#registry.getAll();
			try {
				availableModels = this.#registry.getAvailable();
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				availableModels = [];
			}
		}

		this.#reloadRoles(availableModels);

		const mruOrder = this.#settings.getStorage()?.getModelUsageOrder() ?? [];
		this.#availableItems = buildBrowserItems(availableModels);
		sortModelItems(this.#availableItems, { roles: this.#roles, mruOrder });
		this.#browser.setRoles(this.#roles);
		this.#browser.setMruOrder(mruOrder);

		const bySelector = new Map(this.#availableItems.map(item => [item.selector, item]));
		this.#recentItems = [];
		for (const key of mruOrder) {
			const item = bySelector.get(key);
			if (item) this.#recentItems.push(item);
			if (this.#recentItems.length >= RECENT_LIMIT) break;
		}

		this.#buildSidebar(allModels, availableModels);
		this.#applyScope();
	}

	#buildSidebar(allModels: ReadonlyArray<Model>, availableModels: ReadonlyArray<Model>): void {
		const scoped = this.#scopedModels.length > 0;
		let disabledProviders: ReadonlySet<string>;
		try {
			disabledProviders = new Set(this.#settings.get("disabledProviders"));
		} catch {
			disabledProviders = new Set();
		}

		const availableCounts = new Map<string, number>();
		for (const model of availableModels) {
			availableCounts.set(model.provider, (availableCounts.get(model.provider) ?? 0) + 1);
		}
		const catalogCounts = new Map<string, number>();
		for (const model of allModels) {
			catalogCounts.set(model.provider, (catalogCounts.get(model.provider) ?? 0) + 1);
		}

		const unlocked = new Set<string>(availableCounts.keys());
		const locked = new Set<string>();
		if (!scoped) {
			const authStorage = this.#registry.authStorage;
			for (const provider of catalogCounts.keys()) {
				if (!unlocked.has(provider) && !disabledProviders.has(provider)) {
					locked.add(provider);
				}
			}
			for (const provider of this.#registry.getDiscoverableProviders()) {
				if (unlocked.has(provider) || disabledProviders.has(provider)) continue;
				// Discoverable without stored auth: catalog-backed providers stay
				// locked; keyless/custom endpoints (ollama, vllm, …) surface as
				// selectable so discovery can populate them.
				if (authStorage.hasAuth(provider) || !locked.has(provider)) {
					locked.delete(provider);
					unlocked.add(provider);
				}
			}
		}

		const oauthIds = new Set(getOAuthProviders().map(provider => provider.id));
		const providerEntry = (providerId: string, isLocked: boolean): SidebarEntry => ({
			id: `provider:${providerId}`,
			kind: "provider",
			label: providerId,
			providerId,
			locked: isLocked,
			annotation: isLocked ? "login" : String(availableCounts.get(providerId) ?? 0),
			oauth: oauthIds.has(providerId),
			catalogCount: catalogCounts.get(providerId) ?? 0,
		});

		const visibleRoles = this.#visibleRoleIds();
		let assignedCount = 0;
		for (const role of visibleRoles) {
			const assignment = this.#roles[role];
			if (assignment && !assignment.autoSelected) assignedCount++;
		}

		const entries: SidebarEntry[] = [
			{
				id: "recent",
				kind: "recent",
				label: "Recent",
				annotation: this.#recentItems.length > 0 ? String(this.#recentItems.length) : "—",
			},
		];
		if (this.#mode === "roles") {
			entries.push({
				id: "roles",
				kind: "roles",
				label: "Roles",
				annotation: `${assignedCount}/${visibleRoles.length}`,
			});
		}
		entries.push({ id: "all", kind: "all", label: "All models", annotation: String(availableModels.length) });

		const sortedUnlocked = [...unlocked].sort((a, b) => a.localeCompare(b));
		if (sortedUnlocked.length > 0) {
			entries.push({ id: "sep:providers", kind: "separator", label: "" });
			for (const provider of sortedUnlocked) {
				entries.push(providerEntry(provider, false));
			}
		}

		const sortedLocked = [...locked].sort((a, b) => a.localeCompare(b));
		if (sortedLocked.length > 0) {
			entries.push({ id: "sep:locked", kind: "separator", label: "" });
			for (const provider of sortedLocked) {
				entries.push(providerEntry(provider, true));
			}
		}

		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) {
			this.#activeEntryId = "all";
		}
	}

	#activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0];
	}

	#setActiveEntry(id: string): void {
		if (!this.#entries.some(entry => entry.id === id)) return;
		this.#activeEntryId = id;
		this.#applyScope();
		const entry = this.#activeEntry();
		// The Roles view IS its rows — land with row navigation active; every
		// other scope starts in provider-hop mode.
		this.#focus = entry.kind === "roles" && this.#assigningRole === null ? "list" : "scope";
		if (entry.kind === "provider" && !entry.locked) {
			this.#scheduleProviderRefresh(entry.providerId ?? "");
		}
		this.#cancelScheduledRefreshesExcept(entry.kind === "provider" ? entry.providerId : undefined);
	}

	/** Push the active scope's items into the browser. */
	#applyScope(): void {
		const entry = this.#activeEntry();
		switch (entry.kind) {
			case "recent":
				this.#browser.setShowProvider(true);
				this.#browser.setItems([...this.#recentItems]);
				break;
			case "provider": {
				if (entry.locked) {
					// Assign-mode renders the browser regardless of scope; a locked
					// provider contributes nothing selectable.
					this.#browser.setItems([]);
					break;
				}
				const providerId = entry.providerId;
				this.#browser.setShowProvider(false);
				this.#browser.setItems(this.#availableItems.filter(item => item.provider === providerId));
				break;
			}
			case "roles":
				this.#roleIds = this.#visibleRoleIds();
				this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#roleIds.length - 1));
				break;
			default:
				this.#browser.setShowProvider(true);
				this.#browser.setItems([...this.#availableItems]);
				break;
		}
	}

	/** Refresh roles + dependent state after a settings mutation (assign/unassign). */
	#refreshAfterMutation(): void {
		this.#syncFromRegistryState();
		this.#tui.requestRender();
	}

	/**
	 * Recompute per-provider match counts for the active query. Providers
	 * without matches gray out and the scope hop skips them; a provider scope
	 * that just lost its last match falls back to All models so the results
	 * never silently vanish.
	 */
	#onQueryChanged(query: string): void {
		if (!query.trim()) {
			this.#searchCounts = null;
			return;
		}
		const matches = fuzzyFilter(this.#availableItems, query, ({ provider, id }) => `${provider}/${id}`);
		const counts = new Map<string, number>();
		for (const item of matches) {
			counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
		}
		this.#searchCounts = counts;
		const entry = this.#activeEntry();
		if (
			this.#assigningRole === null &&
			entry.kind === "provider" &&
			(entry.locked || (counts.get(entry.providerId ?? "") ?? 0) === 0)
		) {
			this.#setActiveEntry("all");
		}
	}

	/** Entries the scope hop skips: separators, and while searching, providers without matches. */
	#isHopSkipped(entry: SidebarEntry): boolean {
		if (entry.kind === "separator") return true;
		if (this.#searchCounts && entry.kind === "provider") {
			if (entry.locked) return true;
			return (this.#searchCounts.get(entry.providerId ?? "") ?? 0) === 0;
		}
		return false;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Provider discovery refresh
	// ═══════════════════════════════════════════════════════════════════════

	#startRefreshSpinner(): void {
		if (this.#refreshSpinnerInterval) return;
		this.#refreshSpinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#refreshSpinnerFrame = (this.#refreshSpinnerFrame + 1) % frameCount;
			}
			this.#tui.requestRender();
		}, 80);
	}

	#stopRefreshSpinnerIfIdle(): void {
		if (this.#refreshingProviders.size > 0) return;
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
		this.#refreshSpinnerFrame = 0;
	}

	#setProviderRefreshing(providerId: string, refreshing: boolean): void {
		if (refreshing) {
			this.#refreshingProviders.add(providerId);
			this.#startRefreshSpinner();
		} else {
			this.#refreshingProviders.delete(providerId);
			this.#stopRefreshSpinnerIfIdle();
		}
	}

	#cancelScheduledRefreshesExcept(keepProviderId?: string): void {
		for (const [providerId, timer] of this.#scheduledProviderRefreshes) {
			if (providerId === keepProviderId) continue;
			clearTimeout(timer);
			this.#scheduledProviderRefreshes.delete(providerId);
			this.#setProviderRefreshing(providerId, false);
		}
	}

	#scheduleProviderRefresh(providerId: string, options?: { force?: boolean }): void {
		if (this.#scopedModels.length > 0 || !providerId) return;
		if (this.#scheduledProviderRefreshes.has(providerId) || this.#refreshingProviders.has(providerId)) return;
		// Hovering a provider must not re-fetch on every visit: auto-refresh runs
		// at most once per provider for the process lifetime. F5 forces a re-fetch.
		if (!options?.force && autoRefreshedProviders.has(providerId)) return;
		this.#setProviderRefreshing(providerId, true);
		const timer = setTimeout(() => {
			// Consume the once-guard only when the fetch actually starts: hopping
			// through a provider cancels the debounce and must not burn its slot.
			autoRefreshedProviders.add(providerId);
			this.#scheduledProviderRefreshes.delete(providerId);
			void this.#refreshProviderInBackground(providerId);
		}, PROVIDER_REFRESH_DEBOUNCE_MS);
		this.#scheduledProviderRefreshes.set(providerId, timer);
	}

	async #refreshProviderInBackground(providerId: string): Promise<void> {
		try {
			await this.#registry.refreshProvider(providerId, "online");
			// The provider refresh already updated the registry snapshot;
			// re-reading it here stays purely in-memory.
			this.#syncFromRegistryState();
		} catch (error) {
			this.#configError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#setProviderRefreshing(providerId, false);
			this.#tui.requestRender();
		}
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) return undefined;
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) return "less than a minute ago";
		return `${Math.round(ageMs / 60_000)}m ago`;
	}

	#emptyStateMessage(): string | undefined {
		if (this.#configError) return `  ${this.#configError}`;
		const entry = this.#activeEntry();
		if (entry.kind === "recent") return "  No recently used models yet";
		if (entry.kind !== "provider" || entry.locked) return undefined;
		if (this.#browser.query.trim()) {
			return `  No matching models in ${entry.label}. Switch to All models to search every provider.`;
		}
		const providerId = entry.providerId ?? "";
		const state = this.#registry.getProviderDiscoveryState(providerId);
		if (!state) return undefined;
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable": {
				const httpMatch = state.error?.match(/^HTTP (\d+) from (.+)$/);
				if (httpMatch?.[1] === "404") {
					return `  Discovery endpoint ${httpMatch[2]} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
				}
				if (state.error) return `  Discovery failed: ${state.error}`;
				return age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.";
			}
			case "unauthenticated":
				return "  Provider requires authentication before models can be discovered.";
			case "idle":
				return "  Provider has not been refreshed yet.";
			case "empty":
				return "  Discovery succeeded but returned 0 models. Check that /models returns { data: [{ id }] }.";
			case "ok":
				return undefined;
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Assignment flow
	// ═══════════════════════════════════════════════════════════════════════

	#activateItem(item: ModelBrowserItem): void {
		if (this.#mode === "pick") {
			this.#callbacks.onPick?.(item.model, item.selector);
			return;
		}
		if (this.#assigningRole) {
			const role = this.#assigningRole;
			this.#assigningRole = null;
			this.#assignRole(item, role, true);
			return;
		}
		this.#openRoleStrip(item);
	}

	/** Persist `role → item`, preserving a still-supported thinking level, then open the thinking strip. */
	#assignRole(item: ModelBrowserItem, role: string, returnToRoles: boolean): void {
		const current = this.#roles[role];
		let level: ConfiguredThinkingLevel = ThinkingLevel.Inherit;
		if (current && !current.autoSelected) {
			const supported = this.#thinkingOptionsFor(item.model);
			level = supported.includes(current.thinkingLevel) ? current.thinkingLevel : ThinkingLevel.Inherit;
		}
		this.#callbacks.onAssign(item.model, role, level, item.selector, "modelRole");
		this.#refreshAfterMutation();
		this.#openThinkingStrip(item, role, returnToRoles);
	}

	#unassignRole(role: string): void {
		const assignment = this.#roles[role];
		if (!assignment || assignment.autoSelected) return;
		this.#callbacks.onUnassign(role);
		this.#refreshAfterMutation();
	}

	#thinkingOptionsFor(model: Model): ConfiguredThinkingLevel[] {
		return [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)];
	}

	#openRoleStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [];
		for (const role of this.#visibleRoleIds()) {
			const info = getRoleInfo(role, this.#settings);
			const assignment = this.#roles[role];
			const assignedHere =
				!!assignment &&
				!assignment.autoSelected &&
				assignment.model.provider === item.model.provider &&
				assignment.model.id === item.model.id;
			const label = (info.tag ?? info.name ?? role).toLowerCase();
			chips.push({
				label,
				styled: assignedHere
					? theme.fg(info.color ?? "muted", `${theme.status.enabled}${label}`) +
						theme.fg("dim", ` ${theme.status.success}`)
					: theme.fg(info.color ?? "muted", label),
				role,
				action: assignedHere ? "unassign" : "assign",
			});
		}
		chips.push({ label: "fallback", styled: theme.fg("muted", "retry-fallback"), action: "fallback" });
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	#openThinkingStrip(item: ModelBrowserItem, role: string, returnToRoles: boolean): void {
		const options = this.#thinkingOptionsFor(item.model);
		const current = this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit;
		const chips: StripChip[] = options.map(level => {
			const label = getConfiguredThinkingLevelMetadata(level).label;
			const glyph = thinkingLevelGlyph(level);
			return {
				label,
				styled: glyph ? `${theme.fg("accent", glyph)} ${label}` : label,
				action: "thinking",
				thinkingLevel: level,
			};
		});
		const preselect = options.indexOf(current);
		this.#strip = {
			kind: "thinking",
			item,
			role,
			chips,
			index: preselect >= 0 ? preselect : 0,
			returnToRoles,
		};
	}

	#closeStrip(): void {
		const strip = this.#strip;
		this.#strip = null;
		this.#chipRanges = [];
		if (strip?.kind === "thinking" && strip.returnToRoles && this.#mode === "roles") {
			this.#setActiveEntry("roles");
		}
	}

	#activateStripChip(): void {
		const strip = this.#strip;
		if (!strip) return;
		const chip = strip.chips[strip.index];
		if (!chip) return;
		switch (chip.action) {
			case "assign":
				if (chip.role) {
					this.#strip = null;
					this.#assignRole(strip.item, chip.role, false);
				}
				return;
			case "unassign":
				if (chip.role) {
					this.#callbacks.onUnassign(chip.role);
					this.#refreshAfterMutation();
				}
				this.#closeStrip();
				return;
			case "fallback":
				this.#callbacks.onAssign(strip.item.model, "default", undefined, strip.item.selector, "retryFallback");
				this.#closeStrip();
				return;
			case "thinking":
				if (strip.role && chip.thinkingLevel !== undefined) {
					this.#callbacks.onAssign(
						strip.item.model,
						strip.role,
						chip.thinkingLevel,
						strip.item.selector,
						"modelRole",
					);
					this.#refreshAfterMutation();
				}
				this.#closeStrip();
				return;
		}
	}

	#startAssignFromRolesView(): void {
		const role = this.#roleIds[this.#roleIndex];
		if (!role) return;
		this.#assigningRole = role;
		this.#focus = "scope";
		this.#browser.setShowProvider(true);
		this.#browser.setItems([...this.#availableItems]);
		this.#browser.setQuery("");
		const current = this.#roles[role];
		if (current) {
			this.#browser.selectSelector(`${current.model.provider}/${current.model.id}`);
		}
	}

	#cancelAssign(): void {
		this.#assigningRole = null;
		this.#browser.setQuery("");
		if (this.#mode === "roles") {
			this.#setActiveEntry("roles");
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}

		if (this.#strip) {
			this.#handleStripInput(data);
			return;
		}

		if (matchesSelectCancel(data)) {
			if (this.#assigningRole !== null) {
				this.#cancelAssign();
				return;
			}
			const entry = this.#activeEntry();
			if (this.#isBrowserView(entry) && this.#browser.query.length > 0) {
				this.#browser.handleCancel();
				return;
			}
			this.#callbacks.onCancel();
			return;
		}

		const entry = this.#activeEntry();
		const rolesView = entry.kind === "roles" && this.#assigningRole === null;
		const lockedView = entry.kind === "provider" && entry.locked && this.#assigningRole === null;

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			return;
		}
		if (matchesKey(data, "f5")) {
			if (entry.kind === "provider" && !entry.locked) {
				this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
			}
			return;
		}

		// Arrow ownership: scope mode hops the sidebar even while the search
		// bar holds the caret; list mode navigates rows.
		if (this.#focus === "scope") {
			if (matchesSelectUp(data)) {
				this.#moveSidebar(-1);
				return;
			}
			if (matchesSelectDown(data)) {
				this.#moveSidebar(1);
				return;
			}
		}

		if (rolesView) {
			this.#handleRolesViewInput(data);
			return;
		}
		if (lockedView) {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#requestLogin(entry);
			}
			return;
		}
		this.#browser.handleInput(data);
	}

	#isBrowserView(entry: SidebarEntry): boolean {
		if (this.#assigningRole !== null) return true;
		return entry.kind === "recent" || entry.kind === "all" || (entry.kind === "provider" && !entry.locked);
	}

	#handleStripInput(data: string): void {
		const strip = this.#strip;
		if (!strip) return;
		if (matchesSelectCancel(data)) {
			this.#closeStrip();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			strip.index = (strip.index - 1 + strip.chips.length) % strip.chips.length;
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
			strip.index = (strip.index + 1) % strip.chips.length;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateStripChip();
			return;
		}
	}

	#moveSidebar(delta: number): void {
		const count = this.#entries.length;
		if (count === 0) return;
		let index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		if (index < 0) index = 0;
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = this.#entries[index];
			if (entry && !this.#isHopSkipped(entry)) {
				// Scope changes keep an active assignment (scoping helps find the
				// model); landing on the Roles view cancels it.
				if (entry.kind === "roles") this.#assigningRole = null;
				this.#setActiveEntry(entry.id);
				return;
			}
		}
	}

	#handleRolesViewInput(data: string): void {
		if (matchesSelectUp(data)) {
			this.#roleIndex = (this.#roleIndex - 1 + this.#roleIds.length) % Math.max(1, this.#roleIds.length);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#roleIndex = (this.#roleIndex + 1) % Math.max(1, this.#roleIds.length);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#startAssignFromRolesView();
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			const role = this.#roleIds[this.#roleIndex];
			if (role) this.#unassignRole(role);
			return;
		}
		const printable = extractPrintableText(data);
		if (printable === "x") {
			const role = this.#roleIds[this.#roleIndex];
			if (role) this.#unassignRole(role);
			return;
		}
		if (printable === "t") {
			const role = this.#roleIds[this.#roleIndex];
			const assignment = role ? this.#roles[role] : undefined;
			if (role && assignment) {
				const item: ModelBrowserItem = {
					provider: assignment.model.provider,
					id: assignment.model.id,
					model: assignment.model,
					selector: `${assignment.model.provider}/${assignment.model.id}`,
				};
				this.#openThinkingStrip(item, role, true);
			}
			return;
		}
	}

	#requestLogin(entry: SidebarEntry): void {
		if (!entry.providerId) return;
		if (entry.oauth) {
			this.#callbacks.onLoginRequest?.(entry.providerId);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mouse
	// ═══════════════════════════════════════════════════════════════════════

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const contentLine = event.row - this.#contentRowStart;
		const overContent = contentLine >= 0 && contentLine < this.#contentRowCount;
		const sidebarColStart = 2;
		const sidebarColEnd = sidebarColStart + this.#sidebarWidthLast;
		const bodyColStart = this.#sidebarWidthLast + 5;
		const overSidebar = overContent && event.col >= 0 && event.col < sidebarColEnd;
		const overBody = overContent && event.col >= bodyColStart;
		const bodyLine = contentLine - 1; // body row 0 is the status row
		const entry = this.#activeEntry();

		// Footer strip chips.
		if (event.row === this.#footerRow && this.#strip) {
			if (event.leftClick) {
				for (const range of this.#chipRanges) {
					if (event.col >= range.start && event.col < range.end) {
						this.#strip.index = range.index;
						this.#activateStripChip();
						return true;
					}
				}
			}
			return true;
		}

		if (event.wheel !== null) {
			if (overSidebar) {
				this.#moveSidebar(event.wheel);
			} else if (overBody) {
				if (entry.kind === "roles" && this.#assigningRole === null) {
					const count = Math.max(1, this.#roleIds.length);
					this.#roleIndex = (this.#roleIndex + event.wheel + count) % count;
				} else if (this.#isBrowserView(entry)) {
					this.#browser.routeMouse(event, bodyLine);
				}
			}
			return true;
		}

		if (event.motion) {
			this.#sidebarHover = overSidebar ? this.#sidebarEntryIndexAt(contentLine) : null;
			if (overBody && entry.kind === "roles" && this.#assigningRole === null) {
				const roleLine = bodyLine - this.#rolesRowStart;
				this.#roleHover = roleLine >= 0 && roleLine < this.#roleIds.length ? roleLine : null;
			} else {
				this.#roleHover = null;
				if (overBody && this.#isBrowserView(entry)) {
					this.#browser.routeMouse(event, bodyLine);
				}
			}
			return true;
		}

		if (!event.leftClick) return true;

		if (overSidebar) {
			const index = this.#sidebarEntryIndexAt(contentLine);
			const clicked = index !== null ? this.#entries[index] : undefined;
			if (clicked && clicked.kind !== "separator") {
				const already = clicked.id === this.#activeEntryId;
				if (clicked.kind === "roles") this.#assigningRole = null;
				this.#setActiveEntry(clicked.id);
				if (already && clicked.kind === "provider" && clicked.locked) {
					this.#requestLogin(clicked);
				}
			}
			return true;
		}

		if (overBody) {
			if (entry.kind === "roles" && this.#assigningRole === null) {
				const roleLine = bodyLine - this.#rolesRowStart;
				if (roleLine >= 0 && roleLine < this.#roleIds.length) {
					if (roleLine === this.#roleIndex) {
						this.#startAssignFromRolesView();
					} else {
						this.#roleIndex = roleLine;
					}
				}
			} else if (entry.kind === "provider" && entry.locked && this.#assigningRole === null) {
				if (this.#lockedLoginLine !== null && bodyLine === this.#lockedLoginLine) {
					this.#requestLogin(entry);
				}
			} else if (this.#isBrowserView(entry)) {
				this.#browser.routeMouse(event, bodyLine);
			}
		}
		return true;
	}

	/** Map a content-line index to a sidebar entry index (accounting for scroll). */
	#sidebarEntryIndexAt(contentLine: number): number | null {
		const index = this.#sidebarScroll + contentLine;
		if (index < 0 || index >= this.#entries.length) return null;
		return index;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	#sidebarWidth(): number {
		let longest = 0;
		for (const entry of this.#entries) {
			const annotation = entry.annotation ?? "";
			longest = Math.max(longest, visibleWidth(entry.label) + visibleWidth(annotation) + 5);
		}
		return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, longest));
	}

	#renderSidebar(width: number, rows: number): string[] {
		const activeIndex = Math.max(
			0,
			this.#entries.findIndex(entry => entry.id === this.#activeEntryId),
		);
		if (this.#entries.length > rows) {
			this.#sidebarScroll = Math.max(0, Math.min(activeIndex - Math.floor(rows / 2), this.#entries.length - rows));
		} else {
			this.#sidebarScroll = 0;
		}

		const lines: string[] = [];
		for (let i = this.#sidebarScroll; i < Math.min(this.#entries.length, this.#sidebarScroll + rows); i++) {
			const entry = this.#entries[i];
			if (!entry) continue;
			if (entry.kind === "separator") {
				lines.push(theme.fg("border", "─".repeat(width)));
				continue;
			}
			const active = entry.id === this.#activeEntryId;
			const hovered = i === this.#sidebarHover;
			const searching = this.#searchCounts !== null;
			const matchCount =
				searching && entry.kind === "provider" && !entry.locked
					? (this.#searchCounts?.get(entry.providerId ?? "") ?? 0)
					: undefined;
			// While searching, providers without matches gray out alongside
			// locked ones (the scope hop skips both).
			const muted = entry.locked || matchCount === 0;
			const cursor = active
				? this.#focus === "scope"
					? theme.fg("accent", theme.nav.cursor)
					: theme.fg("dim", theme.nav.cursor)
				: " ";

			let icon: string;
			if (entry.kind === "recent") {
				icon = theme.icon.time;
			} else if (entry.kind === "roles") {
				icon = theme.icon.extensionSkill;
			} else if (entry.kind === "all") {
				icon = theme.icon.model;
			} else {
				icon = muted ? theme.status.shadowed : theme.status.enabled;
			}
			const labelStyled = muted
				? theme.fg("dim", entry.label)
				: active
					? theme.fg("accent", entry.label)
					: entry.label;

			const refreshing = entry.providerId ? this.#refreshingProviders.has(entry.providerId) : false;
			const annotationText = matchCount !== undefined ? String(matchCount) : (entry.annotation ?? "");
			const annotationStyled = refreshing
				? theme.fg("warning", theme.spinnerFrames[this.#refreshSpinnerFrame % theme.spinnerFrames.length] ?? "")
				: theme.fg("dim", annotationText);

			const left = `${cursor} ${muted ? theme.fg("dim", icon) : theme.fg(entry.kind === "provider" ? "success" : "accent", icon)} ${labelStyled}`;
			const leftWidth = visibleWidth(left);
			const annWidth = visibleWidth(annotationStyled);
			let line: string;
			if (leftWidth + annWidth + 1 <= width) {
				line = `${left}${" ".repeat(width - leftWidth - annWidth)}${annotationStyled}`;
			} else {
				line = truncateToWidth(left, width);
			}
			if (hovered && !active) {
				line = theme.bg("selectedBg", line);
			}
			lines.push(line);
		}
		return lines;
	}

	#statusRow(width: number): string {
		if (this.#assigningRole !== null) {
			const info = getRoleInfo(this.#assigningRole, this.#settings);
			const label = info.tag ?? info.name ?? this.#assigningRole;
			return truncateToWidth(
				theme.fg("accent", ` Assigning ${theme.bold(label)} — Enter assigns, Esc cancels`),
				width,
			);
		}
		const entry = this.#activeEntry();
		const scopedSuffix = this.#scopedModels.length > 0 ? " · --models scope" : "";
		let text: string;
		switch (entry.kind) {
			case "recent":
				text = this.#mode === "pick" ? this.#pickerHint : `Recently used models${scopedSuffix}`;
				break;
			case "roles":
				text = "Model roles — assignments fall back to auto-selection when cleared";
				break;
			case "provider":
				if (entry.locked) {
					text = `${entry.label} · not configured`;
				} else if (entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
					text = `${entry.label} · refreshing model list…`;
				} else {
					text = `${entry.label} · ${entry.annotation ?? "0"} models${scopedSuffix}`;
				}
				break;
			default:
				text = this.#mode === "pick" ? this.#pickerHint : `All available models${scopedSuffix}`;
				break;
		}
		if (this.#configError && entry.kind !== "provider") {
			text = this.#configError;
			return truncateToWidth(theme.fg("error", ` ${text}`), width);
		}
		return truncateToWidth(theme.fg("muted", ` ${text}`), width);
	}

	#renderRolesView(width: number, rows: number): string[] {
		const lines: string[] = [];
		lines.push("");
		this.#rolesRowStart = lines.length + 1; // +1 for the status row offset handled by caller

		let tagWidth = 0;
		for (const role of this.#roleIds) {
			const info = getRoleInfo(role, this.#settings);
			tagWidth = Math.max(tagWidth, visibleWidth(info.tag ?? info.name ?? role));
		}

		for (let i = 0; i < this.#roleIds.length && lines.length < rows - 1; i++) {
			const role = this.#roleIds[i];
			const info = getRoleInfo(role, this.#settings);
			const assignment = this.#roles[role];
			const selected = i === this.#roleIndex;
			const hovered = i === this.#roleHover;
			const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
			const tag = (info.tag ?? info.name ?? role).padEnd(tagWidth);

			let dot: string;
			let tagStyled: string;
			let value: string;
			let levelStyled = "";
			if (assignment && !assignment.autoSelected) {
				dot = theme.fg(info.color ?? "muted", theme.status.enabled);
				tagStyled = theme.fg(info.color ?? "muted", tag);
				value = `${theme.fg("dim", `${assignment.model.provider}/`)}${selected ? theme.fg("accent", assignment.model.id) : assignment.model.id}`;
				const glyph = thinkingLevelGlyph(assignment.thinkingLevel);
				const label = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				if (assignment.thinkingLevel !== ThinkingLevel.Inherit) {
					levelStyled = theme.fg("dim", glyph ? `${glyph} ${label}` : label);
				}
			} else if (assignment) {
				dot = theme.fg("dim", theme.status.shadowed);
				tagStyled = theme.fg("dim", tag);
				value = theme.fg("dim", `auto → ${assignment.model.provider}/${assignment.model.id}`);
			} else {
				dot = theme.fg("dim", theme.status.shadowed);
				tagStyled = theme.fg("dim", tag);
				value = theme.fg("dim", "—");
			}

			let line = ` ${cursor} ${dot} ${tagStyled}  ${value}`;
			const levelWidth = visibleWidth(levelStyled);
			const lineWidth = visibleWidth(line);
			if (levelWidth > 0 && lineWidth + levelWidth + 2 <= width) {
				line = `${line}${" ".repeat(width - lineWidth - levelWidth - 1)}${levelStyled}`;
			} else {
				line = truncateToWidth(line, width);
			}
			if (hovered && !selected) {
				line = theme.bg("selectedBg", line);
			}
			lines.push(line);
		}

		while (lines.length < rows) lines.push("");
		return lines;
	}

	#renderLockedView(entry: SidebarEntry, width: number, rows: number): string[] {
		const lines: string[] = [];
		this.#lockedLoginLine = null;
		lines.push("");
		lines.push(truncateToWidth(theme.fg("warning", `  ${entry.label} has no credentials configured`), width));
		lines.push("");
		const envVars = entry.providerId ? (getCatalogProviderEntry(entry.providerId)?.envVars ?? []) : [];
		if (envVars.length > 0) {
			lines.push(
				truncateToWidth(
					theme.fg("muted", `  Set ${envVars.join(" or ")} in your environment, or add a key in config.`),
					width,
				),
			);
		} else {
			lines.push(truncateToWidth(theme.fg("muted", "  Add an API key for this provider in config."), width));
		}
		if (entry.oauth) {
			this.#lockedLoginLine = lines.length + 1; // +1 for the status row offset handled by caller
			lines.push(truncateToWidth(theme.fg("accent", `  ${theme.nav.cursor} Log in with OAuth (Enter)`), width));
		}
		lines.push("");
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `  ${catalogCount} models in catalog:`), width));
			const preview = this.#scopedModels.length > 0 ? [] : this.#registry.getAll();
			for (const model of preview) {
				if (model.provider !== entry.providerId) continue;
				if (lines.length >= rows) break;
				lines.push(truncateToWidth(theme.fg("dim", `    ${model.id}`), width));
			}
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(): string {
		const strip = this.#strip;
		if (strip) {
			return strip.kind === "role"
				? "←/→ choose · Enter assign/clear · Esc cancel"
				: "←/→ thinking level · Enter apply · Esc keep";
		}
		if (this.#assigningRole !== null) {
			return "Enter assign · ↑/↓ providers · type to search · Esc cancel";
		}
		const entry = this.#activeEntry();
		if (entry.kind === "roles") {
			return this.#focus === "list"
				? "↑/↓ roles · Enter pick model · x clear · t thinking · Tab providers · Esc close"
				: "↑/↓ providers · Tab roles · Esc close";
		}
		if (entry.kind === "provider" && entry.locked) {
			return entry.oauth ? "Enter log in · ↑/↓ providers · Esc close" : "↑/↓ providers · Esc close";
		}
		const arrows = this.#focus === "scope" ? "↑/↓ providers · Tab models" : "↑/↓ models · Tab providers";
		const refresh = entry.kind === "provider" ? " · F5 refresh" : "";
		if (this.#mode === "pick") {
			return `Enter use for this session · ${arrows} · type to search${refresh} · Esc close`;
		}
		return `Enter assign roles · ${arrows} · type to search${refresh} · Esc close`;
	}

	/** Footer row: active strip (chips) or the contextual hint line. */
	#renderFooter(width: number): string {
		this.#chipRanges = [];
		const strip = this.#strip;
		if (!strip) {
			return truncateToWidth(theme.fg("dim", this.#footerHint()), width);
		}

		const prefix =
			strip.kind === "role"
				? `${theme.fg("accent", strip.item.id)}${theme.fg("dim", " →")} `
				: `${theme.fg(getRoleInfo(strip.role ?? "", this.#settings).color ?? "muted", (getRoleInfo(strip.role ?? "", this.#settings).tag ?? strip.role ?? "").toLowerCase())}${theme.fg("dim", ` · ${strip.item.id} →`)} `;

		let line = prefix;
		// Columns are relative to the frame: row() insets content by 2.
		let col = 2 + visibleWidth(prefix);
		for (let i = 0; i < strip.chips.length; i++) {
			const chip = strip.chips[i];
			if (!chip) continue;
			const selected = i === strip.index;
			const body = ` ${chip.styled} `;
			const rendered = selected
				? theme.bg("selectedBg", `${theme.fg("accent", "[")}${body}${theme.fg("accent", "]")}`)
				: body;
			const w = visibleWidth(body) + (selected ? 2 : 0);
			this.#chipRanges.push({ start: col, end: col + w, index: i });
			line += rendered;
			col += w;
			line += " ";
			col += 1;
		}
		return truncateToWidth(line, width);
	}

	render(width: number): string[] {
		const height = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const sidebarWidth = this.#sidebarWidth();
		this.#sidebarWidthLast = sidebarWidth;
		const bodyWidth = splitBodyWidth(width, sidebarWidth);
		const contentRows = Math.max(10, height - 4);
		this.#contentRowCount = contentRows;

		const entry = this.#activeEntry();
		const bodyLines: string[] = [this.#statusRow(bodyWidth)];
		if (entry.kind === "roles" && this.#assigningRole === null) {
			bodyLines.push(...this.#renderRolesView(bodyWidth, contentRows - 1));
		} else if (entry.kind === "provider" && entry.locked && this.#assigningRole === null) {
			bodyLines.push(...this.#renderLockedView(entry, bodyWidth, contentRows - 1));
		} else {
			this.#browser.setMaxVisible(contentRows - 1 - 5);
			bodyLines.push(...this.#browser.render(bodyWidth));
		}

		const sidebarLines = this.#renderSidebar(sidebarWidth, contentRows);

		const title = this.#mode === "pick" ? "Switch Model" : "Models";
		const out: string[] = [];
		out.push(topBorderSplit(width, title, sidebarWidth));
		this.#contentRowStart = out.length;
		for (let i = 0; i < contentRows; i++) {
			out.push(splitRow(sidebarLines[i] ?? "", bodyLines[i] ?? "", width, sidebarWidth));
		}
		out.push(dividerSplit(width, sidebarWidth));
		this.#footerRow = out.length;
		out.push(row(this.#renderFooter(width - 4), width));
		out.push(bottomBorder(width));
		return out;
	}
}
