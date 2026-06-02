import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Contract: subagent output ids are the requested name, used verbatim the first
// time and suffixed (`-2`, `-3`, …) only when the same name recurs. A parent
// prefix nests ids under it. On resume the manager scans existing `.md` outputs
// so it never reuses a name that would clobber a previously written output.

describe("AgentOutputManager", () => {
	it("uses the requested name verbatim and suffixes only on repeat", async () => {
		const mgr = new AgentOutputManager(() => null);

		expect(await mgr.allocate("Anna")).toBe("Anna");
		expect(await mgr.allocate("Anna")).toBe("Anna-2");
		expect(await mgr.allocate("Anna")).toBe("Anna-3");
		// A distinct name is untouched — no prefix, no suffix.
		expect(await mgr.allocate("Bob")).toBe("Bob");
	});

	it("de-duplicates within a batch while preserving order", async () => {
		const mgr = new AgentOutputManager(() => null);

		expect(await mgr.allocateBatch(["Auth", "Auth", "Api", "Auth"])).toEqual(["Auth", "Auth-2", "Api", "Auth-3"]);
	});

	it("nests ids under a parent prefix and still suffixes repeats", async () => {
		const mgr = new AgentOutputManager(() => null, { parentPrefix: "Anna" });

		expect(await mgr.allocate("Bob")).toBe("Anna.Bob");
		expect(await mgr.allocate("Bob")).toBe("Anna.Bob-2");
		expect(await mgr.allocate("Carol")).toBe("Anna.Carol");
	});

	it("scans existing output files so a resume never clobbers prior outputs", async () => {
		using tmp = TempDir.createSync("@omp-output-manager-");
		const dir = tmp.path();
		await Bun.write(path.join(dir, "Anna.md"), "prior");
		await Bun.write(path.join(dir, "Anna-2.md"), "prior");
		// Unrelated tool artifacts (numeric `.log` ids) must not be mistaken for names.
		await Bun.write(path.join(dir, "7.bash.log"), "noise");

		const mgr = new AgentOutputManager(() => dir);

		expect(await mgr.allocate("Anna")).toBe("Anna-3");
		// A name with no file on disk is still pristine.
		expect(await mgr.allocate("Bob")).toBe("Bob");
	});

	it("only counts files within its own prefix scope on resume", async () => {
		using tmp = TempDir.createSync("@omp-output-manager-");
		const dir = tmp.path();
		await Bun.write(path.join(dir, "Anna.Bob.md"), "child");
		await Bun.write(path.join(dir, "Anna.Bob.Carol.md"), "grandchild");
		// A different parent's child must be ignored by Anna's manager.
		await Bun.write(path.join(dir, "Other.Bob.md"), "elsewhere");

		const mgr = new AgentOutputManager(() => dir, { parentPrefix: "Anna" });

		expect(await mgr.allocate("Bob")).toBe("Anna.Bob-2");
		expect(await mgr.allocate("Dave")).toBe("Anna.Dave");
	});
});
