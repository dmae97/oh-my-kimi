import { describe, expect, it } from "vitest";
import { classifyShellCommand, extractCommandSubstitutions } from "../src/core/command-safety.ts";

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

describe("command safety command-substitution scanning", () => {
	it("blocks destructive commands smuggled through $() substitution", () => {
		expect(classifyShellCommand("echo $(rm -rf ~)")).toMatchObject({ risk: "block", rule: "fs.rm_rf_home" });
		expect(classifyShellCommand('echo "$(rm -rf /)"')).toMatchObject({ risk: "block", rule: "fs.rm_rf_root" });
		expect(classifyShellCommand("ls $(rm -rf ./)")).toMatchObject({ risk: "confirm", rule: "fs.rm_rf_cwd" });
	});

	it("blocks destructive commands smuggled through backtick substitution", () => {
		expect(classifyShellCommand("echo `rm -rf ~`")).toMatchObject({ risk: "block", rule: "fs.rm_rf_home" });
	});

	it("blocks destructive and privileged bodies in process substitution", () => {
		expect(classifyShellCommand("cat <(rm -rf ~)")).toMatchObject({ risk: "block", rule: "fs.rm_rf_home" });
		expect(classifyShellCommand("cat >(sudo dd if=/dev/zero of=/dev/sda)")).toMatchObject({
			risk: "block",
			rule: "fs.dd_block_device",
		});
	});

	it("escapes the safety floor through split segments inside substitution", () => {
		expect(classifyShellCommand("for f in $(ls; rm -rf /); do echo $f; done")).toMatchObject({
			risk: "block",
			rule: "fs.rm_rf_root",
		});
	});

	it("escalates to the highest risk when outer command is merely confirm-tier", () => {
		expect(classifyShellCommand("git stash $(mkfs.ext4 /dev/sda)")).toMatchObject({
			risk: "block",
			rule: "fs.mkfs",
		});
	});

	it("keeps safe substitutions at allow tier", () => {
		expect(classifyShellCommand("git log $(git rev-parse HEAD)")).toMatchObject({ risk: "allow" });
		expect(classifyShellCommand('cd $(dirname "$0")')).toMatchObject({ risk: "allow" });
		expect(classifyShellCommand("echo $(date +%Y)")).toMatchObject({ risk: "allow" });
	});

	it("does not scan single-quoted bodies because bash does not expand them", () => {
		expect(classifyShellCommand("echo '$(rm -rf /)'")).toMatchObject({ risk: "allow" });
		expect(classifyShellCommand("echo '`rm -rf /`'")).toMatchObject({ risk: "allow" });
	});

	it("extracts nested substitution bodies", () => {
		expect(extractCommandSubstitutions("echo $(x `y` z)")).toEqual(["x `y` z", "y"]);
	});

	it("handles unmatched delimiters without crashing", () => {
		expect(extractCommandSubstitutions("echo $(oops")).toEqual([]);
		expect(extractCommandSubstitutions("echo `oops")).toEqual([]);
		expect(classifyShellCommand("echo $(oops")).toMatchObject({ risk: "allow" });
	});
});
