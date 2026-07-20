import { describe, expect, it } from "bun:test";
import { normalizeWindowsDriveAliasPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

describe("Windows drive alias paths", () => {
	it("maps MSYS drive roots to native Windows paths", () => {
		expect(normalizeWindowsDriveAliasPath("/c", "win32")).toBe("C:\\");
		expect(normalizeWindowsDriveAliasPath("/d/project/app", "win32")).toBe("D:\\project\\app");
		expect(normalizeWindowsDriveAliasPath("/D/project", "win32")).toBe("D:\\project");
	});

	it("maps WSL mount roots to native Windows paths", () => {
		expect(normalizeWindowsDriveAliasPath("/mnt/d/project", "win32")).toBe("D:\\project");
		expect(normalizeWindowsDriveAliasPath("/MNT/c", "win32")).toBe("C:\\");
	});

	it("leaves non-drive absolute paths and non-Windows platforms unchanged", () => {
		expect(normalizeWindowsDriveAliasPath("/", "win32")).toBe("/");
		expect(normalizeWindowsDriveAliasPath("/dev/null", "win32")).toBe("/dev/null");
		expect(normalizeWindowsDriveAliasPath("/mnt/data", "win32")).toBe("/mnt/data");
		expect(normalizeWindowsDriveAliasPath("/d/project", "linux")).toBe("/d/project");
		expect(normalizeWindowsDriveAliasPath("\\d\\logs", "win32")).toBe("\\d\\logs");
		expect(normalizeWindowsDriveAliasPath("\\mnt\\d\\logs", "win32")).toBe("\\mnt\\d\\logs");
	});
});
