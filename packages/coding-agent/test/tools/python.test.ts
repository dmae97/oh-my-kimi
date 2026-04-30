import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/ipy/executor";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { PythonTool } from "@oh-my-pi/pi-coding-agent/tools/python";
import { TempDir } from "@oh-my-pi/pi-utils";

let previousSkipCheck: string | undefined;
let tempDir: TempDir;
beforeAll(() => {
	tempDir = TempDir.createSync("@omp-python-test-");
	previousSkipCheck = Bun.env.PI_PYTHON_SKIP_CHECK;
	Bun.env.PI_PYTHON_SKIP_CHECK = "1";
});

afterAll(() => {
	if (previousSkipCheck === undefined) {
		delete Bun.env.PI_PYTHON_SKIP_CHECK;
		return;
	}
	Bun.env.PI_PYTHON_SKIP_CHECK = previousSkipCheck;
	tempDir.removeSync();
});

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function createSettings(toolMode: "ipy-only" | "bash-only" | "both"): Settings {
	return Settings.isolated({
		"lsp.formatOnWrite": true,
		"bashInterceptor.enabled": true,
		"python.toolMode": toolMode,
	});
}

describe("python tool schema", () => {
	it("exposes expected parameters", () => {
		const tool = new PythonTool(createSession());
		const schema = tool.parameters as {
			type: string;
			properties: Record<string, { type: string; description?: string }>;
			required?: string[];
		};

		expect(schema.type).toBe("object");
		expect(schema.properties.cells.type).toBe("array");
		expect(schema.properties.timeout.type).toBe("number");
		expect(schema.properties.reset.type).toBe("boolean");
		expect(schema.required).toEqual(["cells"]);
	});
});

describe("python tool docs template", () => {
	it("renders dynamic helper docs", () => {
		const docs = [
			{
				name: "read",
				signature: "(path)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const spy = vi.spyOn(pythonExecutor, "getPreludeDocs").mockReturnValue(docs);

		const tool = new PythonTool(createSession());

		expect(tool.description).toContain("### File I/O");
		expect(tool.description).toContain("read(path)");
		expect(tool.description).toContain("Read file contents.");

		spy.mockRestore();
	});

	it("renders fallback when docs are unavailable", () => {
		const spy = vi.spyOn(pythonExecutor, "getPreludeDocs").mockReturnValue([]);

		const tool = new PythonTool(createSession());

		expect(tool.description).not.toContain("<prelude>");

		spy.mockRestore();
	});
});

describe("python tool exposure", () => {
	it("includes python only in ipy-only mode", async () => {
		const session = createSession({ settings: createSettings("ipy-only") });
		const tools = await createTools(session);
		const names = tools.map(tool => tool.name);
		expect(names).toContain("python");
		expect(names).not.toContain("bash");
	});

	it("includes bash only in bash-only mode", async () => {
		const session = createSession({ settings: createSettings("bash-only") });
		const tools = await createTools(session);
		const names = tools.map(tool => tool.name);
		expect(names).toContain("bash");
		expect(names).not.toContain("python");
	});

	it("includes bash and python in both mode", async () => {
		const session = createSession({ settings: createSettings("both") });
		const tools = await createTools(session);
		const names = tools.map(tool => tool.name);
		expect(names).toContain("bash");
		expect(names).toContain("python");
	});
});
