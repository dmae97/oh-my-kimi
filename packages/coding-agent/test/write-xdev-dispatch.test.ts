import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import { XdevRegistry } from "@oh-my-pi/pi-coding-agent/tools/xdev";
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

	it("docsAll inlines small device docs and falls back to a listing past the caps", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-docs-"));
		try {
			const session = xdevSession(tempDir);
			await createTools(session);
			const mounted = session.xdevRegistry?.list() ?? [];
			expect(mounted.length).toBeGreaterThan(0);

			// One device with a pathological description must fall back to the
			// listing without starving the rest of the catalog.
			const giant = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(giant, "name", { value: "giant_mcp_tool" });
			Object.defineProperty(giant, "description", { value: "x".repeat(XdevRegistry.DOCS_PER_DEVICE_CAP + 1) });
			const registry = new XdevRegistry([...mounted, giant]);

			const docs = registry.docsAll();
			expect(docs.length).toBeLessThan(XdevRegistry.DOCS_TOTAL_BUDGET + XdevRegistry.DOCS_PER_DEVICE_CAP);
			expect(docs).toContain(`## ${mounted[0]!.name}`);
			expect(docs).toContain("## Additional devices (docs on demand)");
			expect(docs).toContain("- xd://giant_mcp_tool —");
			expect(docs).not.toContain("## giant_mcp_tool");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("docsAll truncates external (dynamic-mount) descriptions to the cap; built-ins and read xd:// stay full", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-xdev-external-"));
		try {
			const session = xdevSession(tempDir);
			await createTools(session);
			const registry = session.xdevRegistry;
			if (!registry) throw new Error("expected xdev registry");
			const mounted = registry.list();

			const longDescription = `LEDE ${"y".repeat(XdevRegistry.EXTERNAL_DESCRIPTION_CAP * 3)} TAIL`;
			const external = Object.create(mounted[0]!) as (typeof mounted)[number];
			Object.defineProperty(external, "name", { value: "mcp_external_tool" });
			Object.defineProperty(external, "description", { value: longDescription });
			registry.reconcile([external]);

			const docs = registry.docsAll();
			// External device: schema section present, description cut at the cap.
			expect(docs).toContain("## mcp_external_tool");
			expect(docs).toContain("LEDE ");
			expect(docs).not.toContain("TAIL");
			expect(docs).toContain("… (full docs: read xd://mcp_external_tool)");
			// Built-in devices keep their full curated description.
			expect(docs).toContain(mounted[0]!.description ?? "");
			// On-demand docs return the untruncated text.
			expect(registry.docs("mcp_external_tool")).toContain("TAIL");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
