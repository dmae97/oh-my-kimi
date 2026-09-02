import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decidePowerShellCommand, type PowerShellHost } from "./translate.ts";

const PWSH7: PowerShellHost = { major: 7 };
const WINPS51: PowerShellHost = { major: 5 };

const decide = (command: string, host: PowerShellHost = PWSH7) => decidePowerShellCommand(command, host);

describe("constructs PowerShell actually supports are not refused", () => {
	// Each verified by running it under real pwsh 7. An over-broad refusal is a
	// real cost: it blocks a command that would have worked.
	it("allows 2>&1, which PowerShell supports natively", () => {
		assert.equal(decide("node --version 2>&1").kind, "passthrough");
	});

	it("allows a plain pipeline", () => {
		assert.equal(decide("git log --oneline | Select-Object -First 5").kind, "passthrough");
	});
});

describe("external programs run unchanged", () => {
	// This is the whole value of the layer: most of what a coding agent runs is
	// an external program that behaves identically under either shell.
	for (const command of [
		"git status",
		"git commit -m 'fix: thing'",
		"npm test",
		"npm run build -- --watch",
		"node scripts/build.mjs",
		"python -m pytest tests/",
		"cargo build --release",
		"docker ps -a",
	]) {
		it(`passes through: ${command}`, () => {
			assert.deepEqual(decide(command), { kind: "passthrough", command });
		});
	}
});

describe("exact rewrites", () => {
	const cases: readonly (readonly [string, string])[] = [
		["pwd", "Get-Location"],
		["ls", "Get-ChildItem"],
		["ls -la", "Get-ChildItem -Force"],
		["ls -l", "Get-ChildItem -Force"],
		["cat package.json", "Get-Content -LiteralPath package.json"],
		["which node", "Get-Command node"],
		["env", "Get-ChildItem Env:"],
	];

	for (const [input, expected] of cases) {
		it(`${input} -> ${expected}`, () => {
			const result = decide(input);
			assert.equal(result.kind, "rewrite");
			assert.equal(result.kind === "rewrite" && result.command, expected);
		});
	}
});

describe("refuses rather than guessing", () => {
	it("never rewrites a destructive builtin", () => {
		// A wrong `rm -rf` is unrecoverable, and the agent cannot distinguish a
		// mistranslation from a real result.
		for (const command of ["rm -rf build", "rm file.txt", "mv a b", "cp -r src dst", "chmod +x run.sh", "dd if=/dev/zero of=x"]) {
			const result = decide(command);
			assert.equal(result.kind, "refuse", `${command} must be refused, got ${result.kind}`);
		}
	});

	it("refuses POSIX-only process and filesystem tools", () => {
		for (const command of ["sudo apt install x", "ps aux", "df -h", "systemctl restart nginx", "kill -9 123"]) {
			assert.equal(decide(command).kind, "refuse", command);
		}
	});

	it("refuses builtins whose PowerShell alias takes different flags", () => {
		// `grep` and `sed` are not PowerShell commands, and `echo`/`sort`/`tee`
		// are aliases that reject POSIX flags — passing them through produces a
		// confusing failure at best.
		for (const command of ["grep -rn TODO src/", "sed -i 's/a/b/' f.txt", "find . -name '*.ts'", "echo -n hi", "sort -u list.txt"]) {
			assert.equal(decide(command).kind, "refuse", command);
		}
	});

	it("names the offending construct in the reason", () => {
		const result = decide("rm -rf build");
		assert.equal(result.kind, "refuse");
		assert.match(result.kind === "refuse" ? result.reason : "", /rm/);
	});
});

describe("POSIX-only syntax", () => {
	const cases: readonly (readonly [string, RegExp])[] = [
		["cat <<EOF\nhi\nEOF", /heredoc/],
		["echo $(date)", /substitution/],
		["echo `date`", /backtick/],
		["export FOO=bar", /export/],
		["FOO=bar node script.js", /prefix assignment/],
	];

	for (const [command, reason] of cases) {
		it(`refuses ${JSON.stringify(command.slice(0, 24))}`, () => {
			const result = decide(command);
			assert.equal(result.kind, "refuse", command);
			assert.match(result.kind === "refuse" ? result.reason : "", reason);
		});
	}
});

describe("pipeline chain operators depend on the host version", () => {
	it("accepts && on PowerShell 7+", () => {
		assert.equal(decide("npm ci && npm test", PWSH7).kind, "passthrough");
	});

	it("refuses && on Windows PowerShell 5.1, where it is a parse error", () => {
		const result = decide("npm ci && npm test", WINPS51);
		assert.equal(result.kind, "refuse");
		assert.match(result.kind === "refuse" ? result.reason : "", /PowerShell 7\+/);
	});

	it("refuses || on 5.1 as well", () => {
		assert.equal(decide("npm test || echo failed", WINPS51).kind, "refuse");
	});
});

describe("safety property", () => {
	it("no command containing a destructive builtin is ever passed through", () => {
		// Property, not examples: whatever the decision table grows into, a
		// destructive verb must never reach the host unexamined.
		const destructive = ["rm", "mv", "cp", "chmod", "chown", "dd"];
		const shapes = ["%s x", "%s -r x", "%s -rf /tmp/x", "%s --force x y"];
		const leaked: string[] = [];

		for (const verb of destructive) {
			for (const shape of shapes) {
				const command = shape.replace("%s", verb);
				for (const host of [PWSH7, WINPS51]) {
					if (decide(command, host).kind === "passthrough") leaked.push(command);
				}
			}
		}

		assert.deepEqual(leaked, []);
	});

	it("rejects an empty command", () => {
		assert.equal(decide("").kind, "refuse");
		assert.equal(decide("   ").kind, "refuse");
	});

	it("is deterministic", () => {
		for (const command of ["git status", "rm -rf x", "pwd", "grep x y"]) {
			assert.deepEqual(decide(command), decide(command));
		}
	});
});
