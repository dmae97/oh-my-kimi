import generate from "@babel/generator";
import { type ParserPlugin, parse } from "@babel/parser";
import traverse, { type Binding, type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import {
	generate as generateRegex,
	parse as parseRegex,
	type NodePath as RegexNodePath,
	traverse as traverseRegex,
} from "regexp-tree";
import type { AstRegExp, Quantifier as RegexQuantifier } from "regexp-tree/ast";

/**
 * Code mutations for edit benchmark generation.
 *
 * Each mutation introduces a subtle bug that tests edit precision, not bug-finding
 * ability. The mutation can be trivial - what matters is whether the model can
 * surgically apply the patch in difficult contexts.
 */
export interface MutationInfo {
	lineNumber: number;
	originalSnippet: string;
	mutatedSnippet: string;
}

export interface Mutation {
	name: string;
	category: string;
	fixHint: string;

	canApply(content: string): boolean;
	mutate(content: string, rng: () => number): [string, MutationInfo];
	describe(info: MutationInfo): string;
}

type Candidate<TNode extends t.Node = t.Node, TMeta = unknown> = {
	path: NodePath<TNode>;
	meta?: TMeta;
};

function randomChoice<T>(arr: T[], rng: () => number): T {
	return arr[Math.floor(rng() * arr.length)];
}

function randomSample<T>(arr: T[], count: number, rng: () => number): T[] {
	const copy = [...arr];
	const result: T[] = [];
	for (let i = 0; i < count && copy.length > 0; i++) {
		const idx = Math.floor(rng() * copy.length);
		result.push(copy.splice(idx, 1)[0]);
	}
	return result;
}

function mutateIdentifier(identifier: string): string | null {
	if (identifier.length < 2) return null;
	let mutated: string;
	if (identifier.length >= 3 && identifier[0] === identifier[1]) {
		mutated = identifier[identifier.length - 1] + identifier.slice(1, -1) + identifier[0];
	} else {
		mutated = identifier[1] + identifier[0] + identifier.slice(2);
	}
	return mutated === identifier ? null : mutated;
}

type Parsed = {
	ast: t.File;
	code: string;
};

function parseWithPlugins(code: string, plugins: ParserPlugin[]): t.File {
	return parse(code, {
		sourceType: "unambiguous",
		allowReturnOutsideFunction: true,
		errorRecovery: true,
		plugins,
	});
}

function parseCode(code: string): Parsed | null {
	const pluginSets: ParserPlugin[][] = [
		[
			"flow",
			"flowComments",
			"jsx",
			"importAssertions",
			"decorators-legacy",
			"classPrivateMethods",
			"classPrivateProperties",
			"classProperties",
			"privateIn",
			"topLevelAwait",
			"optionalChaining",
			"nullishCoalescingOperator",
		],
		[
			"typescript",
			"jsx",
			"importAssertions",
			"decorators-legacy",
			"classPrivateMethods",
			"classPrivateProperties",
			"classProperties",
			"privateIn",
			"topLevelAwait",
			"optionalChaining",
			"nullishCoalescingOperator",
		],
	];

	for (const plugins of pluginSets) {
		try {
			return { ast: parseWithPlugins(code, plugins), code };
		} catch {}
	}

	return null;
}

/*
 * Babel parser 7.29 emits TSTypeCastExpression but generator/types don't define it.
 * Register it in VISITOR_KEYS (so the printer's isLastChild doesn't crash) and in
 * generatorInfosMap with a custom handler that unwraps the TSTypeAnnotation wrapper.
 */
t.VISITOR_KEYS.TSTypeCastExpression = ["expression", "typeAnnotation"];
{
	const { generatorInfosMap } = require("@babel/generator/lib/nodes") as {
		generatorInfosMap: Map<string, [any, number, unknown]>;
	};
	if (!generatorInfosMap.has("TSTypeCastExpression")) {
		const tsAs = generatorInfosMap.get("TSAsExpression");
		if (tsAs) {
			// Custom handler: like TSAsExpression but unwraps TSTypeAnnotation → TSType
			function TSTypeCastExpression(
				this: {
					print: (node: unknown, printComments?: boolean) => void;
					space: () => void;
					word: (word: string) => void;
				},
				node: Record<string, unknown>,
			): void {
				this.print(node.expression, true);
				this.space();
				this.word("as");
				this.space();
				const annot = node.typeAnnotation as Record<string, unknown> | undefined;
				// TSTypeCastExpression.typeAnnotation is TSTypeAnnotation {typeAnnotation: TSType}
				this.print(annot && "typeAnnotation" in annot ? annot.typeAnnotation : annot);
			}
			generatorInfosMap.set("TSTypeCastExpression", [TSTypeCastExpression, tsAs[1], tsAs[2]]);
		}
	}
}

type SourceRange = {
	start: number;
	end: number;
};

type SourceEdit = SourceRange & {
	replacement: string;
};

function nodeLine(node: t.Node): number {
	return node.loc?.start.line ?? 0;
}

function nodeRange(node: t.Node): SourceRange | null {
	if (typeof node.start === "number" && typeof node.end === "number" && node.start <= node.end) {
		return { start: node.start, end: node.end };
	}
	return null;
}

function snippetFromSource(src: string, node: t.Node, fallback = ""): string {
	const range = nodeRange(node);
	if (range) {
		return src.slice(range.start, range.end);
	}
	return fallback;
}

function trimSnippet(snippet: string): string {
	return snippet.replace(/^\n+/, "").replace(/\n+$/, "");
}

function snippetFromNode(node: t.Node): string {
	try {
		return trimSnippet(generate(node, { comments: false, compact: false, retainLines: false }).code);
	} catch {
		return "";
	}
}

function applySourceEdits(content: string, edits: SourceEdit[]): string | null {
	if (edits.length === 0) return content;
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	let previousStart = content.length + 1;
	let out = content;
	for (const edit of sorted) {
		if (edit.start < 0 || edit.end < edit.start || edit.end > out.length) {
			return null;
		}
		if (edit.end > previousStart) {
			return null;
		}
		out = `${out.slice(0, edit.start)}${edit.replacement}${out.slice(edit.end)}`;
		previousStart = edit.start;
	}
	return out;
}

function noopInfo(): MutationInfo {
	return { lineNumber: 0, originalSnippet: "", mutatedSnippet: "" };
}

function applyBinaryOperatorSwap(
	parsed: Parsed,
	candidate: Candidate<t.BinaryExpression>,
	swap: Record<string, t.BinaryExpression["operator"]>,
): MutationInfo {
	const node = candidate.path.node;
	const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
	const swapped = swap[node.operator];
	if (!swapped) return noopInfo();
	node.operator = swapped;
	return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
}

function isLengthMemberExpression(node: t.Node): node is t.MemberExpression {
	return t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property, { name: "length" });
}

