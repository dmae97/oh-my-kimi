/**
 * Effort-tier variant collapsing.
 *
 * Some providers expose one logical model as several effort- or
 * thinking-suffixed upstream ids (Antigravity CCA:
 * `gemini-3.5-flash-extra-low`/`-low`, `claude-*`/`claude-*-thinking` pairs;
 * aggregators: `X`/`X-thinking` twins). Collapsing replaces the member specs
 * with one logical spec whose `thinking.effortRouting` records the per-effort
 * upstream wire id; request-time code resolves the outbound id via
 * `resolveWireModelId` and everything local (selection, caching, usage
 * attribution) keys on the logical `id`.
 *
 * Families come from two sources:
 * - Hand tables (`VARIANT_COLLAPSE_TABLES`) for providers whose routing needs
 *   curation (Antigravity tier triplets, single-member renames, recycled ids).
 * - `deriveThinkingPairFamilies`: the global automatic rule — any live
 *   `X` + `X-thinking` pair (trailing or infix token) collapses into `X`,
 *   routing thinking-enabled requests to `X-thinking`. Gated on identical
 *   pricing and same api: price-divergent twins are distinct SKUs and stay
 *   separate so billing attribution never lies.
 *
 * Family invariants (hold for hand-written and derived tables):
 * - One axis per family. A second id axis (e.g. Cursor's `-fast` service
 *   tier) becomes a sibling family, never a second routing dimension.
 * - The collapsed spec inherits non-tier fields from the first present
 *   member; members must be cost-homogeneous.
 *
 * `collapseEffortVariants` is pure, deterministic, and idempotent:
 * `collapse(collapse(x))` equals `collapse(x)`, and mixed raw+collapsed input
 * (stale cache rows, previous-snapshot fallbacks) dedupes to the collapsed
 * entry. That makes it safe at every source — discovery, the catalog
 * generator, and the model-manager merge point.
 */
import { buildCompat, buildModel } from "./build";
import { Effort } from "./effort";
import { stripThinkingVariantToken } from "./identity/family";
import { resolveModelThinking } from "./model-thinking";
import type { Api, Model, ModelSpec, Provider, ThinkingConfig } from "./types";

/**
 * Structural bound for collapse inputs: both raw `ModelSpec`s and built
 * `Model`s qualify. (`Model.compat` is the resolved record, not the sparse
 * config, so the two are not mutually assignable — collapsing never touches
 * `compat`.)
 */
export type VariantSpecLike = Omit<ModelSpec<Api>, "compat"> & { compat?: unknown };

/** One collapsed family: logical id + member wire ids + per-effort routing. */
export interface EffortVariantFamily {
	/** Collapsed logical id (may equal a member id — e.g. bare/thinking pairs). */
	id: string;
	/** Final display name, no tier marker. */
	name: string;
	/**
	 * Member wire ids in priority order. The first member present in the input
	 * becomes the collapsed spec's default wire id (`requestModelId`; omitted
	 * when it equals the logical id).
	 */
	members: readonly string[];
	/**
	 * Wire ids upstream no longer serves (e.g. a deployment killed while
	 * discovery still advertises it). Fresh collapsing never routes to them,
	 * and stale collapsed snapshots (bundled catalog, cache rows,
	 * previous-generation fallbacks) get routing/`requestModelId` entries that
	 * target them re-pointed through `routing`. Keep retired ids in `members`
	 * so the raw upstream spec is still consumed and aliased.
	 */
	retiredMembers?: readonly string[];
	/**
	 * Per-effort upstream wire id; `"off"` applies when thinking is disabled.
	 * Entries whose target member is absent from the input are dropped — those
	 * efforts fall back to `requestModelId ?? id`.
	 */
	routing: Readonly<Partial<Record<Effort | "off", string>>>;
	/** Explicit capability surface for the collapsed spec — no inference. */
	thinking: Readonly<Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff">>;
	/** Thinking-off requests must explicitly suppress thinking on the wire. */
	suppressWhenOff?: boolean;
	/** Retired/recycled selector ids that alias to this family without being members. */
	extraAliases?: readonly string[];
}

export interface VariantCollapseTable {
	families: readonly EffortVariantFamily[];
}

