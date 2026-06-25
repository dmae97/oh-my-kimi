import { describe, expect, it } from "bun:test";
import * as path from "node:path";

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
 * The fix has two halves:
 *
 * - `handleCtrlZ` sends SIGSTOP (uncatchable) to the foreground process
 *   group, so the kernel parks omp regardless of installed handlers and the
 *   parent shell sees the whole job stop even when omp runs behind a wrapper
 *   (`npx`, `pnpm exec`, `bunx`, …) or as one stage of a pipeline.
 * - MCP stdio servers spawn detached, so terminal job-control signals cannot
 *   stop their process trees and leave the JSONL read loop blocked on silent
 *   pipes — and so the pgid=0 suspend above doesn't reach them either.
 * The unit test in `input-controller-suspend.test.ts` covers the JS handler's
 * call shape; this file pins the runtime contract on the brush/MCP side so
 * refactors force a deliberate revisit instead of silently regressing behavior.
 */
describe("issue #3461 — Ctrl+Z hangs after a command has been run", () => {
	const packageDir = path.resolve(import.meta.dir, "..");
	const brushUnixSignal = path.resolve(packageDir, "../../crates/brush-core-vendored/src/sys/unix/signal.rs");
	const brushProcesses = path.resolve(packageDir, "../../crates/brush-core-vendored/src/processes.rs");
	const inputController = path.resolve(packageDir, "src/modes/controllers/input-controller.ts");
	const mcpStdioTransport = path.resolve(packageDir, "src/mcp/transports/stdio.ts");

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

	it("handleCtrlZ sends SIGSTOP to the foreground process group, defeating the brush hijack and covering wrappers/pipelines", async () => {
		const src = await Bun.file(inputController).text();
		// The original broken shape must not return.
		expect(src).not.toMatch(/process\.kill\(\s*0\s*,\s*["']SIGTSTP["']\s*\)/);
		// Self-only SIGSTOP was the v1 of this fix; it leaves wrapper/pipeline
		// peers in the same process group running and the shell never sees the
		// job stop. The handler now targets pgid=0.
		expect(src).not.toMatch(/process\.kill\(\s*process\.pid\s*,\s*["']SIGSTOP["']\s*\)/);
		// pgid=0 SIGSTOP is the only correct shape: uncatchable, and reaches
		// every process the shell considers part of the foreground job.
		expect(src).toMatch(/process\.kill\(\s*0\s*,\s*["']SIGSTOP["']\s*\)/);
	});

	it("MCP stdio servers spawn detached so terminal job-control signals cannot stop them", async () => {
		const src = await Bun.file(mcpStdioTransport).text();
		expect(src).toMatch(/detached:\s*true/);
		expect(src).toContain("no controlling terminal");
	});
});
