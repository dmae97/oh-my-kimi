/**
 * Display shape for one entry in the interactive Model scope banner.
 *
 * `thinkingLevel` carries the suffix value, but it is only rendered when
 * `explicitThinkingLevel` is true — the caller may have filled the field with
 * the global default for runtime use (e.g. Ctrl+P cycling), and the banner
 * must not present that default as if the user had requested it.
 */
export interface ModelScopeDisplayEntry {
	model: {
		id: string;
	};
	thinkingLevel?: string;
	explicitThinkingLevel: boolean;
}

/** Builds the compact `id[:thinking]` list shown in the Model scope banner. */
export function formatModelScopeList(scopedModels: ReadonlyArray<ModelScopeDisplayEntry>): string {
	return scopedModels
		.map(scopedModel => {
			const thinkingStr =
				scopedModel.explicitThinkingLevel && scopedModel.thinkingLevel ? `:${scopedModel.thinkingLevel}` : "";
			return `${scopedModel.model.id}${thinkingStr}`;
		})
		.join(", ");
}
