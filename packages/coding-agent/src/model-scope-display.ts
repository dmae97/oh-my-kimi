/** Formats scoped model selectors for interactive startup notifications. */
export interface ModelScopeDisplayEntry {
	model: {
		id: string;
	};
	thinkingLevel?: string;
}

/** Builds the compact `id[:thinking]` list shown in the Model scope banner. */
export function formatModelScopeList(scopedModels: ReadonlyArray<ModelScopeDisplayEntry>): string {
	return scopedModels
		.map(scopedModel => {
			const thinkingStr = scopedModel.thinkingLevel ? `:${scopedModel.thinkingLevel}` : "";
			return `${scopedModel.model.id}${thinkingStr}`;
		})
		.join(", ");
}
