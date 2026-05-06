import { describe, expect, it } from "bun:test";
import { filterEnv } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";

describe("Python gateway environment filtering", () => {
	it("filters sensitive and unknown variables from shell env", () => {
		const env: Record<string, string | undefined> = {
			PATH: "/bin",
			HOME: "/home/test",
			OPENAI_API_KEY: "secret",
			ANTHROPIC_API_KEY: "also-secret",
			UNSAFE_TOKEN: "nope",
			PI_CUSTOM: "1",
			LC_ALL: "en_US.UTF-8",
			LD_LIBRARY_PATH: "/opt/conda/lib",
		};

		const filtered = filterEnv(env);

		expect(filtered.PATH).toBe("/bin");
		expect(filtered.HOME).toBe("/home/test");
		expect(filtered.PI_CUSTOM).toBe("1");
		expect(filtered.LC_ALL).toBe("en_US.UTF-8");
		expect(filtered.LD_LIBRARY_PATH).toBe("/opt/conda/lib");
		expect(filtered.OPENAI_API_KEY).toBeUndefined();
		expect(filtered.ANTHROPIC_API_KEY).toBeUndefined();
		expect(filtered.UNSAFE_TOKEN).toBeUndefined();
	});

	it("preserves XDG and LC prefixed variables", () => {
		const env: Record<string, string | undefined> = {
			XDG_CONFIG_HOME: "/home/test/.config",
			XDG_RUNTIME_DIR: "/run/user/1000",
			LC_CTYPE: "UTF-8",
			LC_MESSAGES: "en_US.UTF-8",
		};

		const filtered = filterEnv(env);

		expect(filtered.XDG_CONFIG_HOME).toBe("/home/test/.config");
		expect(filtered.XDG_RUNTIME_DIR).toBe("/run/user/1000");
		expect(filtered.LC_CTYPE).toBe("UTF-8");
		expect(filtered.LC_MESSAGES).toBe("en_US.UTF-8");
	});

	it("passes filtered env through to resolved runtime", () => {
		const env: Record<string, string | undefined> = {
			PATH: "/usr/bin",
			HOME: "/home/test",
			OPENAI_API_KEY: "secret",
			PI_DEBUG: "1",
		};

		const filtered = filterEnv(env);
		expect(filtered.OPENAI_API_KEY).toBeUndefined();
		expect(filtered.PATH).toBe("/usr/bin");
		expect(filtered.PI_DEBUG).toBe("1");
	});
});
