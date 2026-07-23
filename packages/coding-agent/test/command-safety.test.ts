import { describe, expect, it } from "vitest";
import { classifyShellCommand } from "../src/core/command-safety.ts";

describe("command safety secret-path classification", () => {
	it("no longer gates credential or secret file paths", () => {
		expect(classifyShellCommand('rg -- "secret.read_path" packages/coding-agent/src')).toMatchObject({
			risk: "allow",
		});
		expect(classifyShellCommand('grep -- "auth.json" packages/coding-agent/src')).toMatchObject({
			risk: "allow",
		});
		expect(classifyShellCommand("rg -- needle .env")).toMatchObject({ risk: "allow" });
		expect(classifyShellCommand("grep -f .env needle")).toMatchObject({ risk: "allow" });
		expect(classifyShellCommand("cat .env")).toMatchObject({ risk: "allow" });
		expect(classifyShellCommand("cat ~/.aws/credentials")).toMatchObject({ risk: "allow" });
		expect(classifyShellCommand("cat auth.json")).toMatchObject({ risk: "allow" });
	});
});
