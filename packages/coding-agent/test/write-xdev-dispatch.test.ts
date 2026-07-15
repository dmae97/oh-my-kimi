import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// xdev mounting is default-on: discoverable tools like ast_edit unmount into
// xd://, and a plain `write xd://ast_edit` dispatches them. These guard the
// resolution-device symbols write.ts pulls from ./resolve — a missing import
// threw `ReferenceError: isResolutionDeviceName is not defined` on *every*
// xd:// write, in both the executor (approval + execute) and the streaming
// renderer (surfacing as the error text inside a generic Write frame).
function xdevSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
		...overrides,
	};
}

describe("read and write route xd:// device URLs", () => {
	it("lists, documents, and dispatches an ast_edit device", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				xdevSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
			);
			// xdev on: ast_edit is unmounted into xd://; write stays in the toolset.
			const write = tools.find(entry => entry.name === "write");
			const read = tools.find(entry => entry.name === "read");
			expect(read).toBeDefined();
			expect(write).toBeDefined();
			expect(tools.some(entry => entry.name === "ast_edit")).toBe(false);

			const listing = await read!.execute("read-xd-list", { path: "xd://" });
			expect(listing.content.find(entry => entry.type === "text")?.text).toContain("xd://ast_edit");
			const docs = await read!.execute("read-xd-docs", { path: "xd://ast_edit" });
			expect(docs.content.find(entry => entry.type === "text")?.text).toContain("# ast_edit");

			const content = JSON.stringify({
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});

			// Approval resolves a tier instead of throwing. A mounted tool whose own
			// approval is a function (unresolvable statically) falls back to exec.
			const approval = write!.approval;
			expect(typeof approval).toBe("function");
			if (typeof approval === "function") {
				expect(approval({ path: "xd://ast_edit", content })).toBe("exec");
			}

			// Execute dispatches through the xdev registry to the mounted ast_edit,
			// staging a preview (not a direct apply).
			const previewResult = await write!.execute("write-xdev-preview", { path: "xd://ast_edit", content });
			expect(previewResult.isError).toBeUndefined();
			expect(previewResult.details?.xdev?.tool).toBe("ast_edit");
			expect(previewResult.details?.xdev?.mode).toBe("execute");
			const previewText = previewResult.content.find(entry => entry.type === "text")?.text ?? "";
			expect(previewText).toContain("modernWrap");

			// The staged preview applies through the resolve queue and rewrites disk.
			const invoker = queue.peekPendingInvoker();
			expect(invoker).toBeDefined();
			await invoker!({ action: "apply", reason: "apply xdev ast edit" });
			expect(await Bun.file(filePath).text()).toContain("modernWrap(x, value)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("renderCall withholds a partial xd:// URL, then delegates once settled", async () => {
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const options = { expanded: false, isPartial: true };

		const content = JSON.stringify({
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: ["/tmp/legacy.ts"],
		});

		// Path still streaming (no content field yet): render nothing so the user
		// never sees a half-typed "xd://ast_" frame.
		expect(writeToolRenderer.renderCall({ path: "xd://ast_e" }, options, uiTheme)).toBeUndefined();

		// Path settled + content streaming: delegate to the mounted tool's renderer
		// instead of throwing ReferenceError inside a generic Write frame.
		const rendered = writeToolRenderer.renderCall({ path: "xd://ast_edit", content }, options, uiTheme);
		expect(rendered).toBeDefined();
	});
});
