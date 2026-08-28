import { describe, expect, it } from "vitest";
import { runAdaptOrchDoctorCli } from "../src/commands/adaptorch-doctor-cli.ts";

/**
 * `omk doctor adaptorch` is the onboarding check: set a key, run one command,
 * find out whether the hosted API answers. The exit code carries the verdict so
 * a script can branch on it, and the credential must never reach the output.
 */

const SECRET = "ado_live_super_secret_value";

function capture() {
	const lines: string[] = [];
	return { lines, writeLine: (line: string) => lines.push(line) };
}

const okFetch =
	(body: unknown, status = 200) =>
	async () => ({
		status,
		json: async () => body,
		text: async () => "",
	});

describe("omk doctor adaptorch: routing", () => {
	it("ignores every other command", async () => {
		for (const args of [[], ["doctor"], ["doctor", "resources"], ["session", "doctor"]]) {
			const result = await runAdaptOrchDoctorCli(args, {});
			expect(result.handled, JSON.stringify(args)).toBe(false);
		}
	});

	it("claims `doctor adaptorch`", async () => {
		const { writeLine } = capture();
		const result = await runAdaptOrchDoctorCli(["doctor", "adaptorch"], { env: {}, writeLine });
		expect(result.handled).toBe(true);
	});

	it("prints usage for --help without contacting anything", async () => {
		const { lines, writeLine } = capture();
		let called = false;
		const result = await runAdaptOrchDoctorCli(["doctor", "adaptorch", "--help"], {
			env: { ADAPTORCH_API_KEY: SECRET },
			writeLine,
			fetch: async () => {
				called = true;
				return { status: 200, json: async () => ({}), text: async () => "" };
			},
		});
		expect(result.exitCode).toBe(0);
		expect(called).toBe(false);
		expect(lines.join("\n")).toContain("Usage:");
	});
});

describe("omk doctor adaptorch: not configured", () => {
	it("exits 1 and explains how to enable it", async () => {
		const { lines, writeLine } = capture();
		const result = await runAdaptOrchDoctorCli(["doctor", "adaptorch"], { env: {}, writeLine });

		expect(result.exitCode).toBe(1);
		const output = lines.join("\n");
		expect(output).toContain("ADAPTORCH_API_KEY");
		expect(output).toMatch(/not configured/i);
	});

	it("reports not-configured in JSON too", async () => {
		const { lines, writeLine } = capture();
		await runAdaptOrchDoctorCli(["doctor", "adaptorch", "--json"], { env: {}, writeLine });
		expect(JSON.parse(lines.join("\n"))).toMatchObject({ configured: false, reachable: false });
	});
});

describe("omk doctor adaptorch: verified", () => {
	const env = { ADAPTORCH_API_KEY: SECRET };

	it("exits 0 when the API answers", async () => {
		const { lines, writeLine } = capture();
		const result = await runAdaptOrchDoctorCli(["doctor", "adaptorch"], {
			env,
			writeLine,
			fetch: okFetch({ subject_id: "user_42", project_id: "proj_7" }),
		});

		expect(result.exitCode).toBe(0);
		expect(lines.join("\n")).toContain("user_42");
	});

	it("emits a stable JSON shape", async () => {
		const { lines, writeLine } = capture();
		await runAdaptOrchDoctorCli(["doctor", "adaptorch", "--json"], {
			env,
			writeLine,
			fetch: okFetch({ subject_id: "user_42" }),
		});

		expect(JSON.parse(lines.join("\n"))).toMatchObject({
			configured: true,
			reachable: true,
			subjectId: "user_42",
		});
	});

	it("never prints the credential, in either output mode", async () => {
		for (const argv of [
			["doctor", "adaptorch"],
			["doctor", "adaptorch", "--json"],
		]) {
			const { lines, writeLine } = capture();
			await runAdaptOrchDoctorCli(argv, { env, writeLine, fetch: okFetch({ subject_id: "u" }) });
			expect(lines.join("\n"), argv.join(" ")).not.toContain(SECRET);
		}
	});
});

describe("omk doctor adaptorch: failures", () => {
	const env = { ADAPTORCH_API_KEY: SECRET };

	it("exits 2 when the key is rejected, and says so", async () => {
		const { lines, writeLine } = capture();
		const result = await runAdaptOrchDoctorCli(["doctor", "adaptorch"], {
			env,
			writeLine,
			fetch: okFetch({ code: "unauthorized", message: "invalid key" }, 401),
		});

		expect(result.exitCode).toBe(2);
		expect(lines.join("\n")).toMatch(/401|unauthorized/i);
	});

	it("exits 2 when the transport fails, without leaking the credential", async () => {
		const { lines, writeLine } = capture();
		const result = await runAdaptOrchDoctorCli(["doctor", "adaptorch"], {
			env,
			writeLine,
			fetch: async () => {
				throw new Error(`getaddrinfo ENOTFOUND for key ${SECRET}`);
			},
		});

		expect(result.exitCode).toBe(2);
		expect(lines.join("\n")).not.toContain(SECRET);
	});

	it("exits 2 when the configured URL is unsafe rather than downgrading", async () => {
		const { lines, writeLine } = capture();
		const result = await runAdaptOrchDoctorCli(["doctor", "adaptorch"], {
			env: { ...env, ADAPTORCH_API_URL: "http://api.adaptorch.com" },
			writeLine,
			fetch: okFetch({ subject_id: "u" }),
		});

		expect(result.exitCode).toBe(2);
		expect(lines.join("\n")).toMatch(/https/i);
	});
});
