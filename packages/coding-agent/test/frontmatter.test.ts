import { describe, expect, it } from "vitest";
import { parseFrontmatter, stripFrontmatter } from "../src/utils/frontmatter.ts";

describe("parseFrontmatter", () => {
	it("parses keys, strips quotes, and returns body", () => {
		const input = "---\nname: \"skill-name\"\ndescription: 'A desc'\nfoo-bar: value\n---\n\nBody text";
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		expect(frontmatter.name).toBe("skill-name");
		expect(frontmatter.description).toBe("A desc");
		expect(frontmatter["foo-bar"]).toBe("value");
		expect(body).toBe("Body text");
	});

	it("normalizes newlines and handles CRLF", () => {
		const input = "---\r\nname: test\r\n---\r\nLine one\r\nLine two";
		const { body } = parseFrontmatter<Record<string, string>>(input);
		expect(body).toBe("Line one\nLine two");
	});

	it("throws on invalid YAML frontmatter", () => {
		const input = "---\nfoo: [bar\n---\nBody";
		expect(() => parseFrontmatter<Record<string, string>>(input)).toThrow(/at line 1, column 10/);
	});

	it("parses | multiline yaml syntax", () => {
		const input = "---\ndescription: |\n  Line one\n  Line two\n---\n\nBody";
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		expect(frontmatter.description).toBe("Line one\nLine two\n");
		expect(body).toBe("Body");
	});

	it("returns original content when frontmatter is missing or unterminated", () => {
		const noFrontmatter = "Just text\nsecond line";
		const missingEnd = "---\nname: test\nBody without terminator";
		const resultNoFrontmatter = parseFrontmatter<Record<string, string>>(noFrontmatter);
		const resultMissingEnd = parseFrontmatter<Record<string, string>>(missingEnd);
		expect(resultNoFrontmatter.body).toBe("Just text\nsecond line");
		expect(resultMissingEnd.body).toBe(
			"---\nname: test\nBody without terminator".replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
		);
	});

	it("returns empty object for empty or comment-only frontmatter", () => {
		const input = "---\n# just a comment\n---\nBody";
		const { frontmatter } = parseFrontmatter(input);
		expect(frontmatter).toEqual({});
	});

	it("parses frontmatter after comment/HTML preamble (bigpowers-style)", () => {
		const input =
			"# story: e51s04\n<!-- story: e45s12 -->\n---\nname: audit-code\ndescription: Self-review checklist\n---\n\n# Audit Code\n";
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		expect(frontmatter.name).toBe("audit-code");
		expect(frontmatter.description).toBe("Self-review checklist");
		expect(body).toContain("# Audit Code");
	});

	it("ignores preamble that is not comment noise", () => {
		const input = "# Real heading\n\nSome prose before fence.\n---\nname: nope\ndescription: x\n---\nBody";
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(input);
		expect(frontmatter).toEqual({});
		expect(body).toContain("Some prose before fence.");
	});
});

describe("stripFrontmatter", () => {
	it("removes frontmatter and trims body", () => {
		const input = "---\nkey: value\n---\n\nBody\n";
		expect(stripFrontmatter(input)).toBe("Body");
	});

	it("returns body when no frontmatter present", () => {
		const input = "\n  No frontmatter body  \n";
		expect(stripFrontmatter(input)).toBe("\n  No frontmatter body  \n");
	});
});
