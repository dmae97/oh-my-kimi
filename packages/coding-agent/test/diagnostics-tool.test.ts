import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiagnosticsToolDefinition, type DiagnosticsToolDetails } from "../src/core/tools/diagnostics.ts";

function has(command: string): boolean {
	try {
		execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function runTool(cwd: string, input: Record<string, unknown> = {}) {
	const tool = createDiagnosticsToolDefinition(cwd);
	const result = await tool.execute("tc-1", input as never, undefined, undefined, {} as never);
	return {
		text: (result.content[0] as { type: "text"; text: string }).text,
		details: result.details as DiagnosticsToolDetails,
	};
}

describe("diagnostics tool", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-diagnostics-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("reports skipped languages instead of throwing when no project markers exist", async () => {
		const { text, details } = await runTool(root, { language: "rust" });
		expect(details.diagnostics).toEqual([]);
		expect(details.skipped).toEqual([{ language: "rust", reason: "no Cargo.toml found" }]);
		expect(text).toContain("skipped");
	});

	it.skipIf(!has("tsc"))(
		"surfaces a typescript error from a real tsc run",
		async () => {
			writeFileSync(
				join(root, "tsconfig.json"),
				JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }),
			);
			writeFileSync(join(root, "bad.ts"), "const x: number = 'nope';\nexport {};\n");
			const { details } = await runTool(root, { language: "typescript" });
			expect(details.diagnostics.length).toBeGreaterThan(0);
			expect(details.diagnostics[0].path).toContain("bad.ts");
			expect(details.diagnostics[0].severity).toBe("error");
		},
		120_000,
	);

	it.skipIf(!has("pyright") && !has("ruff"))(
		"surfaces a python issue via pyright or ruff",
		async () => {
			writeFileSync(join(root, "bad.py"), "def f(x: int) -> int:\n    return x + ''\n");
			const { details } = await runTool(root, { language: "python" });
			expect(details.diagnostics.length).toBeGreaterThan(0);
			expect(details.diagnostics[0].path).toContain("bad.py");
		},
		120_000,
	);

	it.skipIf(!has("go"))(
		"surfaces a go vet issue inside a module",
		async () => {
			writeFileSync(join(root, "go.mod"), "module example.com/diagtest\n\ngo 1.22\n");
			writeFileSync(
				join(root, "main.go"),
				'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Sprintf("%d", "not-a-number")\n}\n',
			);
			const { details } = await runTool(root, { language: "go" });
			expect(details.diagnostics.length).toBeGreaterThan(0);
			expect(details.diagnostics[0].path).toContain("main.go");
		},
		120_000,
	);

	it.skipIf(!has("cargo"))(
		"surfaces a rust error via cargo check",
		async () => {
			mkdirSync(join(root, "src"));
			writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "diagtest"\nversion = "0.1.0"\nedition = "2021"\n');
			writeFileSync(join(root, "src", "lib.rs"), 'pub fn f() -> i32 { "nope" }\n');
			const { details } = await runTool(root, { language: "rust" });
			expect(details.diagnostics.length).toBeGreaterThan(0);
		},
		180_000,
	);

	it("auto-detects language from the path extension", async () => {
		const tool = createDiagnosticsToolDefinition(root);
		expect(tool.name).toBe("diagnostics");
		// .rs path routes to rust, which skips without Cargo.toml
		const result = await tool.execute("tc-2", { path: "src/lib.rs" } as never, undefined, undefined, {} as never);
		const details = result.details as DiagnosticsToolDetails;
		expect(details.skipped).toEqual([{ language: "rust", reason: "no Cargo.toml found" }]);
	});
});
