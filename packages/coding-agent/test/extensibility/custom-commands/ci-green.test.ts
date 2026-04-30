import { afterEach, describe, expect, it, vi } from "bun:test";
import * as typebox from "@sinclair/typebox";
import { GreenCommand } from "../../../src/extensibility/custom-commands/bundled/ci-green";
import type { CustomCommandAPI } from "../../../src/extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../src/extensibility/hooks/types";
import * as piCodingAgent from "../../../src/index";
import * as git from "../../../src/utils/git";

afterEach(() => {
	vi.restoreAllMocks();
});

function createApi(): CustomCommandAPI {
	return {
		cwd: "/tmp/test",
		exec: async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		}),
		typebox,
		pi: piCodingAgent,
	};
}

describe("GreenCommand", () => {
	it("exposes the /green command name", () => {
		const command = new GreenCommand(createApi());

		expect(command.name).toBe("green");
	});

	it("includes tag instructions when HEAD has a tag", async () => {
		vi.spyOn(git.ref, "tags").mockResolvedValue(["v0.1.0-alpha2"]);
		const command = new GreenCommand(createApi());

		const result = await command.execute([], {} as HookCommandContext);

		expect(result).toContain("Keep going until the current branch CI is green.");
		expect(result).toContain(
			"Prefer the `github` tool with `op: run_watch` and no other arguments if that tool is available.",
		);
		expect(result).toContain(
			"Use the workflow runs for the current HEAD commit as the source of truth after each push.",
		);
		expect(result).toContain("ensure the final commit is tagged `v0.1.0-alpha2` and push that tag");
		expect(result).not.toContain("timeouts due to the harnesses");
	});

	it("omits tag instructions when HEAD is not tagged", async () => {
		vi.spyOn(git.ref, "tags").mockResolvedValue([]);
		const command = new GreenCommand(createApi());

		const result = await command.execute([], {} as HookCommandContext);

		expect(result).toContain("Do not stop after a single fix attempt.");
		expect(result).toContain("Watch the workflow runs for the current HEAD commit.");
		expect(result).not.toContain("ensure the final commit is tagged");
	});
});
