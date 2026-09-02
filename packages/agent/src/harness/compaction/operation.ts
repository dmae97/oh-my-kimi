export interface HarnessCompactionRunOptions {
	readonly automatic: boolean;
	readonly customInstructions?: string;
	readonly signal?: AbortSignal;
	/**
	 * Invoked immediately before the compaction entry is appended, i.e. at the
	 * single declared commit point. Manual compaction uses it to enter the
	 * `committing` lifecycle stage; automatic compaction runs inside a prompt
	 * attempt and leaves it unset.
	 */
	readonly beforeCommit?: () => void;
}
