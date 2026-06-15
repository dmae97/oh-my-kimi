import type { ToolCallSyntax } from "@oh-my-pi/pi-catalog/identity";
import type { Context, ToolCall } from "../types";

export type { ToolCallSyntax };

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
	/** Render a single tool-call invocation — the inner element only, WITHOUT any parallel-call block envelope (e.g. anthropic's `<function_calls>` / kimi's section wrapper). */
	renderToolCall(call: ToolCall, options?: GrammarRenderOptions): string;
	/** Render a batch of (parallel) tool calls as one complete block, including whatever envelope the syntax wraps multiple calls in. */
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
