/**
 * Types for the internal URL routing system.
 *
 * Internal URLs (agent://, artifact://, memory://, skill://, rule://, mcp://, pi://, local://) are resolved by tools like read,
 * providing access to agent outputs and server resources without exposing filesystem paths.
 */

/**
 * Raw resource payload returned by protocol handlers. The `immutable` flag is
 * applied by the router from {@link ProtocolHandler.immutable}, so handlers do
 * not need to set it themselves.
 */
export interface InternalResource {
	/** Canonical URL that was resolved */
	url: string;
	/** Resolved text content */
	content: string;
	/** MIME type: text/markdown, application/json, or text/plain */
	contentType: "text/markdown" | "application/json" | "text/plain";
	/** Content size in bytes */
	size?: number;
	/** Underlying filesystem path (for debugging, not exposed to agent) */
	sourcePath?: string;
	/** Additional notes about resolution */
	notes?: string[];
	/**
	 * True when the resolved content cannot be edited by the agent (e.g. sealed
	 * artifacts, harness docs, machine-generated memory summaries). Hashline
	 * anchors and similar edit affordances are suppressed for immutable
	 * resources. Mutable resources (e.g. local://) behave like editable files.
	 */
	immutable?: boolean;
}

/**
 * Parsed internal URL with preserved host casing.
 */
export interface InternalUrl extends URL {
	/**
	 * Raw host segment extracted from input, preserving case.
	 */
	rawHost: string;
	/**
	 * Raw pathname extracted from input, preserving traversal markers before URL normalization.
	 */
	rawPathname?: string;
}

/**
 * Handler for a specific internal URL scheme (e.g., agent://, memory://, skill://, mcp://).
 */
export interface ProtocolHandler {
	/** The scheme this handler processes (without trailing ://) */
	readonly scheme: string;
	/**
	 * Whether resources produced by this handler are immutable (cannot be
	 * edited by the agent). When true, callers suppress hashline anchors and
	 * other edit affordances. When false, resources behave like editable files.
	 */
	readonly immutable: boolean;
	/**
	 * Resolve an internal URL to its content. The router stamps the
	 * {@link InternalResource.immutable} flag from {@link ProtocolHandler.immutable}.
	 * @param url Parsed URL object
	 * @throws Error with user-friendly message if resolution fails
	 */
	resolve(url: InternalUrl): Promise<InternalResource>;
}
