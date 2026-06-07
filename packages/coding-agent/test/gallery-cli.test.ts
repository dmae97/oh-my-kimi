import { beforeAll, describe, expect, it } from "bun:test";
import { GALLERY_STATES, renderGalleryState, resolveFixture } from "../src/cli/gallery-cli";
import type { GalleryFixture } from "../src/cli/gallery-fixtures";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { initTheme } from "../src/modes/theme/theme";
import { toolRenderers } from "../src/tools/renderers";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, undefined, undefined, "dark", "light");
});

describe("gallery harness", () => {
	it("renders every registered tool in every lifecycle state without throwing", async () => {
		for (const name in toolRenderers) {
			const fixture = resolveFixture(name);
			for (const state of GALLERY_STATES) {
				const lines = await renderGalleryState(name, fixture, state, 100);
				// A renderer that produces no lines for a state is a regression: the
				// component should always emit at least the call header or result.
				expect(lines.length, `${name}/${state} rendered nothing`).toBeGreaterThan(0);
			}
		}
	});

	it("routes each state to the matching args/result (streaming args vs result, success vs error)", async () => {
		const fixture: GalleryFixture = {
			label: "Bash",
			streamingArgs: { command: "echo STREAM_MARK" },
			args: { command: "echo PROGRESS_MARK" },
			result: { content: [{ type: "text", text: "SUCCESS_OUT" }], details: { exitCode: 0 } },
			errorResult: { content: [{ type: "text", text: "ERROR_OUT" }], isError: true, details: { exitCode: 1 } },
		};
		const render = async (state: (typeof GALLERY_STATES)[number]) =>
			Bun.stripANSI((await renderGalleryState("bash", fixture, state, 100)).join("\n"));

		const streaming = await render("streaming");
		expect(streaming).toContain("STREAM_MARK");
		expect(streaming).not.toContain("PROGRESS_MARK");
		expect(streaming).not.toContain("SUCCESS_OUT");

		const progress = await render("progress");
		expect(progress).toContain("PROGRESS_MARK");
		expect(progress).not.toContain("SUCCESS_OUT");

		const success = await render("success");
		expect(success).toContain("SUCCESS_OUT");
		expect(success).not.toContain("ERROR_OUT");

		const error = await render("error");
		expect(error).toContain("ERROR_OUT");
		expect(error).not.toContain("SUCCESS_OUT");
	});

	it("routes customRendered tools (lsp, task) through the custom-tool branch", async () => {
		// `lsp`/`task` attach their renderers on the real AgentTool, so the gallery
		// must reproduce that path. With a result present and mergeCallAndResult, the
		// custom branch must NOT emit a redundant tool-name line above the result box
		// (regression guard for tool-execution's custom-branch fallback label).
		const lsp = resolveFixture("lsp");
		expect(lsp.customRendered).toBe(true);
		const lines = await renderGalleryState("lsp", lsp, "error", 100);
		const stripped = lines.map(line => Bun.stripANSI(line).trim());
		// The framed result header is present...
		expect(stripped.some(line => line.includes("LSP references"))).toBe(true);
		// ...but no standalone "LSP" label line precedes it.
		expect(stripped).not.toContain("LSP");
	});

	it("falls back to a generic fixture for registry tools without curated sample data", () => {
		// resolveFixture never returns undefined for a registry tool, even one
		// missing from the curated fixtures, so the gallery cannot crash on a newly
		// added renderer.
		const fixture = resolveFixture("a-tool-that-has-no-fixture");
		expect(fixture.args).toBeDefined();
		expect(fixture.result.content.length).toBeGreaterThan(0);
	});
});
