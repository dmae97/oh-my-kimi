import anthropicGrammar from "./anthropic";
import deepseekGrammar from "./deepseek";
import geminiGrammar from "./gemini";
import gemmaGrammar from "./gemma";
import glmGrammar from "./glm";
import harmonyGrammar from "./harmony";
import hermesGrammar from "./hermes";
import kimiGrammar from "./kimi";
import piGrammar from "./pi";
import qwen3Grammar from "./qwen3";
import type { Grammar, InbandScanner, InbandScannerOptions, ToolCallSyntax } from "./types";
import xmlGrammar from "./xml";

const GRAMMARS: Record<ToolCallSyntax, Grammar> = {
	glm: glmGrammar,
	hermes: hermesGrammar,
	kimi: kimiGrammar,
	xml: xmlGrammar,
	anthropic: anthropicGrammar,
	deepseek: deepseekGrammar,
	harmony: harmonyGrammar,
	pi: piGrammar,
	qwen3: qwen3Grammar,
	gemini: geminiGrammar,
	gemma: gemmaGrammar,
};

export function getInbandGrammar(syntax: ToolCallSyntax): Grammar {
	return GRAMMARS[syntax];
}

export function createInbandScanner(syntax: ToolCallSyntax, options: InbandScannerOptions = {}): InbandScanner {
	return getInbandGrammar(syntax).createScanner(options);
}