abstract class BaseAstMutation implements Mutation {
	abstract name: string;
	abstract category: string;
	abstract fixHint: string;
	abstract description: string;

	describe(_info: MutationInfo): string {
		return this.description;
	}

	abstract collectCandidates(parsed: Parsed): Candidate[];
	abstract applyCandidate(parsed: Parsed, candidate: Candidate, rng: () => number): MutationInfo;

	protected buildEdits(_parsed: Parsed, candidate: Candidate, originalRange: SourceRange | null): SourceEdit[] | null {
		if (!originalRange) return null;
		if (candidate.path.removed) {
			return [{ ...originalRange, replacement: "" }];
		}
		const replacement = snippetFromNode(candidate.path.node);
		if (!replacement) return null;
		return [{ ...originalRange, replacement }];
	}

	canApply(content: string): boolean {
		const parsed = parseCode(content);
		if (!parsed) return false;
		return this.collectCandidates(parsed).length > 0;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(candidates, rng);
		const originalRange = nodeRange(chosen.path.node);
		const info = this.applyCandidate(parsed, chosen, rng);
		if (info.lineNumber === 0) return [content, noopInfo()];
		const edits = this.buildEdits(parsed, chosen, originalRange);
		if (!edits) return [content, noopInfo()];
		const mutated = applySourceEdits(content, edits);
		if (!mutated || mutated === content) return [content, noopInfo()];
		return [mutated, info];
	}
}

class SwapComparisonMutation extends BaseAstMutation {
	name = "swap-comparison";
	category = "operator";
	fixHint = "Swap the comparison operator to the correct variant.";
	description = "A comparison operator is subtly wrong.";

