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

	it("does not promote items from newly added release sections", () => {
		const diff = [
			"diff --git a/packages/example/CHANGELOG.md b/packages/example/CHANGELOG.md",
			"--- a/packages/example/CHANGELOG.md",
			"+++ b/packages/example/CHANGELOG.md",
			"@@ -1,0 +1,8 @@",
			"+# Changelog",
			"+",
			"+## [1.0.0] - 2026-01-01",
			"+",
			"+### Fixed",
			"+",
			"+- Released fix.",
			"+- Another released fix.",
		].join("\n");

		const lines = collectPromotableAddedItemLines(diff);

		expect(lines.get("packages/example/CHANGELOG.md")).toBeUndefined();
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

	it("drops Unreleased items that already appear verbatim in a released section", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Brand-new unreleased feature.",
			"- Added fullscreen settings mouse-event handling.",
			"",
			"## [1.1.0] - 2026-02-01",
			"",
			"### Added",
			"",
			"- Added fullscreen settings mouse-event handling.",
			"",
		].join("\n");

		const result = fixChangelogContent(content, new Set());

		expect(result.droppedReleasedDuplicates).toBe(1);
		expect(result.promotedItems).toBe(0);
		expect(result.content).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Added",
				"",
				"- Brand-new unreleased feature.",
				"",
				"## [1.1.0] - 2026-02-01",
				"",
				"### Added",
				"",
				"- Added fullscreen settings mouse-event handling.",
				"",
			].join("\n"),
		);
	});

	it("can recover Unreleased by dropping bullets known to be historically released", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Fixed",
			"",
			"- Historical fix still stranded in Unreleased.",
			"- Brand-new fix.",
			"",
			"## [1.1.0] - 2026-02-01",
			"",
		].join("\n");

		const result = fixChangelogContent(
			content,
			new Set(),
			new Set(["- Historical fix still stranded in Unreleased."]),
		);

		expect(result.droppedReleasedDuplicates).toBe(1);
		expect(result.content).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Fixed",
				"",
				"- Brand-new fix.",
				"",
				"## [1.1.0] - 2026-02-01",
				"",
			].join("\n"),
		);
	});

	it("compacts blank separators between adjacent bullet items", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Fixed",
			"",
			"- First fix.",
			"",
			"- Second fix.",
			"",
			"## [1.1.0] - 2026-02-01",
			"",
		].join("\n");

		const result = fixChangelogContent(content, new Set());

		expect(result.content).toBe(
			[
				"# Changelog",
				"",
				"## [Unreleased]",
				"",
				"### Fixed",
				"",
				"- First fix.",
				"- Second fix.",
				"",
				"## [1.1.0] - 2026-02-01",
				"",
			].join("\n"),
		);
	});

	it("leaves a clean changelog untouched", () => {
		const content = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"### Added",
			"",
			"- Only an unreleased feature.",
			"",
			"## [1.1.0] - 2026-02-01",
			"",
			"### Added",
			"",
			"- A released feature.",
			"",
		].join("\n");

		const result = fixChangelogContent(content, new Set());

		expect(result.droppedReleasedDuplicates).toBe(0);
		expect(result.content).toBe(content);
	});
});