/** `X` + `X-thinking` hand family: off routes to the bare id, efforts to `-thinking`. */
function thinkingPair(baseId: string, name: string): EffortVariantFamily {
	return {
		id: baseId,
		name,
		members: [baseId, `${baseId}-thinking`],
		routing: {
			off: baseId,
			[Effort.Minimal]: `${baseId}-thinking`,
			[Effort.Low]: `${baseId}-thinking`,
			[Effort.Medium]: `${baseId}-thinking`,
			[Effort.High]: `${baseId}-thinking`,
		},
		// Thinking-off routes to the non-thinking backing id, where omitting
		// thinkingConfig is already correct — no suppressWhenOff.
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	};
}

const GEMINI_3_FLASH_FAMILY_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const GEMINI_3_PRO_FAMILY_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High];

/**
 * Shared by `google-antigravity` and `google-gemini-cli` — both serve the
 * Antigravity discovery list (`fetchAntigravityDiscoveryModels`).
 */
export const ANTIGRAVITY_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [
		{
			id: "gemini-3.5-flash",
			name: "Gemini 3.5 Flash",
			members: ["gemini-3.5-flash-extra-low", "gemini-3.5-flash-low", "gemini-3-flash-agent"],
			routing: {
				off: "gemini-3.5-flash-extra-low",
				[Effort.Minimal]: "gemini-3-flash-agent",
				[Effort.Low]: "gemini-3.5-flash-extra-low",
				[Effort.Medium]: "gemini-3.5-flash-extra-low",
				[Effort.High]: "gemini-3.5-flash-low",
			},
			thinking: { mode: "google-level", efforts: GEMINI_3_FLASH_FAMILY_EFFORTS },
			suppressWhenOff: true,
			// Retired bare id; the alias only fires when no live model holds it
			// (exact match wins in every resolver).
			extraAliases: ["gemini-3-flash"],
		},
		{
			id: "gemini-3.1-pro",
			name: "Gemini 3.1 Pro",
			// High routes to `gemini-pro-agent` — the upstream `gemini-3.1-pro-high`
			// deployment returns INVALID_ARGUMENT on every streamGenerateContent
			// request (both CCA endpoints) while discovery still lists it;
			// `gemini-pro-agent` is the same model ("Gemini 3.1 Pro (High)", same
			// thinking budget/caps) and accepts the identical request body.
			// `gemini-3.1-pro-high` stays a member so the dead raw id is consumed.
			members: ["gemini-3.1-pro-low", "gemini-pro-agent", "gemini-3.1-pro-high"],
			retiredMembers: ["gemini-3.1-pro-high"],
			routing: {
				off: "gemini-3.1-pro-low",
				[Effort.Low]: "gemini-3.1-pro-low",
				[Effort.High]: "gemini-pro-agent",
			},
			thinking: { mode: "google-level", efforts: GEMINI_3_PRO_FAMILY_EFFORTS },
			suppressWhenOff: true,
		},
		{
			// Legacy static family — covers stale snapshots and caches.
			id: "gemini-3-pro",
			name: "Gemini 3 Pro",
			members: ["gemini-3-pro-low", "gemini-3-pro-high"],
			routing: {
				off: "gemini-3-pro-low",
				[Effort.Low]: "gemini-3-pro-low",
				[Effort.High]: "gemini-3-pro-high",
			},
			thinking: { mode: "google-level", efforts: GEMINI_3_PRO_FAMILY_EFFORTS },
			suppressWhenOff: true,
		},
		{
			// Rename-only collapse: every effort and off fall back to the wire id.
			id: "gpt-oss-120b",
			name: "GPT-OSS 120B",
			members: ["gpt-oss-120b-medium"],
			routing: {},
			thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		},
		thinkingPair("claude-sonnet-4-6", "Claude Sonnet 4.6"),
		thinkingPair("claude-opus-4-6", "Claude Opus 4.6"),
		thinkingPair("claude-sonnet-4-5", "Claude Sonnet 4.5"),
		thinkingPair("claude-opus-4-5", "Claude Opus 4.5"),
		thinkingPair("gemini-2.5-flash", "Gemini 2.5 Flash"),
	],
};