	#swap: Record<string, t.BinaryExpression["operator"]> = {
		"<=": "<",
		"<": "<=",
		">=": ">",
		">": ">=",
	};

	collectCandidates(parsed: Parsed): Candidate<t.BinaryExpression>[] {
		const out: Candidate<t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			BinaryExpression: path => {
				const op = path.node.operator;
				if (op === "<" || op === "<=" || op === ">" || op === ">=") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BinaryExpression>): MutationInfo {
		return applyBinaryOperatorSwap(parsed, candidate, this.#swap);
	}
}

class SwapEqualityMutation extends BaseAstMutation {
	name = "swap-equality";
	category = "operator";
	fixHint = "Fix the equality comparison operator.";
	description = "An equality operator is inverted.";

	#swap: Record<string, t.BinaryExpression["operator"]> = {
		"===": "!==",
		"!==": "===",
		"==": "!=",
		"!=": "==",
	};

	collectCandidates(parsed: Parsed): Candidate<t.BinaryExpression>[] {
		const out: Candidate<t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			BinaryExpression: path => {
				const op = path.node.operator;
				if (op === "===" || op === "!==" || op === "==" || op === "!=") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BinaryExpression>): MutationInfo {
		return applyBinaryOperatorSwap(parsed, candidate, this.#swap);
	}
}

class SwapLogicalMutation extends BaseAstMutation {
	name = "swap-logical";
	category = "operator";
	fixHint = "Use the intended boolean operator.";
	description = "A boolean operator is incorrect.";

	collectCandidates(parsed: Parsed): Candidate<t.LogicalExpression>[] {
		const out: Candidate<t.LogicalExpression>[] = [];
		traverse(parsed.ast, {
			LogicalExpression: path => {
				const op = path.node.operator;
				if (op === "&&" || op === "||") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.LogicalExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.operator = node.operator === "&&" ? "||" : "&&";
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class RemoveNegationMutation extends BaseAstMutation {
	name = "remove-negation";
	category = "operator";
	fixHint = "Add back the missing logical negation (`!`).";
	description = "A logical negation (`!`) was accidentally removed.";

	collectCandidates(parsed: Parsed): Candidate<t.UnaryExpression>[] {
		const out: Candidate<t.UnaryExpression>[] = [];
		traverse(parsed.ast, {
			UnaryExpression: path => {
				if (path.node.operator === "!" && path.node.prefix) out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.UnaryExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const replacement = node.argument;
		candidate.path.replaceWith(replacement);
		return {
			lineNumber: nodeLine(node),
			originalSnippet: before,
			mutatedSnippet: snippetFromNode(replacement),
		};
	}
}

class SwapIncDecMutation extends BaseAstMutation {
	name = "swap-increment-decrement";
	category = "operator";
	fixHint = "Replace the increment/decrement operator with the intended one.";
	description = "An increment/decrement operator points the wrong direction.";

	collectCandidates(parsed: Parsed): Candidate<t.UpdateExpression>[] {
		const out: Candidate<t.UpdateExpression>[] = [];
		traverse(parsed.ast, {
			UpdateExpression: path => {
				if (path.node.operator === "++" || path.node.operator === "--") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.UpdateExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.operator = node.operator === "++" ? "--" : "++";
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class SwapArithmeticMutation extends BaseAstMutation {
	name = "swap-arithmetic";
	category = "operator";
	fixHint = "Correct the arithmetic operator.";
	description = "An arithmetic operator was swapped.";

	#swap: Record<string, t.BinaryExpression["operator"]> = { "+": "-", "-": "+", "*": "/", "/": "*" };

	collectCandidates(parsed: Parsed): Candidate<t.BinaryExpression>[] {
		const out: Candidate<t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			BinaryExpression: path => {
				const op = path.node.operator;
				if (op === "+" || op === "-" || op === "*" || op === "/") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BinaryExpression>): MutationInfo {
		return applyBinaryOperatorSwap(parsed, candidate, this.#swap);
	}
}

class BooleanLiteralFlipMutation extends BaseAstMutation {
	name = "flip-boolean";
	category = "literal";
	fixHint = "Flip the boolean literal to the intended value.";
	description = "A boolean literal is inverted.";

	collectCandidates(parsed: Parsed): Candidate<t.BooleanLiteral>[] {
		const out: Candidate<t.BooleanLiteral>[] = [];
		traverse(parsed.ast, {
			BooleanLiteral: path => {
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.BooleanLiteral>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.value = !node.value;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class OptionalChainRemovalMutation extends BaseAstMutation {
	name = "remove-optional-chain";
	category = "access";
	fixHint =
		"Restore the optional chaining operator (`?.`) at the ONE location where it was removed. Do not add optional chaining elsewhere.";
	description = "Optional chaining was removed from a property access.";

	collectCandidates(parsed: Parsed): Candidate<t.OptionalMemberExpression | t.OptionalCallExpression>[] {
		const out: Candidate<t.OptionalMemberExpression | t.OptionalCallExpression>[] = [];
		traverse(parsed.ast, {
			OptionalMemberExpression: path => {
				if (path.node.optional)
					out.push({ path: path as NodePath<t.OptionalMemberExpression | t.OptionalCallExpression> });
			},
			OptionalCallExpression: path => {
				if (path.node.optional)
					out.push({ path: path as NodePath<t.OptionalMemberExpression | t.OptionalCallExpression> });
			},
		});
		return out;
	}

	applyCandidate(
		parsed: Parsed,
		candidate: Candidate<t.OptionalMemberExpression | t.OptionalCallExpression>,
	): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.optional = false;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class CallArgumentSwapMutation extends BaseAstMutation {
	name = "swap-call-args";
	category = "call";
	fixHint = "Swap the two arguments to their original order.";
	description = "Two arguments in a call are swapped.";

	collectCandidates(parsed: Parsed): Candidate<t.CallExpression>[] {
		const out: Candidate<t.CallExpression>[] = [];
		traverse(parsed.ast, {
			CallExpression: path => {
				const args = path.node.arguments;
				if (args.length >= 2 && !t.isSpreadElement(args[0]) && !t.isSpreadElement(args[1])) out.push({ path });
			},
		});
		return out;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(candidates, rng);
		const node = chosen.path.node;
		const first = node.arguments[0];
		const second = node.arguments[1];
		if (!first || !second || t.isSpreadElement(first) || t.isSpreadElement(second)) return [content, noopInfo()];

		const firstRange = nodeRange(first);
		const secondRange = nodeRange(second);
		const callRange = nodeRange(node);
		if (!firstRange || !secondRange || !callRange) return [content, noopInfo()];
		if (firstRange.start >= firstRange.end || secondRange.start >= secondRange.end) return [content, noopInfo()];
		if (firstRange.end > secondRange.start) return [content, noopInfo()];

		const betweenArgs = content.slice(firstRange.end, secondRange.start);
		const swappedArgs = `${content.slice(secondRange.start, secondRange.end)}${betweenArgs}${content.slice(firstRange.start, firstRange.end)}`;
		const mutated = applySourceEdits(content, [
			{ start: firstRange.start, end: secondRange.end, replacement: swappedArgs },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: nodeLine(node),
				originalSnippet: content.slice(callRange.start, callRange.end),
				mutatedSnippet: mutated.slice(callRange.start, callRange.end),
			},
		];
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.CallExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const first = node.arguments[0];
		const second = node.arguments[1];
		if (!first || !second) return noopInfo();
		node.arguments[0] = second;
		node.arguments[1] = first;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class NullishCoalescingSwapMutation extends BaseAstMutation {
	name = "swap-nullish";
	category = "operator";
	fixHint = "Use the intended nullish/logical operator.";
	description = "A nullish coalescing operator was swapped.";

	collectCandidates(parsed: Parsed): Candidate<t.LogicalExpression>[] {
		const out: Candidate<t.LogicalExpression>[] = [];
		traverse(parsed.ast, {
			LogicalExpression: path => {
				const op = path.node.operator;
				if (op === "??" || op === "||") out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.LogicalExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		node.operator = node.operator === "??" ? "||" : "??";
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class RegexQuantifierSwapMutation extends BaseAstMutation {
	name = "swap-regex-quantifier";
	category = "regex";
	fixHint = "Fix the ONE regex quantifier that was swapped (between `+` and `*`). Do not modify other quantifiers.";
	description = "A regex quantifier was swapped, changing whitespace matching.";

	collectCandidates(parsed: Parsed): Candidate<t.RegExpLiteral>[] {
		const out: Candidate<t.RegExpLiteral>[] = [];
		traverse(parsed.ast, {
			RegExpLiteral: path => {
				const source = `/${path.node.pattern}/${path.node.flags ?? ""}`;
				try {
					const ast = parseRegex(source);
					let hasQuantifier = false;
					traverseRegex(ast, {
						Quantifier: quantPath => {
							const kind = quantPath.node.kind;
							if (kind === "+" || kind === "*") hasQuantifier = true;
						},
					});
					if (hasQuantifier) out.push({ path });
				} catch {
					return;
				}
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.RegExpLiteral>, rng: () => number): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const source = `/${node.pattern}/${node.flags ?? ""}`;

		try {
			const ast: AstRegExp = parseRegex(source);
			const quantifiers: Array<RegexNodePath<RegexQuantifier>> = [];
			traverseRegex(ast, {
				Quantifier: quantPath => {
					const kind = quantPath.node.kind;
					if (kind === "+" || kind === "*") quantifiers.push(quantPath as RegexNodePath<RegexQuantifier>);
				},
			});
			if (quantifiers.length === 0) return noopInfo();

			const chosen = randomChoice(quantifiers, rng);
			chosen.node.kind = chosen.node.kind === "+" ? "*" : "+";

			const regenerated = generateRegex(ast);
			const firstSlash = regenerated.indexOf("/");
			const lastSlash = regenerated.lastIndexOf("/");
			if (firstSlash === -1 || lastSlash <= firstSlash) return noopInfo();

			node.pattern = regenerated.slice(firstSlash + 1, lastSlash);
			node.flags = regenerated.slice(lastSlash + 1);
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		} catch {
			return noopInfo();
		}
	}
}

class UnicodeHyphenMutation extends BaseAstMutation {
	name = "unicode-hyphen";
	category = "unicode";
	fixHint = "Replace the unicode dash with a plain ASCII hyphen.";
	description = "A string literal contains a lookalike unicode dash.";

	collectCandidates(parsed: Parsed): Candidate<t.StringLiteral | t.TemplateElement>[] {
		const out: Candidate<t.StringLiteral | t.TemplateElement>[] = [];
		traverse(parsed.ast, {
			StringLiteral: path => {
				if (path.node.value.includes("-"))
					out.push({ path: path as NodePath<t.StringLiteral | t.TemplateElement> });
			},
			TemplateElement: path => {
				if (path.node.value.raw.includes("-"))
					out.push({ path: path as NodePath<t.StringLiteral | t.TemplateElement> });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.StringLiteral | t.TemplateElement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));

		if (t.isStringLiteral(node)) {
			const idx = node.value.indexOf("-");
			if (idx === -1) return noopInfo();
			node.value = `${node.value.slice(0, idx)}–${node.value.slice(idx + 1)}`;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		const idx = node.value.raw.indexOf("-");
		if (idx === -1) return noopInfo();
		node.value.raw = `${node.value.raw.slice(0, idx)}–${node.value.raw.slice(idx + 1)}`;
		node.value.cooked = (node.value.cooked ?? node.value.raw).replace("-", "–");
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class IdentifierMultiEditMutation extends BaseAstMutation {
	name = "identifier-multi-edit";
	category = "identifier";
	fixHint = "Restore the identifier to its original spelling in all affected locations.";
	description = "An identifier is misspelled in multiple separate locations.";

	#keywords = new Set([
		"await",
		"break",
		"case",
		"catch",
		"class",
		"const",
		"continue",
		"debugger",
		"default",
		"delete",
		"do",
		"else",
		"export",
		"extends",
		"finally",
		"for",
		"function",
		"if",
		"import",
		"in",
		"instanceof",
		"new",
		"return",
		"super",
		"switch",
		"this",
		"throw",
		"try",
		"typeof",
		"var",
		"void",
		"while",
		"with",
		"yield",
		"let",
		"enum",
		"implements",
		"interface",
		"package",
		"private",
		"protected",
		"public",
		"static",
		"null",
		"true",
		"false",
	]);

	collectCandidates(parsed: Parsed): Candidate<t.Program>[] {
		const out: Candidate<t.Program>[] = [];
		traverse(parsed.ast, {
			Program: path => {
				out.push({ path });
			},
		});
		return out;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];
		const candidate = randomChoice(candidates, rng);

		const bindings: Array<{ name: string; binding: Binding }> = [];
		candidate.path.traverse({
			Scope: path => {
				for (const [name, binding] of Object.entries(path.scope.bindings)) {
					if (name.length < 2) continue;
					if (name.startsWith("_")) continue;
					if (name === "arguments") continue;
					if (this.#keywords.has(name)) continue;
					bindings.push({ name, binding });
				}
			},
		});

		const distinctRefLines = (paths: NodePath<t.Identifier>[]): number => {
			return new Set(paths.map(p => p.node.loc?.start.line ?? -1)).size;
		};

		let bindingCandidates = bindings.filter(item => {
			const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
			return refs.length >= 3 && distinctRefLines(refs) >= 3;
		});

		if (bindingCandidates.length === 0) {
			bindingCandidates = bindings.filter(item => {
				const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
				return refs.length >= 2 && distinctRefLines(refs) >= 2;
			});
		}

		if (bindingCandidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(bindingCandidates, rng);
		const mutated = mutateIdentifier(chosen.name);
		if (!mutated) return [content, noopInfo()];

		const refPaths = chosen.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
		const lineMap = new Map<number, NodePath<t.Identifier>[]>();
		for (const refPath of refPaths) {
			const line = refPath.node.loc?.start.line;
			if (!line) continue;
			const list = lineMap.get(line) ?? [];
			list.push(refPath);
			lineMap.set(line, list);
		}

		const lines = [...lineMap.keys()];
		if (lines.length < 2) return [content, noopInfo()];

		const editCount = Math.min(lines.length, randomChoice(lines.length >= 3 ? [2, 3, 3, 4] : [2], rng));
		const chosenLines = randomSample(lines, editCount, rng);

		const selectedPaths: NodePath<t.Identifier>[] = [];
		for (const line of chosenLines) {
			const options = lineMap.get(line) ?? [];
			if (options.length === 0) continue;
			selectedPaths.push(randomChoice(options, rng));
		}
		if (selectedPaths.length < 2) return [content, noopInfo()];

		const edits: SourceEdit[] = [];
		for (const selectedPath of selectedPaths) {
			const range = nodeRange(selectedPath.node);
			if (range) {
				edits.push({ ...range, replacement: mutated });
			}
		}

		const bindingId = chosen.binding.identifier;
		const bindingLine = bindingId.loc?.start.line;
		if (bindingLine && chosenLines.includes(bindingLine)) {
			const range = nodeRange(bindingId);
			if (range) {
				edits.push({ ...range, replacement: mutated });
			}
		}

		const deduped = new Map<string, SourceEdit>();
		for (const edit of edits) {
			deduped.set(`${edit.start}:${edit.end}`, edit);
		}
		if (deduped.size < 2) return [content, noopInfo()];

		const mutatedContent = applySourceEdits(content, Array.from(deduped.values()));
		if (!mutatedContent || mutatedContent === content) return [content, noopInfo()];

		return [
			mutatedContent,
			{
				lineNumber: selectedPaths[0]?.node.loc?.start.line ?? 0,
				originalSnippet: chosen.name,
				mutatedSnippet: mutated,
			},
		];
	}

	applyCandidate(_parsed: Parsed, candidate: Candidate<t.Program>, rng: () => number): MutationInfo {
		const bindings: Array<{ name: string; binding: Binding }> = [];
		candidate.path.traverse({
			Scope: path => {
				for (const [name, binding] of Object.entries(path.scope.bindings)) {
					if (name.length < 2) continue;
					if (name.startsWith("_")) continue;
					if (name === "arguments") continue;
					if (this.#keywords.has(name)) continue;
					bindings.push({ name, binding });
				}
			},
		});

		const distinctRefLines = (paths: NodePath<t.Identifier>[]): number => {
			return new Set(paths.map(p => p.node.loc?.start.line ?? -1)).size;
		};

		let candidates = bindings.filter(item => {
			const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
			return refs.length >= 3 && distinctRefLines(refs) >= 3;
		});

		if (candidates.length === 0) {
			candidates = bindings.filter(item => {
				const refs = item.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
				return refs.length >= 2 && distinctRefLines(refs) >= 2;
			});
		}

		if (candidates.length === 0) return noopInfo();

		const chosen = randomChoice(candidates, rng);
		const mutated = mutateIdentifier(chosen.name);
		if (!mutated) return noopInfo();

		const refPaths = chosen.binding.referencePaths.filter((p): p is NodePath<t.Identifier> => t.isIdentifier(p.node));
		const lineMap = new Map<number, NodePath<t.Identifier>[]>();
		for (const refPath of refPaths) {
			const line = refPath.node.loc?.start.line;
			if (!line) continue;
			const list = lineMap.get(line) ?? [];
			list.push(refPath);
			lineMap.set(line, list);
		}

		const lines = [...lineMap.keys()];
		if (lines.length < 2) return noopInfo();

		const editCount = Math.min(lines.length, randomChoice(lines.length >= 3 ? [2, 3, 3, 4] : [2], rng));
		const chosenLines = randomSample(lines, editCount, rng);

		const selectedPaths: NodePath<t.Identifier>[] = [];
		for (const line of chosenLines) {
			const options = lineMap.get(line) ?? [];
			if (options.length === 0) continue;
			selectedPaths.push(randomChoice(options, rng));
		}
		if (selectedPaths.length < 2) return noopInfo();

		for (const selectedPath of selectedPaths) {
			selectedPath.node.name = mutated;
		}

		const bindingId = chosen.binding.identifier;
		const bindingLine = bindingId.loc?.start.line;
		if (bindingLine && chosenLines.includes(bindingLine)) {
			bindingId.name = mutated;
		}

		return {
			lineNumber: selectedPaths[0]?.node.loc?.start.line ?? 0,
			originalSnippet: chosen.name,
			mutatedSnippet: mutated,
		};
	}
}

class DuplicateLineLiteralFlipMutation extends BaseAstMutation {
	name = "duplicate-line-flip";
	category = "duplicate";
	fixHint = "Fix the literal or operator on the duplicated line.";
	description = "A duplicated line contains a subtle literal/operator change.";

	collectCandidates(parsed: Parsed): Candidate<t.Statement, { group: string }>[] {
		const out: Candidate<t.Statement, { group: string }>[] = [];
		const statements: Array<{ path: NodePath<t.Statement>; text: string }> = [];

		traverse(parsed.ast, {
			Statement: path => {
				if (!path.node.loc) return;
				if (t.isBlockStatement(path.node)) return;
				const text = snippetFromSource(parsed.code, path.node, "");
				if (text.trim().length === 0) return;
				statements.push({ path, text });
			},
		});

		const counts = new Map<string, number>();
		for (const statement of statements) {
			counts.set(statement.text, (counts.get(statement.text) ?? 0) + 1);
		}

		for (const statement of statements) {
			if ((counts.get(statement.text) ?? 0) < 2) continue;
			out.push({ path: statement.path, meta: { group: statement.text } });
		}

		return out;
	}

	applyCandidate(
		parsed: Parsed,
		candidate: Candidate<t.Statement, { group: string }>,
		rng: () => number,
	): MutationInfo {
		const flips: Candidate<t.BooleanLiteral | t.BinaryExpression>[] = [];
		candidate.path.traverse({
			BooleanLiteral: path => {
				flips.push({ path: path as NodePath<t.BooleanLiteral | t.BinaryExpression> });
			},
			BinaryExpression: path => {
				const op = path.node.operator;
				if (
					op === "===" ||
					op === "!==" ||
					op === "==" ||
					op === "!=" ||
					op === "<" ||
					op === "<=" ||
					op === ">" ||
					op === ">="
				) {
					flips.push({ path: path as NodePath<t.BooleanLiteral | t.BinaryExpression> });
				}
			},
		});

		if (flips.length === 0) return noopInfo();

		const chosen = randomChoice(flips, rng);
		const node = chosen.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));

		if (t.isBooleanLiteral(node)) {
			node.value = !node.value;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		const eqSwap: Partial<Record<t.BinaryExpression["operator"], t.BinaryExpression["operator"]>> = {
			"===": "!==",
			"!==": "===",
			"==": "!=",
			"!=": "==",
		};
		const compSwap: Partial<Record<t.BinaryExpression["operator"], t.BinaryExpression["operator"]>> = {
			"<=": "<",
			"<": "<=",
			">=": ">",
			">": ">=",
		};
		const swapped = eqSwap[node.operator] ?? compSwap[node.operator];
		if (!swapped) return noopInfo();
		node.operator = swapped;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
	}
}

class SwapAdjacentLinesMutation extends BaseAstMutation {
	name = "swap-adjacent-lines";
	category = "structural";
	fixHint = "Swap the two adjacent lines back to their original order.";
	description = "Two adjacent statements are in the wrong order.";

	collectCandidates(parsed: Parsed): Candidate<t.Program | t.BlockStatement, { index: number }>[] {
		const out: Candidate<t.Program | t.BlockStatement, { index: number }>[] = [];

		const considerList = (
			path: NodePath<t.Program | t.BlockStatement>,
			body: Array<t.Statement | t.ModuleDeclaration>,
		): void => {
			for (let i = 0; i < body.length - 1; i++) {
				const left = body[i];
				const right = body[i + 1];
				if (!left || !right) continue;
				if (!t.isStatement(left) || !t.isStatement(right)) continue;
				if (!left.loc || !right.loc) continue;
				if (left.loc.start.line !== left.loc.end.line) continue;
				if (right.loc.start.line !== right.loc.end.line) continue;

				const leftText = snippetFromSource(parsed.code, left, "").trim();
				const rightText = snippetFromSource(parsed.code, right, "").trim();
				if (!leftText || !rightText) continue;
				if (leftText === rightText) continue;

				const gap = right.loc.start.line - left.loc.end.line;
				if (gap > 2) continue;

				out.push({ path, meta: { index: i } });
			}
		};

		traverse(parsed.ast, {
			Program: path => {
				considerList(path as NodePath<t.Program | t.BlockStatement>, path.node.body);
			},
			BlockStatement: path => {
				considerList(path as NodePath<t.Program | t.BlockStatement>, path.node.body);
			},
		});

		return out;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(candidates, rng);
		const container = chosen.path.node;
		const index = chosen.meta?.index;
		if (index === undefined) return [content, noopInfo()];

		const body = t.isProgram(container) ? container.body : container.body;
		const left = body[index];
		const right = body[index + 1];
		if (!left || !right) return [content, noopInfo()];
		if (!t.isStatement(left) || !t.isStatement(right)) return [content, noopInfo()];

		const leftRange = nodeRange(left);
		const rightRange = nodeRange(right);
		if (!leftRange || !rightRange) return [content, noopInfo()];
		if (leftRange.end > rightRange.start) return [content, noopInfo()];

		const between = content.slice(leftRange.end, rightRange.start);
		const swapped = `${content.slice(rightRange.start, rightRange.end)}${between}${content.slice(leftRange.start, leftRange.end)}`;
		const mutated = applySourceEdits(content, [
			{ start: leftRange.start, end: rightRange.end, replacement: swapped },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: left.loc?.start.line ?? 0,
				originalSnippet: `lines ${left.loc?.start.line ?? 0}-${right.loc?.end.line ?? 0}`,
				mutatedSnippet: "[swapped]",
			},
		];
	}

	applyCandidate(
		_parsed: Parsed,
		candidate: Candidate<t.Program | t.BlockStatement, { index: number }>,
	): MutationInfo {
		const container = candidate.path.node;
		const index = candidate.meta?.index;
		if (index === undefined) return noopInfo();

		const body = t.isProgram(container) ? container.body : container.body;
		const left = body[index];
		const right = body[index + 1];
		if (!left || !right) return noopInfo();
		if (!t.isStatement(left) || !t.isStatement(right)) return noopInfo();

		const before = `lines ${left.loc?.start.line ?? 0}-${right.loc?.end.line ?? 0}`;
		[body[index], body[index + 1]] = [body[index + 1]!, body[index]!];
		return {
			lineNumber: left.loc?.start.line ?? 0,
			originalSnippet: before,
			mutatedSnippet: "[swapped]",
		};
	}
}

class SwapIfElseBranchesMutation extends BaseAstMutation {
	name = "swap-if-else";
	category = "structural";
	fixHint = "Swap the if and else branch bodies back to their original positions.";
	description = "The if and else branches are swapped.";

	collectCandidates(parsed: Parsed): Candidate<t.IfStatement>[] {
		const out: Candidate<t.IfStatement>[] = [];
		traverse(parsed.ast, {
			IfStatement: path => {
				const node = path.node;
				if (!node.alternate) return;
				if (!t.isBlockStatement(node.consequent) || !t.isBlockStatement(node.alternate)) return;
				if (node.consequent.body.length === 0 || node.alternate.body.length === 0) return;
				if (node.consequent.body.length > 5 || node.alternate.body.length > 5) return;
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.IfStatement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		if (!t.isBlockStatement(node.consequent) || !t.isBlockStatement(node.alternate)) return noopInfo();
		const consequent = node.consequent;
		node.consequent = node.alternate;
		node.alternate = consequent;
		return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: "[swapped]" };
	}
}

class RemoveEarlyReturnMutation extends BaseAstMutation {
	name = "remove-early-return";
	category = "structural";
	fixHint =
		"Restore the missing guard clause (if statement with early return). Add back the exact 3-line pattern: if condition, return statement, closing brace.";
	description = "A guard clause (early return) was removed.";

	collectCandidates(parsed: Parsed): Candidate<t.IfStatement>[] {
		const out: Candidate<t.IfStatement>[] = [];
		traverse(parsed.ast, {
			IfStatement: path => {
				const node = path.node;
				if (node.alternate) return;
				if (!t.isBlockStatement(node.consequent)) return;
				if (node.consequent.body.length !== 1) return;
				if (!t.isReturnStatement(node.consequent.body[0])) return;
				out.push({ path });
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.IfStatement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		candidate.path.remove();
		return { lineNumber: nodeLine(node), originalSnippet: before.trim(), mutatedSnippet: "[removed]" };
	}
}

class SwapNamedImportsMutation extends BaseAstMutation {
	name = "swap-named-imports";
	category = "import";
	fixHint =
		"Swap ONLY the two imported names that are in the wrong order. Do not reorder other imports or modify other import statements.";
	description = "Two named imports are swapped in a destructuring import.";

	collectCandidates(parsed: Parsed): Candidate<t.ImportDeclaration, { i: number; j: number }>[] {
		const out: Candidate<t.ImportDeclaration, { i: number; j: number }>[] = [];
		traverse(parsed.ast, {
			ImportDeclaration: path => {
				const named = path.node.specifiers
					.map((spec, idx) => ({ spec, idx }))
					.filter((entry): entry is { spec: t.ImportSpecifier; idx: number } => t.isImportSpecifier(entry.spec))
					.filter(({ spec }) => t.isIdentifier(spec.imported) && t.isIdentifier(spec.local))
					.filter(
						({ spec }) =>
							t.isIdentifier(spec.imported) &&
							t.isIdentifier(spec.local) &&
							spec.imported.name === spec.local.name,
					);
				if (named.length < 2) return;
				for (let i = 0; i < named.length; i++) {
					for (let j = i + 1; j < named.length; j++) {
						out.push({ path, meta: { i: named[i]!.idx, j: named[j]!.idx } });
					}
				}
			},
		});
		return out;
	}

	mutate(content: string, rng: () => number): [string, MutationInfo] {
		const parsed = parseCode(content);
		if (!parsed) return [content, noopInfo()];
		const candidates = this.collectCandidates(parsed);
		if (candidates.length === 0) return [content, noopInfo()];

		const chosen = randomChoice(candidates, rng);
		const node = chosen.path.node;
		const indices = chosen.meta;
		if (!indices) return [content, noopInfo()];
		const { i, j } = indices;
		if (i < 0 || j < 0 || i >= node.specifiers.length || j >= node.specifiers.length) return [content, noopInfo()];

		const left = node.specifiers[i];
		const right = node.specifiers[j];
		if (!left || !right) return [content, noopInfo()];
		const leftRange = nodeRange(left);
		const rightRange = nodeRange(right);
		const importRange = nodeRange(node);
		if (!leftRange || !rightRange || !importRange) return [content, noopInfo()];
		if (leftRange.end > rightRange.start) return [content, noopInfo()];

		const leftText = content.slice(leftRange.start, leftRange.end);
		const rightText = content.slice(rightRange.start, rightRange.end);
		const mutated = applySourceEdits(content, [
			{ start: leftRange.start, end: leftRange.end, replacement: rightText },
			{ start: rightRange.start, end: rightRange.end, replacement: leftText },
		]);
		if (!mutated || mutated === content) return [content, noopInfo()];

		return [
			mutated,
			{
				lineNumber: nodeLine(node),
				originalSnippet: content.slice(importRange.start, importRange.end).trim(),
				mutatedSnippet: mutated.slice(importRange.start, importRange.end).trim(),
			},
		];
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.ImportDeclaration, { i: number; j: number }>): MutationInfo {
		const node = candidate.path.node;
		const indices = candidate.meta;
		if (!indices) return noopInfo();
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		const { i, j } = indices;
		if (i < 0 || j < 0 || i >= node.specifiers.length || j >= node.specifiers.length) return noopInfo();
		[node.specifiers[i], node.specifiers[j]] = [node.specifiers[j]!, node.specifiers[i]!];
		return {
			lineNumber: nodeLine(node),
			originalSnippet: before.trim(),
			mutatedSnippet: snippetFromNode(node).trim(),
		};
	}
}

class DeleteStatementMutation extends BaseAstMutation {
	name = "delete-statement";
	category = "structural";
	fixHint = "Restore the deleted statement.";
	description = "A critical statement was deleted from the code.";

	collectCandidates(parsed: Parsed): Candidate<t.Statement>[] {
		const out: Candidate<t.Statement>[] = [];
		traverse(parsed.ast, {
			Statement: path => {
				if (!path.node.loc) return;
				if (t.isVariableDeclaration(path.node)) {
					out.push({ path: path as NodePath<t.Statement> });
					return;
				}
				if (!t.isExpressionStatement(path.node)) return;
				if (t.isAssignmentExpression(path.node.expression) || t.isUpdateExpression(path.node.expression)) {
					out.push({ path: path as NodePath<t.Statement> });
				}
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.Statement>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));
		candidate.path.remove();
		return { lineNumber: nodeLine(node), originalSnippet: before.trim(), mutatedSnippet: "[removed]" };
	}
}

class OffByOneMutation extends BaseAstMutation {
	name = "off-by-one";
	category = "literal";
	fixHint = "Fix the off-by-one error in the numeric literal or comparison.";
	description = "A numeric boundary has an off-by-one error.";

	collectCandidates(parsed: Parsed): Candidate<t.NumericLiteral | t.BinaryExpression>[] {
		const out: Candidate<t.NumericLiteral | t.BinaryExpression>[] = [];
		traverse(parsed.ast, {
			NumericLiteral: path => {
				if (path.node.value !== 0 && path.node.value !== 1) return;
				const hasBoundaryAncestor =
					path.findParent(parent => {
						return (
							parent.isForStatement() ||
							parent.isWhileStatement() ||
							parent.isDoWhileStatement() ||
							parent.isIfStatement() ||
							(parent.isBinaryExpression() && ["<", "<=", ">", ">="].includes(parent.node.operator))
						);
					}) != null;
				if (hasBoundaryAncestor) out.push({ path: path as NodePath<t.NumericLiteral | t.BinaryExpression> });
			},
			BinaryExpression: path => {
				if (
					(path.node.operator === "<" || path.node.operator === "<=") &&
					isLengthMemberExpression(path.node.right)
				) {
					out.push({ path: path as NodePath<t.NumericLiteral | t.BinaryExpression> });
					return;
				}
				if (
					path.node.operator === "-" &&
					isLengthMemberExpression(path.node.left) &&
					t.isNumericLiteral(path.node.right) &&
					(path.node.right.value === 1 || path.node.right.value === 2)
				) {
					out.push({ path: path as NodePath<t.NumericLiteral | t.BinaryExpression> });
				}
			},
		});
		return out;
	}

	applyCandidate(parsed: Parsed, candidate: Candidate<t.NumericLiteral | t.BinaryExpression>): MutationInfo {
		const node = candidate.path.node;
		const before = snippetFromSource(parsed.code, node, snippetFromNode(node));

		if (t.isNumericLiteral(node)) {
			node.value = node.value === 0 ? 1 : 0;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		if (node.operator === "<" || node.operator === "<=") {
			if (!isLengthMemberExpression(node.right)) return noopInfo();
			node.operator = node.operator === "<" ? "<=" : "<";
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		if (
			node.operator === "-" &&
			isLengthMemberExpression(node.left) &&
			t.isNumericLiteral(node.right) &&
			(node.right.value === 1 || node.right.value === 2)
		) {
			node.right.value = node.right.value === 1 ? 2 : 1;
			return { lineNumber: nodeLine(node), originalSnippet: before, mutatedSnippet: snippetFromNode(node) };
		}

		return noopInfo();
	}
}

export const ALL_MUTATIONS: Mutation[] = [
	new SwapComparisonMutation(),
	new SwapEqualityMutation(),
	new SwapLogicalMutation(),
	new RemoveNegationMutation(),
	new SwapIncDecMutation(),
	new SwapArithmeticMutation(),
	new BooleanLiteralFlipMutation(),
	new OptionalChainRemovalMutation(),
	new CallArgumentSwapMutation(),
	new NullishCoalescingSwapMutation(),
	new RegexQuantifierSwapMutation(),
	new UnicodeHyphenMutation(),
	new IdentifierMultiEditMutation(),
	new DuplicateLineLiteralFlipMutation(),
	new SwapAdjacentLinesMutation(),
	new SwapIfElseBranchesMutation(),
	new RemoveEarlyReturnMutation(),
	new SwapNamedImportsMutation(),
	new DeleteStatementMutation(),
	new OffByOneMutation(),
];

export const CATEGORY_MAP: Record<string, string[]> = {
	operator: ALL_MUTATIONS.filter(m => m.category === "operator").map(m => m.name),
	literal: ALL_MUTATIONS.filter(m => m.category === "literal").map(m => m.name),
	access: ALL_MUTATIONS.filter(m => m.category === "access").map(m => m.name),
	call: ALL_MUTATIONS.filter(m => m.category === "call").map(m => m.name),
	regex: ALL_MUTATIONS.filter(m => m.category === "regex").map(m => m.name),
	unicode: ALL_MUTATIONS.filter(m => m.category === "unicode").map(m => m.name),
	identifier: ALL_MUTATIONS.filter(m => m.category === "identifier").map(m => m.name),
	duplicate: ALL_MUTATIONS.filter(m => m.category === "duplicate").map(m => m.name),
	structural: ALL_MUTATIONS.filter(m => m.category === "structural").map(m => m.name),
	import: ALL_MUTATIONS.filter(m => m.category === "import").map(m => m.name),
};
