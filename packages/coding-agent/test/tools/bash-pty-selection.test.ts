import { afterEach, describe, expect, it } from "bun:test";
import { canUseInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-pty-selection";

const originalPlatform = process.platform;
const originalNoPty = Bun.env.PI_NO_PTY;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
		writable: true,
	});
}

function restorePlatform(): void {
	Object.defineProperty(process, "platform", {
		value: originalPlatform,
		configurable: true,
		writable: true,
	});
}

function setNoPty(value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env.PI_NO_PTY;
		return;
	}
	Bun.env.PI_NO_PTY = value;
}

function interactiveContext() {
	return { hasUI: true, ui: {} };
}

describe("bash PTY selection", () => {
	afterEach(() => {
		restorePlatform();
		setNoPty(originalNoPty);
	});

	it("disables interactive PTY on Windows even when requested with UI", () => {
		setPlatform("win32");
		setNoPty(undefined);

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(false);
	});

	it("allows interactive PTY on non-Windows only when requested with UI and not disabled", () => {
		setPlatform("linux");
		setNoPty(undefined);

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(true);
		expect(canUseInteractiveBashPty(false, interactiveContext())).toBe(false);
		expect(canUseInteractiveBashPty(true, undefined)).toBe(false);

		setNoPty("1");
		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(false);
	});
});