/** Provider id → hand collapse table. Both CCA providers share one table. */
export const VARIANT_COLLAPSE_TABLES: Readonly<Record<string, VariantCollapseTable>> = {
	"google-antigravity": ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
	"google-gemini-cli": ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
};

/**
 * The global automatic rule: derive an `X` + `X-thinking` family for every
 * pair where both ids are live in `specs` (trailing or infix token). Gates:
 * - both members share the same `api`,
 * - known pricing must match — all-zero cost rows count as unknown
 *   (aggregators routinely ship them), but twins that BOTH carry real,
 *   differing prices are distinct SKUs and never merge,
 * - ids claimed by the provider's hand `table` are skipped (curation wins).
 * The capability surface prefers the thinking member's metadata, then the
 * bare member's, then the canonical deriver (aggregators often ship
 * `reasoning: false` and no thinking config on the twin), then a budget
 * default. `off` routes to the bare id; every supported effort routes to the
 * thinking id.
 */
export function deriveThinkingPairFamilies<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table?: VariantCollapseTable,
): EffortVariantFamily[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}
	const claimed = table ? getAliasIndex(table) : undefined;
	const families: EffortVariantFamily[] = [];
	for (const spec of specs) {
		const baseId = stripThinkingVariantToken(spec.id);
		if (baseId === undefined || baseId === spec.id) continue;
		const base = byId.get(baseId);
		if (!base) continue;
		if (claimed) {
			const forward = claimed.forward;
			if (
				forward.has(spec.id.toLowerCase()) ||
				forward.has(baseId.toLowerCase()) ||
				claimed.familyIds.has(spec.id) ||
				claimed.familyIds.has(baseId)
			) {
				continue;
			}
		}
		if (spec.api !== base.api) continue;
		const specPriced = spec.cost.input !== 0 || spec.cost.output !== 0;
		const basePriced = base.cost.input !== 0 || base.cost.output !== 0;
		if (
			specPriced &&
			basePriced &&
			(spec.cost.input !== base.cost.input ||
				spec.cost.output !== base.cost.output ||
				spec.cost.cacheRead !== base.cost.cacheRead ||
				spec.cost.cacheWrite !== base.cost.cacheWrite)
		) {
			continue;
		}
		const surface = derivePairThinkingSurface(spec, base);
		const routing: Partial<Record<Effort | "off", string>> = { off: base.id };
		for (const effort of surface.efforts) {
			routing[effort] = spec.id;
		}
		families.push({
			id: base.id,
			name: base.name,
			members: [base.id, spec.id],
			routing,
			thinking: surface,
		});
	}
	return families;
}

const DEFAULT_PAIR_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];

/**
 * Surface fallback chain: thinking member → bare member → canonical deriver →
 * budget default. `requiresEffort` is dropped from every source: the COLLAPSED
 * pair can disable thinking (off routes to the bare backing id), even though
 * the thinking member alone cannot.
 */
function derivePairThinkingSurface(
	thinkingSpec: VariantSpecLike,
	baseSpec: VariantSpecLike,
): Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff" | "requiresEffort"> {
	const baked = thinkingSpec.thinking ?? baseSpec.thinking;
	if (baked && baked.efforts.length > 0) {
		const { effortRouting: _routing, suppressWhenOff: _suppress, requiresEffort: _required, ...surface } = baked;
		return surface;
	}
	const derived = resolveModelThinking(
		{ ...(thinkingSpec as unknown as ModelSpec<Api>), reasoning: true, thinking: undefined },
		buildCompat(thinkingSpec as unknown as ModelSpec<Api>),
	);
	if (derived && derived.efforts.length > 0) {
		const { effortRouting: _dRouting, suppressWhenOff: _dSuppress, requiresEffort: _dRequired, ...surface } = derived;
		return surface;
	}
	return { mode: "budget", efforts: DEFAULT_PAIR_EFFORTS };
}

/**
 * True when `spec` is the output of collapsing rather than a raw upstream
 * member. `thinking.effortRouting` is written only by collapsing; the
 * `requestModelId` arm is scoped to the provider's hand-table family ids so
 * unrelated carriers (GitHub Copilot `-1m` context variants) never match.
 */
