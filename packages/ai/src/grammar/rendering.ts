import type { ToolCall } from "../types";
import { buildArgShapes, getArrayItemSchema, getObjectProperties, isStringOnlySchema } from "./coercion";
import type { GrammarRenderOptions, GrammarToolResult, InbandTool } from "./types";

const DEEPSEEK_TOOL_CALLS_BEGIN = "<｜tool▁calls▁begin｜>";
const DEEPSEEK_TOOL_CALLS_END = "<｜tool▁calls▁end｜>";
const DEEPSEEK_TOOL_CALL_BEGIN = "<｜tool▁call▁begin｜>";
const DEEPSEEK_TOOL_CALL_END = "<｜tool▁call▁end｜>";
const DEEPSEEK_TOOL_SEPARATOR = "<｜tool▁sep｜>";
const DEEPSEEK_TOOL_OUTPUT_BEGIN = "<｜tool▁output▁begin｜>";
const DEEPSEEK_TOOL_OUTPUT_END = "<｜tool▁output▁end｜>";

export function renderGlmToolCalls(calls: readonly ToolCall[], options: GrammarRenderOptions = {}): string {
	const shapes = buildArgShapes(options.tools);
	return calls
		.map(call => {
			const shape = shapes.get(call.name);
			let body = `<tool_call>${call.name}`;
			for (const key in call.arguments) {
				const value = call.arguments[key];
				const rendered = shape?.stringArgs.has(key) && typeof value === "string" ? value : stringifyJson(value);
				body += `\n<arg_key>${key}</arg_key>\n<arg_value>${rendered}</arg_value>`;
			}
			return `${body}\n</tool_call>`;
		})
		.join("\n");
}

export function renderGlmToolResults(results: readonly GrammarToolResult[]): string {
	return `<observation>\n${renderToolResponseResults(results)}\n</observation>`;
}

export function renderHermesToolCalls(calls: readonly ToolCall[]): string {
	return calls
		.map(call => `<tool_call>\n${stringifyJson({ name: call.name, arguments: call.arguments })}\n</tool_call>`)
		.join("\n");
}

export function renderKimiToolCalls(calls: readonly ToolCall[]): string {
	if (calls.length === 0) return "";
	const body = calls
		.map(
			(call, index) =>
				`<|tool_call_begin|>${kimiCallId(call.name, call.id, index)}<|tool_call_argument_begin|>${stringifyJson(call.arguments)}<|tool_call_end|>`,
		)
		.join("");
	return `<|tool_calls_section_begin|>${body}<|tool_calls_section_end|>`;
}

export function renderKimiToolResults(results: readonly GrammarToolResult[]): string {
	return results
		.map(
			result =>
				`<|im_system|>${result.name}<|im_middle|>## Return of ${kimiCallId(result.name, result.id, result.index)}\n${result.text}<|im_end|>`,
		)
		.join("");
}

export function renderDeepSeekToolCalls(calls: readonly ToolCall[]): string {
	if (calls.length === 0) return "";
	const body = calls
		.map(
			call =>
				`${DEEPSEEK_TOOL_CALL_BEGIN}${call.name}${DEEPSEEK_TOOL_SEPARATOR}${stringifyJson(call.arguments)}${DEEPSEEK_TOOL_CALL_END}`,
		)
		.join("");
	return `${DEEPSEEK_TOOL_CALLS_BEGIN}${body}${DEEPSEEK_TOOL_CALLS_END}`;
}

export function renderDeepSeekToolResults(results: readonly GrammarToolResult[]): string {
	return results.map(result => `${DEEPSEEK_TOOL_OUTPUT_BEGIN}${result.text}${DEEPSEEK_TOOL_OUTPUT_END}`).join("\n");
}

export function renderHarmonyToolCalls(calls: readonly ToolCall[]): string {
	return calls
		.map(
			call =>
				`<|start|>assistant<|channel|>commentary to=${harmonyRecipient(call.name)} <|constrain|>json<|message|>${stringifyJson(call.arguments)}<|call|>`,
		)
		.join("");
}

