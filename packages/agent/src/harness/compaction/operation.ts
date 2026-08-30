export interface HarnessCompactionRunOptions {
	readonly automatic: boolean;
	readonly customInstructions?: string;
	readonly signal?: AbortSignal;
}