export function isVariantCollapsedSpec(spec: VariantSpecLike): boolean {
	if (spec.thinking?.effortRouting !== undefined) {
		return true;
	}
	if (spec.requestModelId === undefined) {
		return false;
	}
	const table = VARIANT_COLLAPSE_TABLES[spec.provider];
	return table !== undefined && getAliasIndex(table).familyIds.has(spec.id);
}

/**
 * Re-point a stale collapsed spec whose `requestModelId` or routing still
 * targets a retired wire id. Collapsed snapshots (bundled catalog, cache
 * rows, previous-generation fallbacks) pass through collapsing untouched, so
 * a hand-table routing fix would otherwise never reach them. Only retired
 * targets are rewritten — presence-filtered routing decisions from live
 * discovery stay authoritative for everything else. Per retired entry the
 * table's route for that effort wins, then the off/first-live-member wire id,
 * then the route is dropped (falls back to `requestModelId ?? id`). Returns
 * `spec` by reference when nothing targets a retired id.
 */
function reconcileRetiredRouting<TSpec extends VariantSpecLike>(
	spec: TSpec,
	family: EffortVariantFamily,
	retired: ReadonlySet<string>,
): TSpec {
	const routing = spec.thinking?.effortRouting;
	const requestRetired = spec.requestModelId !== undefined && retired.has(spec.requestModelId);
	let routingRetired = false;
	if (routing !== undefined) {
		for (const key in routing) {
			const target = routing[key as Effort | "off"];
			if (target !== undefined && retired.has(target)) {
				routingRetired = true;
				break;
			}
		}
	}
	if (!requestRetired && !routingRetired) return spec;

	const offTarget = family.routing.off;
	const fallbackWireId =
		offTarget !== undefined && !retired.has(offTarget) ? offTarget : family.members.find(id => !retired.has(id));
	const next: TSpec = { ...spec };
	if (routingRetired && routing !== undefined) {
		const nextRouting: Partial<Record<Effort | "off", string>> = {};
		for (const key in routing) {
			const effortKey = key as Effort | "off";
			const target = routing[effortKey];
			if (target === undefined) continue;
			if (!retired.has(target)) {
				nextRouting[effortKey] = target;
				continue;
			}
			const tableTarget = family.routing[effortKey];
			if (tableTarget !== undefined && !retired.has(tableTarget)) {
				nextRouting[effortKey] = tableTarget;
			} else if (fallbackWireId !== undefined) {
				nextRouting[effortKey] = fallbackWireId;
			}
		}
		next.thinking = { ...(spec.thinking as ThinkingConfig), effortRouting: nextRouting };
	}
	if (requestRetired) {
		if (fallbackWireId !== undefined && fallbackWireId !== spec.id) {
			next.requestModelId = fallbackWireId;
		} else {
			delete next.requestModelId;
		}
	}
	return next;
}

/**
 * Collapse every family in `table` found in `specs`. Non-member specs pass
 * through verbatim (by reference), order preserved; the collapsed spec
 * replaces the first occurrence of its family.
 */
