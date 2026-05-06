import { describe, expect, it, vi } from "bun:test";
import { resolveIsolationBackendForTaskExecution } from "../../src/task/isolation-backend";

const projfsOverlayProbeMock = vi.fn(() => {
	throw new Error("ProjFS native probe should not be called on Windows ARM64 under x64 emulation");
});
const projfsOverlayStartMock = vi.fn();
const projfsOverlayStopMock = vi.fn();

vi.mock("@oh-my-pi/pi-natives", () => ({
	projfsOverlayProbe: projfsOverlayProbeMock,
	projfsOverlayStart: projfsOverlayStartMock,
	projfsOverlayStop: projfsOverlayStopMock,
}));

describe("issue 949: Windows ARM64 avoids ProjFS native overlay under x64 emulation", () => {
	it("falls back to worktree before probing ProjFS on Windows ARM64", async () => {
		const result = await resolveIsolationBackendForTaskExecution("fuse-projfs", true, "C:\\repo", "win32", "x64", {
			PROCESSOR_ARCHITEW6432: "ARM64",
			PROCESSOR_ARCHITECTURE: "AMD64",
		});

		expect(result.effectiveIsolationMode).toBe("worktree");
		expect(result.warning).toContain("Windows ARM64");
		expect(result.warning).toContain("x64 emulation");
		expect(projfsOverlayProbeMock).not.toHaveBeenCalled();
		expect(projfsOverlayStartMock).not.toHaveBeenCalled();
	});
});
