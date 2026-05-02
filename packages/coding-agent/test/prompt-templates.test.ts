/**
 * Tests for prompt template argument parsing and substitution.
 *
 * Tests verify:
 * - Argument parsing with quotes and special characters
 * - Placeholder substitution ($1, $2, $@, $ARGUMENTS)
 * - No recursive substitution of patterns in argument values
 * - Edge cases and integration between parsing and substitution
 */

import { describe, expect, test } from "bun:test";
import { expandPromptTemplate, type PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { expandSlashCommand, type FileSlashCommand } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { parseCommandArgs, substituteArgs } from "@oh-my-pi/pi-coding-agent/utils/command-args";

// ============================================================================
// substituteArgs
// ============================================================================

describe("substituteArgs", () => {
	test("should replace $ARGUMENTS with all args joined", () => {
		expect(substituteArgs("Test: $ARGUMENTS", ["a", "b", "c"])).toBe("Test: a b c");
	});

	test("should replace $@ with all args joined", () => {
		expect(substituteArgs("Test: $@", ["a", "b", "c"])).toBe("Test: a b c");
	});

	test("should support $@ slicing with start offset", () => {
		expect(substituteArgs("Test: $@[2]", ["a", "b", "c"])).toBe("Test: b c");
	});

	test("should support $@ slicing with start and length", () => {
		expect(substituteArgs("Test: $@[2:2]", ["a", "b", "c", "d"])).toBe("Test: b c");
	});

	test("should support $@ slicing with start and trailing colon", () => {
		expect(substituteArgs("Test: $@[3:]", ["a", "b", "c", "d"])).toBe("Test: c d");
	});

	test("should handle out-of-range $@ slicing", () => {
		expect(substituteArgs("Test: $@[5:]", ["a", "b"])).toBe("Test: ");
	});

	test("should treat non-positive $@ slicing as empty", () => {
		expect(substituteArgs("Test: $@[0:]", ["a", "b"])).toBe("Test: ");
	});

	test("should replace $@ and $ARGUMENTS identically", () => {
		const args = ["foo", "bar", "baz"];
		expect(substituteArgs("Test: $@", args)).toBe(substituteArgs("Test: $ARGUMENTS", args));
	});

	// CRITICAL: argument values containing patterns should remain literal
	test("should NOT recursively substitute patterns in argument values", () => {
		expect(substituteArgs("$ARGUMENTS", ["$1", "$ARGUMENTS"])).toBe("$1 $ARGUMENTS");
		expect(substituteArgs("$@", ["$100", "$1"])).toBe("$100 $1");
		expect(substituteArgs("$ARGUMENTS", ["$100", "$1"])).toBe("$100 $1");
	});

	test("should support mixed $1, $2, and $ARGUMENTS", () => {
		expect(substituteArgs("$1: $ARGUMENTS", ["prefix", "a", "b"])).toBe("prefix: prefix a b");
	});

	test("should support mixed $1, $2, and $@", () => {
		expect(substituteArgs("$1: $@", ["prefix", "a", "b"])).toBe("prefix: prefix a b");
	});

	test("should handle empty arguments array with $ARGUMENTS", () => {
		expect(substituteArgs("Test: $ARGUMENTS", [])).toBe("Test: ");
	});

	test("should handle empty arguments array with $@", () => {
		expect(substituteArgs("Test: $@", [])).toBe("Test: ");
	});

	test("should handle empty arguments array with $1", () => {
		expect(substituteArgs("Test: $1", [])).toBe("Test: ");
	});

	test("should handle multiple occurrences of $ARGUMENTS", () => {
		expect(substituteArgs("$ARGUMENTS and $ARGUMENTS", ["a", "b"])).toBe("a b and a b");
	});

	test("should handle multiple occurrences of $@", () => {
		expect(substituteArgs("$@ and $@", ["a", "b"])).toBe("a b and a b");
	});

	test("should handle mixed occurrences of $@ and $ARGUMENTS", () => {
		expect(substituteArgs("$@ and $ARGUMENTS", ["a", "b"])).toBe("a b and a b");
	});

	test("should handle special characters in arguments", () => {
		// Note: $100 in argument doesn't get partially matched - full strings are substituted
		expect(substituteArgs("$1 $2: $ARGUMENTS", ["arg100", "@user"])).toBe("arg100 @user: arg100 @user");
	});

	test("should handle out-of-range numbered placeholders", () => {
		// Note: Out-of-range placeholders become empty strings (preserving spaces from template)
		expect(substituteArgs("$1 $2 $3 $4 $5", ["a", "b"])).toBe("a b   ");
	});

	test("should handle unicode characters", () => {
		expect(substituteArgs("$ARGUMENTS", ["日本語", "🎉", "café"])).toBe("日本語 🎉 café");
	});

	test("should preserve newlines and tabs in argument values", () => {
		expect(substituteArgs("$1 $2", ["line1\nline2", "tab\tthere"])).toBe("line1\nline2 tab\tthere");
	});

	test("should handle consecutive dollar patterns", () => {
		expect(substituteArgs("$1$2", ["a", "b"])).toBe("ab");
	});

	test("should handle quoted arguments with spaces", () => {
		expect(substituteArgs("$ARGUMENTS", ["first arg", "second arg"])).toBe("first arg second arg");
	});

	test("should handle single argument with $ARGUMENTS", () => {
		expect(substituteArgs("Test: $ARGUMENTS", ["only"])).toBe("Test: only");
	});

	test("should handle single argument with $@", () => {
		expect(substituteArgs("Test: $@", ["only"])).toBe("Test: only");
	});

	test("should handle $0 (zero index)", () => {
		expect(substituteArgs("$0", ["a", "b"])).toBe("");
	});

	test("should handle decimal number in pattern (only integer part matches)", () => {
		expect(substituteArgs("$1.5", ["a"])).toBe("a.5");
	});

	test("should handle $ARGUMENTS as part of word", () => {
		expect(substituteArgs("pre$ARGUMENTS", ["a", "b"])).toBe("prea b");
	});

	test("should handle $@ as part of word", () => {
		expect(substituteArgs("pre$@", ["a", "b"])).toBe("prea b");
	});

	test("should handle empty arguments in middle of list", () => {
		expect(substituteArgs("$ARGUMENTS", ["a", "", "c"])).toBe("a  c");
	});

	test("should handle trailing and leading spaces in arguments", () => {
		expect(substituteArgs("$ARGUMENTS", ["  leading  ", "trailing  "])).toBe("  leading   trailing  ");
	});

	test("should handle argument containing pattern partially", () => {
		expect(substituteArgs("Prefix $ARGUMENTS suffix", ["ARGUMENTS"])).toBe("Prefix ARGUMENTS suffix");
	});

	test("should handle non-matching patterns", () => {
		expect(substituteArgs("$A $$ $ $ARGS", ["a"])).toBe("$A $$ $ $ARGS");
	});

	test("should handle case variations (case-sensitive)", () => {
		expect(substituteArgs("$arguments $Arguments $ARGUMENTS", ["a", "b"])).toBe("$arguments $Arguments a b");
	});

	test("should handle both syntaxes in same command with same result", () => {
		const args = ["x", "y", "z"];
		const result1 = substituteArgs("$@ and $ARGUMENTS", args);
		const result2 = substituteArgs("$ARGUMENTS and $@", args);
		expect(result1).toBe(result2);
		expect(result1).toBe("x y z and x y z");
	});

	test("should handle very long argument lists", () => {
		const args = Array.from({ length: 100 }, (_, i) => `arg${i}`);
		const result = substituteArgs("$ARGUMENTS", args);
		expect(result).toBe(args.join(" "));
	});

	test("should handle numbered placeholders with single digit", () => {
		expect(substituteArgs("$1 $2 $3", ["a", "b", "c"])).toBe("a b c");
	});

	test("should handle numbered placeholders with multiple digits", () => {
		const args = Array.from({ length: 15 }, (_, i) => `val${i}`);
		expect(substituteArgs("$10 $12 $15", args)).toBe("val9 val11 val14");
	});

	test("should handle escaped dollar signs (literal backslash preserved)", () => {
		// Note: No escape mechanism exists - backslash is treated literally
		expect(substituteArgs("Price: \\$100", [])).toBe("Price: \\");
	});

	test("should handle mixed numbered and wildcard placeholders", () => {
		expect(substituteArgs("$1: $@ ($ARGUMENTS)", ["first", "second", "third"])).toBe(
			"first: first second third (first second third)",
		);
	});

	test("should handle command with no placeholders", () => {
		expect(substituteArgs("Just plain text", ["a", "b"])).toBe("Just plain text");
	});

	test("should handle command with only placeholders", () => {
		expect(substituteArgs("$1 $2 $@", ["a", "b", "c"])).toBe("a b a b c");
	});
});

// ============================================================================
// parseCommandArgs
// ============================================================================

describe("parseCommandArgs", () => {
	test("should parse simple space-separated arguments", () => {
		expect(parseCommandArgs("a b c")).toEqual(["a", "b", "c"]);
	});

	test("should parse quoted arguments with spaces", () => {
		expect(parseCommandArgs('"first arg" second')).toEqual(["first arg", "second"]);
	});

	test("should parse single-quoted arguments", () => {
		expect(parseCommandArgs("'first arg' second")).toEqual(["first arg", "second"]);
	});

	test("should parse mixed quote styles", () => {
		expect(parseCommandArgs('"double" \'single\' "double again"')).toEqual(["double", "single", "double again"]);
	});

	test("should handle empty string", () => {
		expect(parseCommandArgs("")).toEqual([]);
	});

	test("should handle extra spaces", () => {
		expect(parseCommandArgs("a  b   c")).toEqual(["a", "b", "c"]);
	});

	test("should handle tabs as separators", () => {
		expect(parseCommandArgs("a\tb\tc")).toEqual(["a", "b", "c"]);
	});

	test("should handle quoted empty string", () => {
		// Note: Empty quotes are skipped by current implementation
		expect(parseCommandArgs('"" " "')).toEqual([" "]);
	});

	test("should handle arguments with special characters", () => {
		expect(parseCommandArgs("$100 @user #tag")).toEqual(["$100", "@user", "#tag"]);
	});

	test("should handle unicode characters", () => {
		expect(parseCommandArgs("日本語 🎉 café")).toEqual(["日本語", "🎉", "café"]);
	});

	test("should handle newlines in arguments", () => {
		expect(parseCommandArgs('"line1\nline2" second')).toEqual(["line1\nline2", "second"]);
	});

	test("should handle escaped quotes inside quoted strings", () => {
		// Note: This implementation doesn't handle escaped quotes - backslash is literal
		expect(parseCommandArgs('"quoted \\"text\\""')).toEqual(["quoted \\text\\"]);
	});

	test("should handle trailing spaces", () => {
		expect(parseCommandArgs("a b c   ")).toEqual(["a", "b", "c"]);
	});

	test("should handle leading spaces", () => {
		expect(parseCommandArgs("   a b c")).toEqual(["a", "b", "c"]);
	});
});

// ============================================================================
// Integration
// ============================================================================

describe("parseCommandArgs + substituteArgs integration", () => {
	test("should parse and substitute together correctly", () => {
		const input = 'Button "onClick handler" "disabled support"';
		const args = parseCommandArgs(input);
		const template = "Create component $1 with features: $ARGUMENTS";
		const result = substituteArgs(template, args);
		expect(result).toBe("Create component Button with features: Button onClick handler disabled support");
	});

	test("should handle the example from README", () => {
		const input = 'Button "onClick handler" "disabled support"';
		const args = parseCommandArgs(input);
		const template = "Create a React component named $1 with features: $ARGUMENTS";
		const result = substituteArgs(template, args);
		expect(result).toBe(
			"Create a React component named Button with features: Button onClick handler disabled support",
		);
	});

	test("should produce same result with $@ and $ARGUMENTS", () => {
		const args = parseCommandArgs("feature1 feature2 feature3");
		const template1 = "Implement: $@";
		const template2 = "Implement: $ARGUMENTS";
		expect(substituteArgs(template1, args)).toBe(substituteArgs(template2, args));
	});
});

// ============================================================================
// Hashline prompt helpers
// ============================================================================

describe("hashline prompt helpers", () => {
	function createPromptTemplate(content: string): PromptTemplate {
		return {
			name: "test-template",
			description: "Test template",
			content,
			source: "test",
		};
	}

	function expandPrompt(content: string): string {
		return expandPromptTemplate("/test-template", [createPromptTemplate(content)]);
	}

	test("href and hrefr should reuse anchors remembered from hline", () => {
		const result = expandPrompt(
			'{{hline 2 "const timeout = 5000;"}}\nquoted={{href 2}}\nraw={{hrefr 2}}\nlast={{hrefr}}',
		);
		const [line, quoted, raw, last] = result.split("\n");
		const ref = line.split("|", 1)[0];

		expect(line).toBe(`${ref}|const timeout = 5000;`);
		expect(quoted).toBe(`quoted="${ref}"`);
		expect(raw).toBe(`raw=${ref}`);
		expect(last).toBe(`last=${ref}`);
	});

	test("href and hrefr should still support explicit content without hline state", () => {
		const result = expandPrompt('quoted={{href 5 "\treturn clean;"}}\nraw={{hrefr 5 "\treturn clean;"}}');
		const [quoted, raw] = result.split("\n");
		const ref = raw.slice("raw=".length);

		expect(quoted).toBe(`quoted="${ref}"`);
		expect(ref).toMatch(/^5[a-z]{2}$/);
	});

	test("href should not reuse hline state across prompt renders", () => {
		expect(expandPrompt('{{hline 1 "const x = 1;"}}\n{{hrefr}}')).toMatch(/^1[a-z]{2}\|const x = 1;\n1[a-z]{2}$/);
		expect(() => expandPrompt("{{hrefr}}")).toThrow("previous {{hline}}");
	});
});

// ============================================================================
// expandSlashCommand + expandPromptTemplate fallback behavior
// ============================================================================

describe("template expansion fallback", () => {
	function createSlashCommand(content: string): FileSlashCommand {
		return {
			name: "test-command",
			description: "Test command",
			content,
			source: "test",
		};
	}

	function createPromptTemplate(content: string): PromptTemplate {
		return {
			name: "test-template",
			description: "Test template",
			content,
			source: "test",
		};
	}

	function expandSlash(invocation: string, content: string): string {
		return expandSlashCommand(invocation, [createSlashCommand(content)]);
	}

	function expandPrompt(invocation: string, content: string): string {
		return expandPromptTemplate(invocation, [createPromptTemplate(content)]);
	}

	const helperConsumptionCases = [
		{ name: "slash command", invocation: "/test-command none", expand: expandSlash },
		{ name: "prompt template", invocation: "/test-template none", expand: expandPrompt },
	] as const;

	test("should append trailing inline args for slash command without placeholders", () => {
		const result = expandSlash("/test-command sample input text", "Do something.");
		expect(result).toBe("Do something.\n\nsample input text");
	});

	test("should append trailing inline args for prompt template without placeholders", () => {
		const result = expandPrompt("/test-template sample input text", "Do something.");
		expect(result).toBe("Do something.\n\nsample input text");
	});

	test("should not append fallback text when $ARGUMENTS consumes args", () => {
		const result = expandSlash("/test-command sample input text", "Do: $ARGUMENTS");
		expect(result).toBe("Do: sample input text");
	});

	test("should not append fallback text when Handlebars arguments consumes args", () => {
		const result = expandPrompt("/test-template sample input text", "Do: {{arguments}}");
		expect(result).toBe("Do: sample input text");
	});

	for (const { name, invocation, expand } of helperConsumptionCases) {
		test(`should not append fallback text when Handlebars default consumes args for ${name} even when the rendered text is unchanged`, () => {
			const result = expand(invocation, '{{default arguments "none"}}');
			expect(result).toBe("none");
		});

		test(`should not append fallback text when Handlebars arg helper consumes args for ${name}`, () => {
			const result = expand(invocation, "{{arg 1}}");
			expect(result).toBe("none");
		});

		test(`should not append fallback text when Handlebars lookup consumes args for ${name}`, () => {
			const result = expand(invocation, '{{default (lookup . "arguments") "none"}}');
			expect(result).toBe("none");
		});

		test(`should return inline args without a leading newline when the template body is empty for ${name}`, () => {
			const result = expand(invocation, "");
			expect(result).toBe("none");
		});
	}

	test("should keep output unchanged when slash command has no trailing args", () => {
		const result = expandSlash("/test-command", "Do something.");
		expect(result).toBe("Do something.");
	});

	test("should keep output unchanged when prompt template has no trailing args", () => {
		const result = expandPrompt("/test-template", "Do something.");
		expect(result).toBe("Do something.");
	});

	test("should append two fallback newlines for slash command output even when template source ends with newline", () => {
		const result = expandSlash("/test-command sample", "Do something.\n");
		expect(result).toBe("Do something.\n\nsample");
	});

	test("should append two fallback newlines for prompt template output even when template source ends with newline", () => {
		const result = expandPrompt("/test-template sample", "Do something.\n");
		expect(result).toBe("Do something.\n\nsample");
	});
});
