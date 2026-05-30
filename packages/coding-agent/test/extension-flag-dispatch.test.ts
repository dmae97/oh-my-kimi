import { describe, expect, it } from "bun:test";
import { applyExtensionFlagValues } from "../src/main";

class FakeExtensionRunner {
	#values = new Map<string, boolean | string>();

	getFlags(): ReadonlyMap<string, { type: "boolean" | "string" }> {
		return new Map<string, { type: "boolean" | "string" }>([
			["foo", { type: "boolean" }],
			["bar", { type: "string" }],
		]);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.#values);
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.#values.set(name, value);
	}
}

describe("extension flag dispatch", () => {
	it("stops scanning raw argv at the end-of-options marker", () => {
		const extensionRunner = new FakeExtensionRunner();

		const values = applyExtensionFlagValues({ extensionRunner }, ["--", "--foo", "bar"]);

		expect(values.size).toBe(0);
	});

	it("still allows -- to be the value of a string extension flag", () => {
		const extensionRunner = new FakeExtensionRunner();

		const values = applyExtensionFlagValues({ extensionRunner }, ["--bar", "--"]);

		expect(values.get("bar")).toBe("--");
		expect(values.size).toBe(1);
	});
});
