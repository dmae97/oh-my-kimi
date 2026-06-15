import type { Context, ToolCall } from "../types";

export type ToolCallSyntax = "glm" | "hermes" | "kimi" | "xml" | "anthropic" | "deepseek" | "harmony" | "pi" | "qwen3";

export type InbandScanEvent =
	| { type: "text"; text: string }
	| { type: "thinkingStart" }
	| { type: "thinkingDelta"; delta: string }
	| { type: "thinkingEnd"; thinking: string }
	| { type: "toolStart"; id: string; name: string }
	| { type: "toolArgDelta"; id: string; name: string; key: string; delta: string }
	| { type: "toolEnd"; id: string; name: string; arguments: Record<string, unknown>; rawBlock?: string };

export interface InbandScanner {
	feed(text: string): InbandScanEvent[];
	flush(): InbandScanEvent[];
}

export interface GrammarToolResult {
	readonly id: string;
	readonly name: string;
	readonly index: number;
	readonly text: string;
	readonly isError: boolean;
}

export interface GrammarRenderOptions {
	readonly tools?: readonly InbandTool[];
}

export interface Grammar {
	readonly syntax: ToolCallSyntax;
	readonly prompt: string;
	createScanner(options?: InbandScannerOptions): InbandScanner;
	renderAssistantToolCalls(calls: readonly ToolCall[], options?: GrammarRenderOptions): string;
	renderToolResults(results: readonly GrammarToolResult[], options?: GrammarRenderOptions): string;
}

export interface InbandScannerOptions {
	/** string-typed arg names for a tool → read verbatim. Ignored by JSON-carrying syntaxes. */
	stringArgs?: (toolName: string) => ReadonlySet<string>;
	/** Full tool schemas for schema-driven syntaxes such as GLM XML and pi-native. */
	tools?: readonly InbandTool[];
	/** XML only: parse pipe-wrapped DeepSeek DSML tags vs plain Anthropic invoke/parameter tags. */
	xmlTagset?: "anthropic" | "dsml";
	/** Emit thinking markers as thinking events instead of visible text when the syntax defines them. */
	parseThinking?: boolean;
}

export type InbandTool = NonNullable<Context["tools"]>[number];