export function collapseEffortVariants<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table: VariantCollapseTable,
): TSpec[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}

	/** family id → spec to emit at the family's first occurrence. */
	const replacement = new Map<string, TSpec>();
	/** spec ids that belong to a touched family (members + logical id). */
	const familyIdBySpecId = new Map<string, string>();

	for (const family of table.families) {
		const retired =
			family.retiredMembers !== undefined && family.retiredMembers.length > 0
				? new Set(family.retiredMembers)
				: undefined;
		const existing = byId.get(family.id);
		const existingCollapsed =
			existing !== undefined &&
			(existing.requestModelId !== undefined || existing.thinking?.effortRouting !== undefined);
		const reconciled =
			existing !== undefined && existingCollapsed && retired !== undefined
				? reconcileRetiredRouting(existing, family, retired)
				: existing;
		const rawPresent = family.members.filter(id => byId.has(id) && !(id === family.id && existingCollapsed));
		if (rawPresent.length === 0) {
			// Inert (no members) or already collapsed (pass-through) — idempotence.
			// A stale collapsed entry still gets retired routing re-pointed.
			if (reconciled !== undefined && reconciled !== existing) {
				familyIdBySpecId.set(family.id, family.id);
				replacement.set(family.id, reconciled);
			}
			continue;
		}

		for (const id of rawPresent) familyIdBySpecId.set(id, family.id);
		if (existing) familyIdBySpecId.set(family.id, family.id);

		if (existingCollapsed) {
			// Mixed input: the collapsed entry (live truth) wins; stale raw
			// members are deduped away. Retired targets are re-pointed first.
			replacement.set(family.id, reconciled as TSpec);
			continue;
		}

		const memberSpecs = rawPresent.map(id => byId.get(id) as TSpec);
		const presentSet = new Set(rawPresent);
		const routing: Partial<Record<Effort | "off", string>> = {};
		let hasRouting = false;
		let hasEffortRoute = false;
		for (const effortKey in family.routing) {
			const target = family.routing[effortKey as Effort | "off"];
			if (target !== undefined && presentSet.has(target) && !retired?.has(target)) {
				routing[effortKey as Effort | "off"] = target;
				hasRouting = true;
				if (effortKey !== "off") hasEffortRoute = true;
			}
		}

		// A family that routes efforts to a live thinking backing id reasons
		// even when upstream metadata forgot to mark the members.
		const reasoning = memberSpecs.some(spec => spec.reasoning) || hasEffortRoute;
		const thinking: ThinkingConfig = { ...family.thinking };
		if (hasRouting) thinking.effortRouting = routing;
		if (family.suppressWhenOff) thinking.suppressWhenOff = true;

		const input: ("text" | "image")[] = [];
		if (memberSpecs.some(spec => spec.input.includes("text"))) input.push("text");
		if (memberSpecs.some(spec => spec.input.includes("image"))) input.push("image");

		const collapsed: TSpec = {
			...(memberSpecs[0] as TSpec),
			id: family.id,
			name: family.name,
			reasoning,
			input,
			contextWindow: Math.max(...memberSpecs.map(spec => spec.contextWindow)),
			maxTokens: Math.max(...memberSpecs.map(spec => spec.maxTokens)),
		};
		// The default wire id is the highest-priority live member; omit when it
		// equals the logical id (bare/thinking pairs) — `resolveWireModelId`
		// falls back. Retired members never become the default.
		const defaultWireId = rawPresent.find(id => !retired?.has(id)) ?? rawPresent[0];
		if (defaultWireId === family.id) {
			delete collapsed.requestModelId;
		} else {
			collapsed.requestModelId = defaultWireId as string;
		}
		if (reasoning) {
			collapsed.thinking = thinking;
		} else {
			delete collapsed.thinking;
		}
		replacement.set(family.id, collapsed);
	}

	if (replacement.size === 0) return [...specs];

	const emitted = new Set<string>();
	const out: TSpec[] = [];
	for (const spec of specs) {
		const familyId = familyIdBySpecId.get(spec.id);
		if (familyId === undefined) {
			out.push(spec);
			continue;
		}
		if (emitted.has(familyId)) continue;
		emitted.add(familyId);
		out.push(replacement.get(familyId) as TSpec);
	}
	return out;
}

/**
 * Collapse a full mixed-provider list: per provider, the hand table (when
 * registered) plus the automatic `X`/`X-thinking` pair rule. Used by the
 * catalog generator; the runtime equivalent lives at the model-manager merge
 * point. Output is regrouped by provider — callers re-sort.
 */
export function collapseEffortVariantsAcrossProviders<TSpec extends VariantSpecLike>(specs: readonly TSpec[]): TSpec[] {
	const byProvider = new Map<string, TSpec[]>();
	for (const spec of specs) {
		const slice = byProvider.get(spec.provider);
		if (slice) {
			slice.push(spec);
		} else {
			byProvider.set(spec.provider, [spec]);
		}
	}
	const out: TSpec[] = [];
	for (const [provider, slice] of byProvider) {
		const table = VARIANT_COLLAPSE_TABLES[provider];
		let result = table ? collapseEffortVariants(slice, table) : slice;
		const derived = deriveThinkingPairFamilies(result, table);
		if (derived.length > 0) {
			result = collapseEffortVariants(result, { families: derived });
		}
		out.push(...result);
	}
	return out;
}

/**
 * Runtime entry point for already-built `Model` lists (the model-manager
 * merge point, coding-agent registry custom providers): collapses hand
 * tables plus derived pairs, then re-runs `buildModel` on freshly created
 * logical specs so thinking wire defaults stay resolved. Untouched entries
 * pass through by reference.
 */
