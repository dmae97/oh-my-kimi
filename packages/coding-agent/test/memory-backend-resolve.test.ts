import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings, _resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
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

	it("returns the local backend when memory.backend is local AND memories.enabled is true", () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": true });
		expect(resolveMemoryBackend(settings).id).toBe("local");
	});

	it("returns the off backend when memory.backend is local but memories.enabled is false", () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		// Falls back to off so existing users with memories.enabled=false keep silence.
		expect(resolveMemoryBackend(settings).id).toBe("off");
	});

	it("returns the hindsight backend when memory.backend is hindsight, regardless of memories.enabled", () => {
		const a = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": false });
		const b = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": true });
		expect(resolveMemoryBackend(a).id).toBe("hindsight");
		expect(resolveMemoryBackend(b).id).toBe("hindsight");
	});
});
