import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetPreludeDocsCache, warmPythonEnvironment } from "@oh-my-pi/pi-coding-agent/ipy/executor";
import { getPythonToolDescription, PythonTool } from "@oh-my-pi/pi-coding-agent/tools/python";
import { $which, getProjectDir } from "@oh-my-pi/pi-utils";

const resolvePythonPath = (): string | null => {
	const venvPath = Bun.env.VIRTUAL_ENV;
	const candidates = [venvPath, path.join(getProjectDir(), ".venv"), path.join(getProjectDir(), "venv")].filter(
		Boolean,
	) as string[];
	for (const candidate of candidates) {
		const binDir = process.platform === "win32" ? "Scripts" : "bin";
		const exeName = process.platform === "win32" ? "python.exe" : "python";
		const pythonCandidate = path.join(candidate, binDir, exeName);
		if (fs.existsSync(pythonCandidate)) {
			return pythonCandidate;
		}
	}
	return $which("python") ?? $which("python3");
};

const pythonPath = resolvePythonPath();
const hasKernelDeps = (() => {
	if (!pythonPath) return false;
	const result = Bun.spawnSync(
		[
			pythonPath,
			"-c",
			"import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('kernel_gateway') and importlib.util.find_spec('ipykernel') else 1)",
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	return result.exitCode === 0;
})();

const shouldRun = Boolean(pythonPath) && hasKernelDeps;

describe.skipIf(!shouldRun)("PYTHON_PRELUDE integration", () => {
	it("exposes prelude helpers via python tool", async () => {
		const helpers = ["env", "read", "write", "append", "rm", "mv", "cp", "find", "grep"];

		const session = {
			cwd: getProjectDir(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({
				"lsp.diagnosticsOnWrite": false,
				"python.toolMode": "ipy-only",
				"python.kernelMode": "per-call",
				"python.sharedGateway": true,
			}),
		};

		resetPreludeDocsCache();
		const tool = new PythonTool(session);
		const code = `
	helpers = ${JSON.stringify(helpers)}
	missing = [name for name in helpers if name not in globals() or not callable(globals()[name])]
	docs = __omp_prelude_docs__()
	doc_names = [d.get("name") for d in docs]
	doc_categories = [d.get("category") for d in docs]
	print("HELPERS_OK=" + ("1" if not missing else "0"))
	print("DOCS_OK=" + ("1" if "read" in doc_names and "File I/O" in doc_categories else "0"))
	if missing:
		print("MISSING=" + ",".join(missing))
	`;

		const result = await tool.execute("tool-call-1", { cells: [{ title: "prelude helpers", code }] });
		const output = result.content.find(item => item.type === "text")?.text ?? "";
		expect(output).toContain("HELPERS_OK=1");
		expect(output).toContain("DOCS_OK=1");
		expect(tool.description).toContain("read");
		expect(tool.description).not.toContain("Documentation unavailable");
	});

	it("exposes prelude docs via warmup", async () => {
		resetPreludeDocsCache();
		const result = await warmPythonEnvironment(getProjectDir());
		expect(result.ok).toBe(true);
		const names = result.docs.map(doc => doc.name);
		expect(names).toContain("read");
	});

	it("renders prelude docs in python tool description", async () => {
		resetPreludeDocsCache();
		const result = await warmPythonEnvironment(getProjectDir());
		expect(result.ok).toBe(true);
		const description = getPythonToolDescription();
		expect(description).toContain("read");
		expect(description).not.toContain("Documentation unavailable");
	});
});
