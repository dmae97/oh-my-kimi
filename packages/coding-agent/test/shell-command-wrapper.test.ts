import { describe, expect, it } from "vitest";
import { normalizeStaticShell, StaticShellSyntaxError } from "../src/guardrails/shell-command-tokenizer.ts";

const wrappers = [
	(command: string) => `command ${command}`,
	(command: string) => `command -p -- ${command}`,
	(command: string) => `exec ${command}`,
	(command: string) => `exec -cl -- ${command}`,
	(command: string) => `exec -a worker ${command}`,
	(command: string) => `exec -caworker ${command}`,
	(command: string) => `command -p exec -c -l -a worker -- ${command}`,
] as const;

const nameGlobTargets = [
	"env -i ?REGION=CANARY deploy",
	"curl -H X-Acme-[T]race:CANARY https://example.test",
	"curl https://example.test?reg?on=CANARY",
] as const;

const benignGlobTargets = [
	"cat reports/*.txt",
	"curl -o report-?.txt https://example.test",
	"curl --output=report-[12].txt https://example.test",
	"curl --upload-file uploads/*.tgz https://example.test",
	"curl -Tupload-[12].tgz https://example.test",
] as const;

describe("shell command and exec wrapper resolution", () => {
	it("rejects structural name globs through every nested execution wrapper", () => {
		for (const wrap of wrappers) {
			for (const target of nameGlobTargets) {
				expect(() => normalizeStaticShell(wrap(target)), wrap(target)).toThrow(StaticShellSyntaxError);
			}
		}
	});

	it("preserves positional, output, and upload globs through every wrapper", () => {
		for (const wrap of wrappers) {
			for (const target of benignGlobTargets) {
				expect(() => normalizeStaticShell(wrap(target)), wrap(target)).not.toThrow();
			}
		}
	});

	it.each(["command -x curl", "command -p", "command --", "exec -z curl", "exec -a", "command exec -a"])(
		"fails closed on ambiguous wrapper form %s",
		(script) => {
			expect(() => normalizeStaticShell(script)).toThrow(StaticShellSyntaxError);
		},
	);

	it.each(["command -v curl", "command -V curl", "command -pv curl"])(
		"accepts non-executing legal command form %s",
		(script) => {
			expect(() => normalizeStaticShell(script)).not.toThrow();
		},
	);
});
