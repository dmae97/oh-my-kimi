import { describe, expect, it } from "bun:test";
import { collectPromotableAddedItemLines, fixChangelogContent } from "./fix-changelogs";

describe("collectPromotableAddedItemLines", () => {
	it("keeps new changelog item additions while ignoring moves and edits", () => {
		const diff = [
			"diff --git a/packages/example/CHANGELOG.md b/packages/example/CHANGELOG.md",
			"--- a/packages/example/CHANGELOG.md",
			"+++ b/packages/example/CHANGELOG.md",
			"@@ -10,0 +11,2 @@",
			"+",
			"+- Added after the latest tag in a released section.",
			"@@ -20 +22 @@",
			"-- Moved historical entry.",
			"+- Moved historical entry.",
			"@@ -30 +32,2 @@",
			"-- Historical entry with old wording.",
			"+- Historical entry with new wording.",
			"+- Another brand-new item in the same hunk.",
		].join("\n");

		const lines = collectPromotableAddedItemLines(diff);

		expect(lines.get("packages/example/CHANGELOG.md")).toEqual(new Set([12, 33]));
	});
});

describe("fixChangelogContent", () => {
	it("moves added released-section items to Unreleased and merges duplicate category headings", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"### Fixed",
			"",
			"- Existing fix.",
			"",
			"### Fixed",
			"",
			"- Second fix.",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"### Added",
			"",
			"- Historical addition.",
			"- New addition in released section.",
			"",
			"### Fixed",
			"",
			"- Historical fix.",
			"- New fix in released section.",
			"",
		].join("\n");

		const result = fixChangelogContent(content, new Set([17, 22]));

		expect(result.promotedItems).toBe(2);
		expect(result.mergedDuplicateHeadings).toBe(1);
		expect(result.content).toBe([
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- New addition in released section.",
			"",
			"### Fixed",
			"",
			"- Existing fix.",
			"- Second fix.",
			"- New fix in released section.",
			"",
			"## [1.0.0] - 2026-01-01",
			"",
			"### Added",
			"",
			"- Historical addition.",
			"",
			"### Fixed",
			"",
			"- Historical fix.",
			"",
		].join("\n"));
	});
});
