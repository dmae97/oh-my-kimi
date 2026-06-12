/**
 * Model query facade exposed to extensions as `ctx.models`.
 *
 * Read-only: lets an extension select a model the same way core does — list
 * authenticated models, read the session model, resolve a model string or role
 * alias, and compare model families — without touching the mutable registry or
 * duplicating resolution/family heuristics.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import type { ModelRegistry } from "../../config/model-registry";
import { expandRoleAlias, getModelMatchPreferences, resolveModelFromString } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { ExtensionModelQuery } from "./types";

/**
 * Build the `ctx.models` facade. `getModel` is read lazily so `current()` always
 * reflects the live session model (it can change mid-session via `/model`).
 */
export function createExtensionModelQuery(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	getModel: () => Model | undefined,
): ExtensionModelQuery {
	return {
		list: () => modelRegistry.getAvailable(),
		current: () => getModel(),
		resolve: (spec: string): Model<Api> | undefined =>
			resolveModelFromString(
				expandRoleAlias(spec, settings),
				modelRegistry.getAvailable(),
				getModelMatchPreferences(settings),
				modelRegistry,
			),
		family: (model: Model<Api>): string =>
			modelFamilyToken(modelRegistry.getCanonicalId(model) ?? model.id) || model.provider.toLowerCase(),
	};
}
