import { spawn } from "node:child_process";

const normalOrphan = process.argv.includes("--normal-orphan");

if (!process.argv.includes("--parent-exits") && !normalOrphan) {
	process.on("SIGTERM", () => {
		// Exercise the managed runner's SIGKILL escalation path.
	});
}

// The grandchild ignores SIGTERM so the managed runner must escalate to
// SIGKILL. It writes "ready" on its stdout (piped back to this parent) only
// AFTER installing its SIGTERM handler. The parent waits for that signal
// before exiting or settling into its keep-alive loop, so the runner never
// signals the process group while the grandchild is still in its startup
// window (a fresh `node -e` process needs ~50-100ms before its first JS line
// runs). Without this handshake a SIGTERM can land before the handler is
// installed, killing the grandchild via the default handler and making the
// SIGKILL escalation (cleanup.killSent) a timing race.
const grandchild = spawn(
	process.execPath,
	["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"],
	{
		stdio: ["ignore", "pipe", "ignore"],
	},
);

process.stdout.write(`${JSON.stringify({ grandchildPid: grandchild.pid })}\n`);

const startMain = () => {
	if (normalOrphan) setTimeout(() => process.exit(0), 20);
	else setInterval(() => {}, 1000);
};

let started = false;
grandchild.stdout.on("data", () => {
	if (started) return;
	started = true;
	startMain();
});
