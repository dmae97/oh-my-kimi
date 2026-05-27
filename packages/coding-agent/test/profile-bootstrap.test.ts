import { describe, expect, it } from "bun:test";
import { extractProfileFlags } from "../src/cli/profile-bootstrap";

describe("extractProfileFlags", () => {
	it("extracts --profile without disturbing other tokens", () => {
		expect(extractProfileFlags(["--profile", "work"])).toEqual({
			argv: [],
			profile: "work",
			aliasName: undefined,
		});
		expect(extractProfileFlags(["foo", "--profile=work", "bar"])).toEqual({
			argv: ["foo", "bar"],
			profile: "work",
			aliasName: undefined,
		});
	});

	it("does not eat the value of known string-valued flags", () => {
		// `omp --system-prompt --profile foo` must pass the literal `--profile`
		// through to the launch parser (it's the system prompt) and `foo` is the
		// positional message. The previous implementation would silently activate
		// profile `foo` here, dropping the user's prompt.
		const result = extractProfileFlags(["--system-prompt", "--profile", "foo", "bar"]);
		expect(result.profile).toBeUndefined();
		expect(result.argv).toEqual(["--system-prompt", "--profile", "foo", "bar"]);
	});
	it("does not eat the value of --approval-mode (regression: PR #1435 review)", () => {
		// `--approval-mode` is a string-valued flag in args.ts (`args[++i]` with
		// no `-` check). The pre-parser must mirror that contract or
		// `omp --approval-mode --profile foo` silently activates profile `foo`
		// instead of letting the launch parser surface the invalid mode value.
		const result = extractProfileFlags(["--approval-mode", "--profile", "foo", "bar"]);
		expect(result.profile).toBeUndefined();
		expect(result.argv).toEqual(["--approval-mode", "--profile", "foo", "bar"]);
	});

	it("still extracts --profile after an unrelated string-valued flag", () => {
		// Mirror image: when the user does mean to activate a profile *after*
		// a string-valued flag, we must skip past the flag's value but still
		// pick up the trailing `--profile`.
		const result = extractProfileFlags(["--system-prompt", "hello", "--profile", "work"]);
		expect(result.profile).toBe("work");
		expect(result.argv).toEqual(["--system-prompt", "hello"]);
	});

	it("treats optional-value flags as consuming the next token only when it doesn't look like a flag", () => {
		// `--resume <id>` consumes the id, `--resume` alone is a picker.
		const consumed = extractProfileFlags(["--resume", "abc123", "--profile", "work"]);
		expect(consumed.argv).toEqual(["--resume", "abc123"]);
		expect(consumed.profile).toBe("work");

		const picker = extractProfileFlags(["--resume", "--profile", "work"]);
		expect(picker.argv).toEqual(["--resume"]);
		expect(picker.profile).toBe("work");

		// `--list-models` mirrors args.ts and does not consume `@`-prefixed
		// tokens (they're file args); the pre-pass releases them and the
		// trailing `--profile work` still activates.
		const filePrefixed = extractProfileFlags(["--list-models", "@models.txt", "--profile", "work"]);
		expect(filePrefixed.argv).toEqual(["--list-models", "@models.txt"]);
		expect(filePrefixed.profile).toBe("work");
	});

	it("does not consume empty-string resume values before a trailing profile", () => {
		// Shared OPTIONAL_FLAGS metadata drives the bootstrap too. Empty string is
		// "no value" for resume/session aliases, so the bootstrap must release it
		// and still activate the trailing --profile.
		const result = extractProfileFlags(["--resume", "", "--profile", "work"]);
		expect(result.argv).toEqual(["--resume", ""]);
		expect(result.profile).toBe("work");
	});

	it("honors `--` and stops scanning for flags", () => {
		const result = extractProfileFlags(["--", "--profile", "foo", "--alias", "bar"]);
		expect(result.profile).toBeUndefined();
		expect(result.aliasName).toBeUndefined();
		expect(result.argv).toEqual(["--", "--profile", "foo", "--alias", "bar"]);
	});

	it("rejects --profile without a value", () => {
		expect(() => extractProfileFlags(["--profile"])).toThrow("--profile requires a profile name");
		expect(() => extractProfileFlags(["--profile", "--version"])).toThrow("--profile requires a profile name");
		expect(() => extractProfileFlags(["--profile="])).toThrow("--profile requires a profile name");
	});

	it("rejects --alias without a value", () => {
		expect(() => extractProfileFlags(["--alias"])).toThrow("--alias requires a command name");
		expect(() => extractProfileFlags(["--alias", "--profile"])).toThrow("--alias requires a command name");
		expect(() => extractProfileFlags(["--alias="])).toThrow("--alias requires a command name");
	});
});
