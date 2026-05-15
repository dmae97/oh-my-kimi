import { afterEach, describe, expect, it } from "bun:test";
import { canUseInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-pty-selection";

const originalPlatform = process.platform;
const originalNoPty = Bun.env.PI_NO_PTY;

const originalForcePty = Bun.env.PI_FORCE_PTY;
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

function setForcePty(value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env.PI_FORCE_PTY;
		return;
	}
	Bun.env.PI_FORCE_PTY = value;
}
function interactiveContext() {
	return { hasUI: true, ui: {} };
}

describe("bash PTY selection", () => {
	afterEach(() => {
		restorePlatform();
		setNoPty(originalNoPty);
		setForcePty(originalForcePty);
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
	it("allows interactive PTY on Windows when PI_FORCE_PTY=1", () => {
		setPlatform("win32");
		setNoPty(undefined);
		setForcePty("1");

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(true);
	});

	it("ignores PI_FORCE_PTY on non-Windows (follows normal UI check)", () => {
		setPlatform("linux");
		setNoPty(undefined);
		setForcePty("1");

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(true);
		expect(canUseInteractiveBashPty(true, undefined)).toBe(false);
	});

	it("PI_NO_PTY=1 overrides PI_FORCE_PTY=1", () => {
		setPlatform("win32");
		setNoPty("1");
		setForcePty("1");

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(false);
	});
});
