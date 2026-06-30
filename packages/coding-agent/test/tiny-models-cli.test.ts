import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { resolveModels, runTinyModelsCommand } from "@oh-my-pi/pi-coding-agent/cli/tiny-models-cli";
import { TINY_LOCAL_MODELS } from "@oh-my-pi/pi-coding-agent/tiny/models";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tiny-models download model resolution", () => {
	it("excludes load-blocked models from `all` so the bulk prefetch stays green", () => {
		const unsupported = TINY_LOCAL_MODELS.filter(spec => "unsupportedReason" in spec && spec.unsupportedReason).map(
			spec => spec.key,
		);
		// Guard: keep this regression meaningful — at least one registry entry must be load-blocked.
		expect(unsupported.length).toBeGreaterThan(0);

		const all = resolveModels("all");
		for (const key of unsupported) expect(all).not.toContain(key);

		const usable = TINY_LOCAL_MODELS.filter(spec => !("unsupportedReason" in spec) || !spec.unsupportedReason).map(
			spec => spec.key,
		);
		for (const key of usable) expect(all).toContain(key);
	});

	it("still resolves an explicitly requested unsupported model (only `all` is filtered)", () => {
		const blocked = TINY_LOCAL_MODELS.find(spec => "unsupportedReason" in spec && spec.unsupportedReason);
		expect(blocked).toBeDefined();
		if (!blocked) return;
		expect(resolveModels(blocked.key)).toEqual([blocked.key]);
	});

	it("includes worker error details in JSON failures", async () => {
		const output: string[] = [];
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		spyOn(tinyTitleClient, "downloadModel").mockResolvedValue({
			ok: false,
			error: "Error: runtime install failed\n    at worker",
		});

		await expect(
			runTinyModelsCommand({ action: "download", model: "lfm2-700m", flags: { json: true } }),
		).rejects.toThrow("One or more tiny title models failed to download");

		expect(JSON.parse(output.join(""))).toEqual({
			results: [{ model: "lfm2-700m", ok: false, error: "Error: runtime install failed\n    at worker" }],
		});
	});

	it("includes worker error details in text failures", async () => {
		const output: string[] = [];
		const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		spyOn(tinyTitleClient, "downloadModel").mockResolvedValue({
			ok: false,
			error: "Error: runtime install failed\n    at worker",
		});

		try {
			await expect(runTinyModelsCommand({ action: "download", model: "lfm2-700m", flags: {} })).rejects.toThrow(
				"One or more tiny title models failed to download",
			);
		} finally {
			if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}

		expect(output.join("")).toContain("Failed to download LFM2 700M: runtime install failed.");
	});
});
