import { hookFetch } from "@oh-my-pi/pi-utils";
import { describe, expect, it } from "bun:test";
import {
	isVerbatimLine,
	makeOpenRouterRewriter,
	peel,
	planRewrite,
	preservesTokens,
	type RewriteItem,
	rewriteAll,
} from "./rewrite-system-prompt";

describe("peel", () => {
	it("keeps prefix + core + suffix === line for every shape", () => {
		const lines = [
			"You are the engineer.",
			"- You NEVER yield.",
			" - debugging across code,",
			'{{#has tools "read"}}- file reads → `{{toolRefs.read}}`{{/has}}',
			"1. first numbered item",
		];
		for (const line of lines) {
			const { prefix, core, suffix } = peel(line);
			expect(prefix + core + suffix).toBe(line);
		}
	});

	it("peels a list marker into the prefix", () => {
		expect(peel("- You NEVER yield.")).toEqual({
			prefix: "- ",
			core: "You NEVER yield.",
			suffix: "",
		});
	});

	it("peels wrapping handlebars block tokens into prefix/suffix, leaving the sentence as core", () => {
		expect(peel('{{#has tools "read"}}- file reads here{{/has}}')).toEqual({
			prefix: '{{#has tools "read"}}- ',
			core: "file reads here",
			suffix: "{{/has}}",
		});
	});
});

describe("isVerbatimLine", () => {
	it("preserves structural lines", () => {
		for (const line of [
			"",
			"   ",
			"<stakes>",
			"</system-conventions>",
			"<tool id={{name}}>",
			"{{#if skills.length}}",
			"{{/each}}",
			"{{content}}",
			"- {{name}}: {{description}}",
			"# URLs",
			"## LSP",
			"===================================",
			"- `mcp://<uri>`: MCP resource",
		]) {
			expect(isVerbatimLine(line)).toBe(true);
		}
	});

	it("treats real prose as rewritable, including prose wrapped in handlebars", () => {
		for (const line of [
			"You MUST optimize for correctness first.",
			"- You NEVER yield incomplete work.",
			'{{#has tools "read"}}- file/dir reads → `{{toolRefs.read}}`, not `cat`/`ls`{{/has}}',
			"- `omp://`: Harness documentation; AVOID reading unless asked.",
		]) {
			expect(isVerbatimLine(line)).toBe(false);
		}
	});
});

describe("preservesTokens", () => {
	it("passes only when every fragile token survives with its multiplicity", () => {
		const tokens = ["`{{toolRefs.read}}`", "`{{toolRefs.read}}`", "`cat`"];
		expect(
			preservesTokens("use `{{toolRefs.read}}` not `cat`, `{{toolRefs.read}}` lists", tokens),
		).toBe(true);
		// only one occurrence of the duplicated token -> fails the count check
		expect(preservesTokens("use `{{toolRefs.read}}` not `cat`", tokens)).toBe(false);
		// token reworded away -> fails
		expect(preservesTokens("use read not `cat`", tokens)).toBe(false);
	});

	it("is vacuously true when there are no tokens", () => {
		expect(preservesTokens("anything goes", [])).toBe(true);
	});
});

describe("planRewrite", () => {
	it("collects only prose lines, with peeled prefix and extracted tokens", () => {
		const src = [
			"<stakes>",
			"You MUST do the thing.",
			"- Use `{{toolRefs.read}}` to read.",
			"# Header",
			"{{#if x}}",
			"</stakes>",
			"",
		].join("\n");
		const plan = planRewrite(src);
		expect(plan.prose.map((p) => p.lineIndex)).toEqual([1, 2]);
		expect(plan.prose[1]).toMatchObject({
			prefix: "- ",
			core: "Use `{{toolRefs.read}}` to read.",
			tokens: ["`{{toolRefs.read}}`"],
		});
	});
});

describe("rewriteAll", () => {
	const src = [
		"<stakes>",
		"You MUST do the thing.",
		"- Use `{{toolRefs.read}}` to read.",
		"</stakes>",
	].join("\n");

	it("rewrites prose, reassembles by line, and leaves structural lines byte-exact", async () => {
		const fake = async (items: RewriteItem[]) =>
			new Map(items.map((i) => [i.id, `NEW:${i.text}`]));
		const { content, stats } = await rewriteAll(src, fake, {
			chunkSize: 3,
			concurrency: 2,
			limit: 0,
		});
		const lines = content.split("\n");
		expect(lines[0]).toBe("<stakes>"); // structural, untouched
		expect(lines[3]).toBe("</stakes>");
		expect(lines[1]).toBe("NEW:You MUST do the thing.");
		expect(lines[2]).toBe("- NEW:Use `{{toolRefs.read}}` to read."); // prefix + token preserved
		expect(stats).toMatchObject({ proseLines: 2, changed: 2, fallback: 0 });
	});

	it("falls back to the original line when the chunk omits an id", async () => {
		const empty = async () => new Map<number, string>();
		const { content, stats } = await rewriteAll(src, empty, {
			chunkSize: 3,
			concurrency: 2,
			limit: 0,
		});
		expect(content).toBe(src); // nothing changed
		expect(stats).toMatchObject({ changed: 0, fallback: 2 });
	});
});

describe("makeOpenRouterRewriter", () => {
	const reply = (items: { id: number; text: string }[]) =>
		new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});

	it("re-requests only the lines whose rewrite dropped a fragile token", async () => {
		const requestedIds: number[][] = [];
		using _hook = hookFetch((_input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				messages: { content: string }[];
			};
			const sent = JSON.parse(body.messages[1].content) as {
				items: { id: number; text: string }[];
			};
			requestedIds.push(sent.items.map((i) => i.id));
			const firstAttempt = requestedIds.length === 1;
			return reply(
				sent.items.map(({ id }) =>
					id === 1
						? { id, text: firstAttempt ? "Use X to read." : "Read via `X`." } // first drops the token
						: { id, text: "PLAIN." },
				),
			);
		});

		const rewrite = makeOpenRouterRewriter({
			apiKey: "k",
			model: "m",
			baseUrl: "https://example.invalid/v1",
			temperature: 0,
			retries: 2,
			system: "s",
		});
		const result = await rewrite([
			{ id: 1, text: "Use `X` to read.", tokens: ["`X`"] },
			{ id: 2, text: "Plain prose here.", tokens: [] },
		]);

		expect(result.get(1)).toBe("Read via `X`."); // accepted only after the token survived
		expect(result.get(2)).toBe("PLAIN.");
		expect(requestedIds.length).toBe(2);
		expect(requestedIds[1]).toEqual([1]); // retry carried only the still-failing line
	});

	it("omits an id that never passes validation so the caller keeps the original", async () => {
		using _hook = hookFetch((_input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				messages: { content: string }[];
			};
			const sent = JSON.parse(body.messages[1].content) as {
				items: { id: number; text: string }[];
			};
			return reply(sent.items.map(({ id }) => ({ id, text: "no token here" })));
		});

		const rewrite = makeOpenRouterRewriter({
			apiKey: "k",
			model: "m",
			baseUrl: "https://example.invalid/v1",
			temperature: 0,
			retries: 1,
			system: "s",
		});
		const result = await rewrite([{ id: 7, text: "keep `T`", tokens: ["`T`"] }]);
		expect(result.has(7)).toBe(false);
	});
});
