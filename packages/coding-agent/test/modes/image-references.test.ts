import { describe, expect, it } from "bun:test";
import { type PlaceholderKind, renderPlaceholders } from "@oh-my-pi/pi-coding-agent/modes/image-references";

function capture(text: string): {
	out: string;
	refs: Array<{ label: string; kind: PlaceholderKind; index: number }>;
} {
	const refs: Array<{ label: string; kind: PlaceholderKind; index: number }> = [];
	const out = renderPlaceholders(text, {
		renderText: t => t,
		renderReference: (label, kind, index) => {
			refs.push({ label, kind, index });
			return `<${kind}:${index}>`;
		},
	});
	return { out, refs };
}

describe("renderPlaceholders", () => {
	it("classifies image and paste markers with their index and full label", () => {
		const { out, refs } = capture("see [Image #1, 800x600] then [Paste #2, +30 lines] done");
		expect(refs).toEqual([
			{ label: "[Image #1, 800x600]", kind: "image", index: 1 },
			{ label: "[Paste #2, +30 lines]", kind: "paste", index: 2 },
		]);
		expect(out).toBe("see <image:1> then <paste:2> done");
	});

	it("matches the bare image form and the char-count paste form", () => {
		expect(capture("[Image #3]").refs[0]).toMatchObject({ kind: "image", index: 3 });
		expect(capture("[Paste #4, 1500 chars]").refs[0]).toMatchObject({ kind: "paste", index: 4 });
	});

	it("passes plain text straight through renderText with no references", () => {
		const { out, refs } = capture("no markers here");
		expect(refs).toHaveLength(0);
		expect(out).toBe("no markers here");
	});

	it("does not treat an unterminated marker as a reference", () => {
		// This is the half-eaten state atomic deletion prevents — it must render as plain text.
		const { refs } = capture("[Paste #1, +30 lines");
		expect(refs).toHaveLength(0);
	});
});