export function collapseBuiltModelVariants<TApi extends Api>(models: readonly Model<TApi>[]): Model<TApi>[] {
	const collapsed = collapseEffortVariantsAcrossProviders(models);
	const inputRefs = new Set<Model<TApi>>(models);
	return collapsed.map(model =>
		// Resolved compat re-fed as override config resolves to itself.
		inputRefs.has(model) ? model : buildModel(model as unknown as ModelSpec<TApi>),
	);
}

interface VariantAliasIndex {
	/** lowercased retired id → replacement model id. */
	forward: Map<string, string>;
	/** replacement model id → retired ids that resolve to it. */
	reverse: Map<string, readonly string[]>;
	/** Collapsed logical ids declared by the table. */
	familyIds: Set<string>;
}

const kAliasIndex = Symbol("variant-collapse.aliasIndex");

interface TableWithAliasIndex extends VariantCollapseTable {
	[kAliasIndex]?: VariantAliasIndex;
}

function getAliasIndex(table: VariantCollapseTable): VariantAliasIndex {
	const tagged = table as TableWithAliasIndex;
	const cached = tagged[kAliasIndex];
	if (cached) return cached;
	const forward = new Map<string, string>();
	const reverse = new Map<string, string[]>();
	const add = (from: string, to: string) => {
		if (from === to) return;
		forward.set(from.toLowerCase(), to);
		const sources = reverse.get(to);
		if (sources) {
			sources.push(from);
		} else {
			reverse.set(to, [from]);
		}
	};
	const familyIds = new Set<string>();
	for (const family of table.families) {
		familyIds.add(family.id);
		for (const member of family.members) add(member, family.id);
		for (const alias of family.extraAliases ?? []) add(alias, family.id);
	}
	const index: VariantAliasIndex = { forward, reverse, familyIds };
	tagged[kAliasIndex] = index;
	return index;
}

/**
 * Resolve a retired effort-tier variant id (collapsed member, recycled id) to
 * its replacement model id for `provider` via the hand table. Returns
 * `undefined` when the id is not a known alias; derived `X-thinking` members
 * resolve through `stripThinkingVariantToken` instead. Callers must try an
 * exact model lookup first — a live model always wins over an alias.
 */
export function resolveVariantAlias(provider: Provider, modelId: string): string | undefined {
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[provider.toLowerCase()];
	if (!table) return undefined;
	return getAliasIndex(table).forward.get(modelId.trim().toLowerCase());
}

/** Bare-id alias hit: replacement id plus the providers declaring it. */
export interface BareVariantAliasHit {
	id: string;
	/** Providers whose table declares the alias — candidates from these win ties. */
	providers: readonly Provider[];
}

/**
 * Provider-agnostic hand-table alias lookup for bare-id selectors. Returns
 * the declaring providers so callers can prefer their models when the
 * replacement id exists on unrelated providers too (e.g. a retired Cursor
 * tier id must not resolve to `openai/gpt-5.4`).
 */
export function resolveBareVariantAlias(modelId: string): BareVariantAliasHit | undefined {
	const normalized = modelId.trim().toLowerCase();
	for (const provider in VARIANT_COLLAPSE_TABLES) {
		const table = VARIANT_COLLAPSE_TABLES[provider] as VariantCollapseTable;
		const hit = getAliasIndex(table).forward.get(normalized);
		if (hit === undefined) continue;
		const providers: Provider[] = [];
		for (const candidate in VARIANT_COLLAPSE_TABLES) {
			if (VARIANT_COLLAPSE_TABLES[candidate] === table) providers.push(candidate);
		}
		return { id: hit, providers };
	}
	return undefined;
}

/**
 * Reverse alias lookup: the retired ids that resolve to `modelId` for
 * `provider` via the hand table. Used to re-key config keyed by raw member
 * ids (models.yml `modelOverrides`, suppressed selectors) onto the collapsed
 * model. Empty for providers without a table.
 */
export function getVariantAliasSources(provider: Provider, modelId: string): readonly string[] {
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[provider.toLowerCase()];
	if (!table) return [];
	return getAliasIndex(table).reverse.get(modelId) ?? [];
}