export function renderHarmonyToolResults(results: readonly GrammarToolResult[]): string {
	return results
		.map(
			result =>
				`<|start|>${harmonyRecipient(result.name)} to=assistant<|channel|>commentary<|message|>${result.text}<|end|>`,
		)
		.join("");
}

export function renderAnthropicToolCalls(calls: readonly ToolCall[], options: GrammarRenderOptions = {}): string {
	if (calls.length === 0) return "";
	return `<function_calls>\n${renderXmlInvokes(calls, options.tools ?? [])}\n</function_calls>`;
}

export function renderAnthropicToolResults(results: readonly GrammarToolResult[]): string {
	const body = results
		.map(result => {
			const tag = result.isError ? "error" : "result";
			const streamTag = result.isError ? "stderr" : "stdout";
			return `<${tag}>\n<tool_name>${escapeXmlText(result.name)}</tool_name>\n<${streamTag}>${result.text}</${streamTag}>\n</${tag}>`;
		})
		.join("\n");
	return `<function_results>\n${body}\n</function_results>`;
}

export function renderXmlToolCalls(calls: readonly ToolCall[], options: GrammarRenderOptions = {}): string {
	return renderXmlInvokes(calls, options.tools ?? []);
}

export function renderPiNativeToolCalls(calls: readonly ToolCall[], options: GrammarRenderOptions = {}): string {
	const shapes = buildArgShapes(options.tools);
	return calls
		.map(call => {
			const shape = shapes.get(call.name);
			let body = `<call:${call.name}>`;
			for (const key in call.arguments) {
				body += `\n${renderPiNativeElement(key, call.arguments[key], shape?.properties[key])}`;
			}
			return `${body}\n</call:${call.name}>`;
		})
		.join("\n");
}

export function renderToolResponseResults(results: readonly GrammarToolResult[]): string {
	return results.map(result => `<tool_response>\n${result.text}\n</tool_response>`).join("\n");
}

function renderXmlInvokes(calls: readonly ToolCall[], tools: readonly InbandTool[]): string {
	const shapes = buildArgShapes(tools);
	return calls
		.map(call => {
			const shape = shapes.get(call.name);
			let body = `<invoke name="${escapeXmlAttr(call.name)}">`;
			for (const key in call.arguments) {
				const value = call.arguments[key];
				const isString = shape?.stringArgs.has(key) === true;
				const stringAttr = isString ? ' string="true"' : ' string="false"';
				const rendered = isString && typeof value === "string" ? value : stringifyJson(value);
				body += `<parameter name="${escapeXmlAttr(key)}"${stringAttr}>${rendered}</parameter>`;
			}
			return `${body}</invoke>`;
		})
		.join("\n");
}

function renderPiNativeElement(key: string, value: unknown, schema: unknown): string {
	if (Array.isArray(value)) {
		const itemSchema = getArrayItemSchema(schema);
		return value.map(item => renderPiNativeElement(key, item, itemSchema)).join("\n");
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const properties = getObjectProperties(schema);
		let body = `<${key}>`;
		for (const childKey in record) {
			body += `\n${renderPiNativeElement(childKey, record[childKey], properties[childKey])}`;
		}
		return `${body}\n</${key}>`;
	}
	return `<${key}>${renderPiNativeScalar(value, schema)}</${key}>`;
}

function renderPiNativeScalar(value: unknown, schema: unknown): string {
	if (typeof value === "string") return value;
	if (isStringOnlySchema(schema) && value === null) return "";
	return stringifyJson(value);
}

function kimiCallId(name: string, id: string, index: number): string {
	const trimmed = id.trim();
	return trimmed.startsWith("functions.") ? trimmed : `functions.${name}:${index}`;
}

function harmonyRecipient(name: string): string {
	return name.startsWith("functions.") ? name : `functions.${name}`;
}

function stringifyJson(value: unknown): string {
	return JSON.stringify(value) ?? "null";
}

function escapeXmlAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
