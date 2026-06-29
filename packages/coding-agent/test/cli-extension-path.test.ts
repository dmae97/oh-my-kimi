import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — Windows extension paths", () => {
	it("rejoins a module path split at spaces before parsing following flags", () => {
		const parsed = parseArgs([
			"--extension",
			"C:\\Users\\Shi",
			"Xin\\AppData\\Local\\ompcot\\extensions\\embedded-server.mjs",
			"--mode",
			"rpc",
		]);

		expect(parsed.extensions).toEqual([
			"C:\\Users\\Shi Xin\\AppData\\Local\\ompcot\\extensions\\embedded-server.mjs",
		]);
		expect(parsed.messages).toEqual([]);
		expect(parsed.mode).toBe("rpc");
	});
});
