import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";

describe("resolveMemoryBackend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("returns the hindsight backend when memory.backend is hindsight, regardless of legacy memories.enabled", () => {
		const a = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": false });
		const b = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": true });
		expect(resolveMemoryBackend(a).id).toBe("hindsight");
		expect(resolveMemoryBackend(b).id).toBe("hindsight");
	});
});
