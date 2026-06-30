import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

describe("parseFrontmatter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts unquoted skill descriptions containing colon-space without warning", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
name: tool-prompt-optimization
description: Optimize tool prompts. Two halves: measure schema overlap; keep scar tissue.
enabled: true
---
Skill body`;

		const result = parseFrontmatter(content, { source: "bad-skill/SKILL.md" });

		expect(result.frontmatter).toEqual({
			name: "tool-prompt-optimization",
			description: "Optimize tool prompts. Two halves: measure schema overlap; keep scar tissue.",
			enabled: true,
		});
		expect(result.body).toBe("Skill body");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("still warns and falls back for unrecoverable malformed frontmatter", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const content = `---
invalid: [unclosed array
---
Body content`;

		const result = parseFrontmatter(content, { source: "broken.md" });

		expect(result.frontmatter).toEqual({ invalid: "[unclosed array" });
		expect(result.body).toBe("Body content");
		expect(warnSpy).toHaveBeenCalledWith(
			"Failed to parse YAML frontmatter",
			expect.objectContaining({ err: expect.stringContaining("broken.md") }),
		);
	});
});
