import { describe, expect, it } from "bun:test";
import { installProfileAlias, readProfileAliasConfigFile } from "../src/cli/profile-alias";

describe("profile alias installer", () => {
	it("writes a bash-compatible alias that forwards subcommands through omp", async () => {
		const files = new Map<string, string>();

		const result = await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/bash",
			platform: "linux",
			homeDir: "/home/me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		expect(result.configPath).toBe("/home/me/.bashrc");
		expect(files.get("/home/me/.bashrc")).toContain("alias omp-work='command omp --profile work'");
	});

	it("writes a fish function that forwards argv", async () => {
		const files = new Map<string, string>();

		await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/opt/homebrew/bin/fish",
			platform: "darwin",
			homeDir: "/Users/me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		const content = files.get("/Users/me/.config/fish/conf.d/omp-profiles.fish") ?? "";
		expect(content).toContain("function omp-work --wraps omp");
		expect(content).toContain("command omp --profile work $argv");
	});

	it("writes a PowerShell function because aliases cannot carry arguments", async () => {
		const files = new Map<string, string>();

		await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "pwsh.exe",
			platform: "win32",
			homeDir: "C:\\Users\\me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		const content = files.get("C:\\Users\\me/Documents/PowerShell/Microsoft.PowerShell_profile.ps1") ?? "";
		expect(content).toContain("function omp-work");
		expect(content).toContain("& omp --profile work @args");
	});

	it("replaces a previous block for the same alias", async () => {
		const files = new Map<string, string>([
			[
				"/home/me/.zshrc",
				[
					"before",
					"# >>> omp profile alias: omp-work >>>",
					"alias omp-work='command omp --profile old'",
					"# <<< omp profile alias: omp-work <<<",
					"after",
				].join("\n"),
			],
		]);

		await installProfileAlias({
			profile: "work",
			aliasName: "omp-work",
			shellPath: "/bin/zsh",
			platform: "darwin",
			homeDir: "/home/me",
			readFile: async filePath => files.get(filePath) ?? "",
			writeFile: async (filePath, content) => {
				files.set(filePath, content);
			},
		});

		const content = files.get("/home/me/.zshrc") ?? "";
		expect(content).toContain("before");
		expect(content).toContain("after");
		expect(content).toContain("alias omp-work='command omp --profile work'");
		expect(content).not.toContain("--profile old");
	});

	it("refuses to shadow the base omp command case-insensitively", async () => {
		for (const aliasName of ["omp", "OMP"]) {
			await expect(
				installProfileAlias({
					profile: "work",
					aliasName,
					shellPath: "/bin/bash",
					homeDir: "/home/me",
				}),
			).rejects.toThrow("Refusing to shadow");
		}
	});

	it("rejects POSIX sh because it does not read bash config files", async () => {
		await expect(
			installProfileAlias({
				profile: "work",
				aliasName: "omp-work",
				shellPath: "/bin/sh",
				platform: "linux",
				homeDir: "/home/me",
			}),
		).rejects.toThrow('Unsupported shell "sh"');
	});

	it("treats missing shell config as empty but preserves other read failures", async () => {
		await expect(
			readProfileAliasConfigFile("/home/me/.bashrc", async () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			}),
		).resolves.toBe("");

		await expect(
			readProfileAliasConfigFile("/home/me/.bashrc", async () => {
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			}),
		).rejects.toThrow("denied");
	});

	it("validates profile names before rendering shell code", async () => {
		const files = new Map<string, string>();

		await expect(
			installProfileAlias({
				profile: "work'; touch /tmp/pwn; #",
				aliasName: "omp-work",
				shellPath: "/bin/bash",
				platform: "linux",
				homeDir: "/home/me",
				readFile: async filePath => files.get(filePath) ?? "",
				writeFile: async (filePath, content) => {
					files.set(filePath, content);
				},
			}),
		).rejects.toThrow("Invalid OMP profile");
		expect(files.size).toBe(0);
	});
});
