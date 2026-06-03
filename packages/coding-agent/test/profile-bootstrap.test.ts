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

	it("stops extracting global flags at a subcommand boundary", () => {
		// `omp grep --profile <path>` must reach the grep subcommand intact; the
		// bootstrap must not treat `--profile <path>` as a profile selection.
		const result = extractProfileFlags(["grep", "--profile", "packages/coding-agent/src/cli.ts"]);
		expect(result.profile).toBeUndefined();
		expect(result.argv).toEqual(["grep", "--profile", "packages/coding-agent/src/cli.ts"]);
	});

	it("extracts a global --profile that precedes a subcommand", () => {
		const result = extractProfileFlags(["--profile", "work", "grep", "foo"]);
		expect(result.profile).toBe("work");
		expect(result.argv).toEqual(["grep", "foo"]);
	});

	it("treats explicit launch as the default command and keeps extracting globals", () => {
		expect(extractProfileFlags(["launch", "--profile", "work", "--alias", "omp-work"])).toEqual({
			argv: ["launch"],
			profile: "work",
			aliasName: "omp-work",
		});
	});

	it("treats explicit acp as launch-shaped and keeps extracting globals", () => {
		expect(extractProfileFlags(["acp", "--profile", "work"])).toEqual({
			argv: ["acp"],
			profile: "work",
			aliasName: undefined,
		});
	});

	it("treats later subcommand-shaped words as launch text after explicit launch", () => {
		const result = extractProfileFlags(["launch", "grep", "--profile", "work"]);
		expect(result.profile).toBe("work");
		expect(result.argv).toEqual(["launch", "grep"]);
	});

	it("still extracts --profile after a non-subcommand positional (launch message)", () => {
		const result = extractProfileFlags(["hello", "--profile", "work"]);
		expect(result.profile).toBe("work");
		expect(result.argv).toEqual(["hello"]);
	});

	it("continues extracting launch profiles after later subcommand-shaped words", () => {
		const result = extractProfileFlags(["hello", "grep", "--profile", "work"]);
		expect(result.profile).toBe("work");
		expect(result.argv).toEqual(["hello", "grep"]);
	});

	it("continues extracting launch profiles after launch flags before subcommand-shaped words", () => {
		const result = extractProfileFlags(["--model", "opus", "grep", "--profile", "work"]);
		expect(result.profile).toBe("work");
		expect(result.argv).toEqual(["--model", "opus", "grep"]);
	});

	it("does not treat a --profile value that names a subcommand as a boundary", () => {
		const result = extractProfileFlags(["--profile", "config", "later"]);
		expect(result.profile).toBe("config");
		expect(result.argv).toEqual(["later"]);
	});

	it("exempts known value-less launch flags so a trailing profile still activates", () => {
		// Boolean launch flags (--print, --yolo, --no-tools, -p) take no value, so
		// the token after them is a fresh argument: `omp --print --profile work`
		// must still select the profile.
		expect(extractProfileFlags(["--print", "--profile", "work"])).toEqual({
			argv: ["--print"],
			profile: "work",
			aliasName: undefined,
		});
		expect(extractProfileFlags(["--yolo", "--profile", "work"])).toEqual({
			argv: ["--yolo"],
			profile: "work",
			aliasName: undefined,
		});
		expect(extractProfileFlags(["--no-tools", "--profile", "work"])).toEqual({
			argv: ["--no-tools"],
			profile: "work",
			aliasName: undefined,
		});
		expect(extractProfileFlags(["-p", "--profile", "work"])).toEqual({
			argv: ["-p"],
			profile: "work",
			aliasName: undefined,
		});
	});

	it("protects a value-like successor of an unknown (extension) string flag", () => {
		// The bootstrap runs before extensions load and cannot know that `--bar`
		// is a string flag consuming its next token. When the successor is
		// value-like (does not start with `-`), `parseArgs` consumes it as the
		// extension flag's value, so the bootstrap forwards it untouched and never
		// mis-reads it as a global flag — even when it spells a subcommand name.
		expect(extractProfileFlags(["--bar", "value", "--profile", "work"])).toEqual({
			argv: ["--bar", "value"],
			profile: "work",
			aliasName: undefined,
		});
		expect(extractProfileFlags(["--bar", "config"])).toEqual({
			argv: ["--bar", "config"],
			profile: undefined,
			aliasName: undefined,
		});
	});

	it("does not hide a global --profile/--alias behind an unknown flag with a flag-looking successor (regression: PR #1435 review)", () => {
		// `parseArgs` never hands a flag-looking successor to an extension flag:
		// boolean extension flags consume nothing, and string extension flags only
		// consume value-like (non-`-`) successors. So `omp --some-ext-flag --profile
		// work` must still select profile `work`; the prior bootstrap forwarded
		// `--profile` as a protected successor and silently fell back to default.
		expect(extractProfileFlags(["--some-ext-flag", "--profile", "work"])).toEqual({
			argv: ["--some-ext-flag"],
			profile: "work",
			aliasName: undefined,
		});
		expect(extractProfileFlags(["--some-ext-flag", "--alias", "omp-work"])).toEqual({
			argv: ["--some-ext-flag"],
			profile: undefined,
			aliasName: "omp-work",
		});
	});

	it("treats a `--` successor of an unknown flag as end-of-options, not a protected value", () => {
		// `--` is ambiguous under the parser (a string extension flag consumes it,
		// a boolean one does not), so the bootstrap keeps `--` a single consistent
		// meaning: end-of-options. Everything after is forwarded verbatim and no
		// profile is extracted, so a `--profile` fenced behind `--` never silently
		// activates.
		expect(extractProfileFlags(["--some-ext-flag", "--", "--profile", "work"])).toEqual({
			argv: ["--some-ext-flag", "--", "--profile", "work"],
			profile: undefined,
			aliasName: undefined,
		});
	});

	it("still extracts a trailing profile after an unknown flag that carries its own =value", () => {
		// `--bar=x` carries its value inline, so the following token is a fresh
		// argument and the trailing --profile is a genuine global flag.
		expect(extractProfileFlags(["--bar=x", "--profile", "work"])).toEqual({
			argv: ["--bar=x"],
			profile: "work",
			aliasName: undefined,
		});
	});
});
