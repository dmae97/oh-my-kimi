import * as path from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/3461
 *
 * Ctrl+Z stopped working after any tool call: the TUI tore down but the
 * process kept running (`Sl+`, not `T`), wedging the terminal until
 * `kill -9`. Root cause: brush-core's `Process::wait` calls
 * `tokio::signal::unix::signal(SIGTSTP)` to detect when its children get
 * stopped. Per tokio's documented contract the first call for a SignalKind
 * permanently replaces the kernel-default handler — so after the first
 * `Shell::run` the parent's SIGTSTP no longer triggers the kernel STOP
 * action, and `process.kill(0, "SIGTSTP")` from the Ctrl+Z handler became
 * a no-op.
 *
 * The fix sends SIGSTOP (uncatchable) to our own PID instead. The unit
 * test in `input-controller-suspend.test.ts` covers the JS handler's
 * call shape; this file pins the runtime contract on the brush side so
 * a brush upgrade or refactor that removes / gates the SIGTSTP listener
 * forces a deliberate revisit of `handleCtrlZ` (we could go back to
 * `process.kill(0, "SIGTSTP")` once the hijack is gone) instead of
 * silently regressing behavior.
 */
describe("issue #3461 — Ctrl+Z hangs after a command has been run", () => {
	const packageDir = path.resolve(import.meta.dir, "..");
	const brushUnixSignal = path.resolve(
		packageDir,
		"../../crates/brush-core-vendored/src/sys/unix/signal.rs",
	);
	const brushProcesses = path.resolve(
		packageDir,
		"../../crates/brush-core-vendored/src/processes.rs",
	);
	const inputController = path.resolve(
		packageDir,
		"src/modes/controllers/input-controller.ts",
	);

	it("brush-core installs a tokio SIGTSTP listener on every Process::wait", async () => {
		const signalSrc = await Bun.file(brushUnixSignal).text();
		expect(signalSrc).toContain("tstp_signal_listener");
		expect(signalSrc).toContain("tokio::signal::unix::signal");
		// Pin the SIGTSTP constant specifically. A move to a non-job-control
		// signal would invalidate the assumption this fix is built on.
		expect(signalSrc).toMatch(/nix::libc::SIGTSTP/);

		const processesSrc = await Bun.file(brushProcesses).text();
		expect(processesSrc).toContain("tstp_signal_listener");
	});

	it("handleCtrlZ sends SIGSTOP — not SIGTSTP — to our own PID, defeating the brush hijack", async () => {
		const src = await Bun.file(inputController).text();
		// `process.kill(0, "SIGTSTP")` is the broken call shape; it must not
		// reappear in the Ctrl+Z handler.
		expect(src).not.toMatch(/process\.kill\(\s*0\s*,\s*["']SIGTSTP["']\s*\)/);
		// SIGSTOP to our own PID is the only correct shape: SIGSTOP cannot be
		// caught/blocked/ignored, and targeting self leaves child MCP / native
		// shell processes running across the suspend.
		expect(src).toMatch(/process\.kill\(\s*process\.pid\s*,\s*["']SIGSTOP["']\s*\)/);
	});
});
