import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";

describe("resolveMemoryBackend", () => {
	beforeEach(() => {
		_resetSettingsForTest();
	});

	afterEach(() => {
		_resetSettingsForTest();
	});

	it("returns the off backend when memory.backend is off", () => {
		const settings = Settings.isolated({ "memory.backend": "off" });
		expect(resolveMemoryBackend(settings).id).toBe("off");
	});

	it("returns the local backend when memory.backend is local", () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		expect(resolveMemoryBackend(settings).id).toBe("local");
	});

	it("returns the hindsight backend when memory.backend is hindsight, regardless of legacy memories.enabled", () => {
		const a = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": false });
		const b = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": true });
		expect(resolveMemoryBackend(a).id).toBe("hindsight");
		expect(resolveMemoryBackend(b).id).toBe("hindsight");
	});
});
