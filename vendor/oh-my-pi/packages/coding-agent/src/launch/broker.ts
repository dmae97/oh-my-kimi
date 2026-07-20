import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Process, type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { isEexist, isEnoent, logger, postmortem, procmgr, sanitizeText } from "@oh-my-pi/pi-utils";
import { hostHasInheritableConsole } from "../eval/py/spawn-options";
import { truncateHead, truncateHeadBytes, truncateTail, truncateTailBytes } from "../session/streaming-output";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { daemonBrokerEndpoint } from "./paths";
import { hasLiveDaemonProjectPresence } from "./presence";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_PTY_COLUMNS,
	DAEMON_PTY_ROWS,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
	type DaemonReadySpec,
	type DaemonRpcResult,
	type DaemonSignal,
	type DaemonSnapshot,
	type DaemonSpec,
	parseDaemonSnapshot,
	parseDaemonSpec,
	parseDaemonWireRequest,
} from "./protocol";
import { resolveDaemonSpawnOptions } from "./spawn-options";

const DEFAULT_IDLE_GRACE_MS = 3_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 25 * 1024 * 1024;
const LOG_READ_BYTES = 2 * 1024 * 1024;
const READINESS_BUFFER_CHARS = 64 * 1024;
const RESTART_MAX_DELAY_MS = 30_000;
const TOKEN_FILE = "broker.token";
const PID_FILE = "broker.pid";
const META_FILE = "meta.json";
const LOG_FILE = "output.log";
const PREVIOUS_LOG_FILE = "output.previous.log";
const DAEMON_SPAWN_OPTIONS = resolveDaemonSpawnOptions({
	platform: process.platform,
	hostHasInheritableConsole: hostHasInheritableConsole(),
});

const SIGNAL_NUMBER: Record<DaemonSignal, number> = {
	SIGINT: os.constants.signals.SIGINT,
	SIGTERM: os.constants.signals.SIGTERM,
	SIGHUP: os.constants.signals.SIGHUP,
	SIGQUIT: os.constants.signals.SIGQUIT,
	SIGKILL: os.constants.signals.SIGKILL,
};

interface ManagedProcess {
	pid: number;
	exited: Promise<number>;
	unref(): void;
}

interface ManagedDaemon {
	spec: DaemonSpec;
	snapshot: DaemonSnapshot;
	dir: string;
	log?: DaemonLog;
	process?: ManagedProcess;
	input?: Bun.FileSink;
	pty?: PtySession;
	generation: number;
	stopRequested: boolean;
	logReady: boolean;
	portReady: boolean;
	readinessBuffer: string;
	outputOffset: number;
	readyPattern?: RegExp;
	restartTimer?: NodeJS.Timeout;
	consecutiveFailures: number;
	persistQueue: Promise<void>;
}

interface BrokerLease {
	path: string;
	instanceId: string;
}

interface DaemonLogRead {
	text: string;
	terminalText: string;
}

function quoteShellArg(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function terminalState(state: DaemonSnapshot["state"]): boolean {
	return state === "exited" || state === "failed";
}

/** Mirror per-condition readiness progress into the snapshot so clients can see which condition is unmet. */
function syncReadyPending(record: ManagedDaemon): void {
	if (record.snapshot.state !== "starting") {
		record.snapshot.readyPending = undefined;
		return;
	}
	const pending: ("log" | "port")[] = [];
	if (!record.logReady) pending.push("log");
	if (!record.portReady) pending.push("port");
	record.snapshot.readyPending = pending.length > 0 ? pending : undefined;
}

async function fileTextSlice(filePath: string, head: boolean): Promise<string> {
	try {
		const stat = await fs.stat(filePath);
		const file = Bun.file(filePath);
		if (stat.size <= LOG_READ_BYTES) return await file.text();
		return head
			? await file.slice(0, LOG_READ_BYTES).text()
			: await file.slice(Math.max(0, stat.size - LOG_READ_BYTES)).text();
	} catch (error) {
		if (isEnoent(error)) return "";
		throw error;
	}
}

class DaemonLog {
	readonly #path: string;
	readonly #previousPath: string;
	readonly #file: Bun.BunFile;
	#writer: Bun.FileSink;
	#currentBytes = 0;
	#queue: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(logPath: string, previousPath: string, file: Bun.BunFile, writer: Bun.FileSink) {
		this.#path = logPath;
		this.#previousPath = previousPath;
		this.#file = file;
		this.#writer = writer;
	}

	static async open(dir: string): Promise<DaemonLog> {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const logPath = path.join(dir, LOG_FILE);
		const previousPath = path.join(dir, PREVIOUS_LOG_FILE);
		await fs.rm(previousPath, { force: true });
		try {
			await fs.rename(logPath, previousPath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const file = Bun.file(logPath);
		return new DaemonLog(logPath, previousPath, file, file.writer());
	}

	append(text: string): string {
		if (text.length === 0 || this.#closed) return text;
		const bytes = Buffer.byteLength(text, "utf8");
		this.#queue = this.#queue.then(async () => {
			if (this.#currentBytes > 0 && this.#currentBytes + bytes > MAX_LOG_BYTES) await this.#rotate();
			this.#writer.write(text);
			this.#currentBytes += bytes;
			await this.#writer.flush();
		});
		return text;
	}

	async read(head: boolean, lines: number, grep?: string): Promise<DaemonLogRead> {
		await this.#queue;
		await this.#writer.flush();
		return DaemonLog.readFiles(this.#path, this.#previousPath, head, lines, grep);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#queue;
		await this.#writer.end();
	}

	static async readFiles(
		logPath: string,
		previousPath: string,
		head: boolean,
		lines: number,
		grep?: string,
	): Promise<DaemonLogRead> {
		const [previous, current] = await Promise.all([fileTextSlice(previousPath, head), fileTextSlice(logPath, head)]);
		const combined = `${previous}${previous && current && !previous.endsWith("\n") ? "\n" : ""}${current}`;
		const terminalText = head
			? truncateHeadBytes(combined, LOG_READ_BYTES).text
			: truncateTailBytes(combined, LOG_READ_BYTES).text;
		let text = sanitizeText(terminalText);
		if (grep) {
			let pattern: RegExp;
			try {
				pattern = new RegExp(grep, "u");
			} catch (error) {
				throw new Error(`Invalid log regex: ${error instanceof Error ? error.message : String(error)}`);
			}
			text = text
				.split("\n")
				.filter(line => pattern.test(line))
				.join("\n");
		}
		const options = { maxLines: lines, maxBytes: 256 * 1024 };
		return {
			text: head ? truncateHead(text, options).content : truncateTail(text, options).content,
			terminalText,
		};
	}

	async #rotate(): Promise<void> {
		await this.#writer.end();
		await fs.rm(this.#previousPath, { force: true });
		await fs.rename(this.#path, this.#previousPath);
		this.#writer = this.#file.writer();
		this.#currentBytes = 0;
	}
}

async function acquireBrokerLease(runtimeDir: string): Promise<BrokerLease | null> {
	const pidPath = path.join(runtimeDir, PID_FILE);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(pidPath, "wx", 0o600);
			const instanceId = crypto.randomUUID();
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, instanceId }), "utf8");
			} finally {
				await handle.close();
			}
			return { path: pidPath, instanceId };
		} catch (error) {
			if (!isEexist(error)) throw error;
			try {
				const raw: unknown = await Bun.file(pidPath).json();
				if (typeof raw === "object" && raw !== null && "pid" in raw && typeof raw.pid === "number") {
					try {
						process.kill(raw.pid, 0);
						return null;
					} catch {
						// Stale PID file; the next loop iteration claims it.
					}
				}
			} catch {
				// Malformed or partially-written PID files are stale.
			}
			await fs.rm(pidPath, { force: true });
		}
	}
	return null;
}

async function releaseBrokerLease(lease: BrokerLease): Promise<void> {
	try {
		const raw: unknown = await Bun.file(lease.path).json();
		if (typeof raw === "object" && raw !== null && "instanceId" in raw && raw.instanceId === lease.instanceId) {
			await fs.rm(lease.path, { force: true });
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function connectPort(host: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection({ host, port });
	let settled = false;
	const finish = (connected: boolean): void => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(connected);
	};
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	socket.setTimeout(250, () => finish(false));
	return promise;
}

class DaemonBroker {
	readonly #projectDir: string;
	readonly #runtimeDir: string;
	readonly #endpoint: string;
	readonly #token: string;
	readonly #idleGraceMs: number;
	readonly #records = new Map<string, ManagedDaemon>();
	readonly #clients = new Set<net.Socket>();
	readonly #finished = Promise.withResolvers<void>();
	readonly #sockets = new Set<net.Socket>();
	#server: net.Server | undefined;
	#idleTimer: NodeJS.Timeout | undefined;
	#shuttingDown = false;

	constructor(projectDir: string, runtimeDir: string, token: string, idleGraceMs: number) {
		this.#projectDir = projectDir;
		this.#runtimeDir = runtimeDir;
		this.#endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		this.#token = token;
		this.#idleGraceMs = idleGraceMs;
	}

	async run(): Promise<void> {
		await this.#recoverRecords();
		if (process.platform !== "win32") await fs.rm(this.#endpoint, { force: true });
		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		const { promise: listening, resolve, reject } = Promise.withResolvers<void>();
		server.once("listening", resolve);
		server.once("error", reject);
		server.listen(this.#endpoint);
		await listening;
		if (process.platform !== "win32") await fs.chmod(this.#endpoint, 0o600);
		this.#scheduleIdleShutdown();
		await this.#finished.promise;
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) return this.#finished.promise;
		this.#shuttingDown = true;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		for (const record of this.#records.values()) {
			const detached = record.spec.detached && !record.stopRequested && record.snapshot.pid !== undefined;
			if (!detached && !terminalState(record.snapshot.state)) await this.#stopRecord(record, 2_000);
			clearTimeout(record.restartTimer);
			await record.log?.close();
			await record.persistQueue;
		}
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		this.#clients.clear();
		if (this.#server) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#server.close(() => resolve());
			await promise;
		}
		if (process.platform !== "win32") await fs.rm(this.#endpoint, { force: true });
		this.#finished.resolve();
	}

	#accept(socket: net.Socket): void {
		this.#sockets.add(socket);
		let authenticated = false;
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
				socket.destroy(new Error("Daemon broker request exceeds size limit"));
				return;
			}
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				void this.#handleLine(socket, line, () => {
					if (authenticated) return;
					authenticated = true;
					this.#clients.add(socket);
					clearTimeout(this.#idleTimer);
					this.#idleTimer = undefined;
				});
			}
		});
		socket.on("error", () => {
			// Socket closure performs client accounting.
		});
		socket.on("close", () => {
			this.#sockets.delete(socket);
			if (!authenticated) return;
			this.#clients.delete(socket);
			this.#scheduleIdleShutdown();
		});
	}

	async #handleLine(socket: net.Socket, line: string, onAuthenticated: () => void): Promise<void> {
		let id = "unknown";
		try {
			const decoded: unknown = JSON.parse(line);
			const request = parseDaemonWireRequest(decoded);
			id = request.id;
			if (request.token !== this.#token) throw new Error("Daemon broker authentication failed");
			onAuthenticated();
			const result = await this.#dispatch(request.operation);
			socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
			if (request.operation.op === "shutdown") setTimeout(() => void this.shutdown(), 10);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			socket.write(`${JSON.stringify({ id, ok: false, error: message })}\n`);
		}
	}

	async #dispatch(operation: DaemonOperation): Promise<DaemonRpcResult> {
		switch (operation.op) {
			case "ping":
				return { op: "ping", projectDir: this.#projectDir };
			case "start":
				return this.#start(operation.spec, operation.owner);
			case "list": {
				await Promise.all([...this.#records.values()].map(record => this.#refreshDetached(record)));
				return {
					op: "list",
					daemons: [...this.#records.values()]
						.sort((left, right) => left.snapshot.createdAt - right.snapshot.createdAt)
						.map(record => record.snapshot),
				};
			}
			case "logs":
				return this.#logs(operation);
			case "wait":
				return this.#wait(operation);
			case "send":
				return this.#send(operation);
			case "stop": {
				const record = this.#record(operation.name);
				await this.#stopRecord(record, operation.timeoutMs);
				return { op: "stop", daemon: record.snapshot };
			}
			case "restart":
				return this.#restart(operation.name);
			case "describe": {
				const record = this.#record(operation.name);
				await this.#refreshDetached(record);
				return { op: "describe", daemon: record.snapshot, spec: record.spec };
			}
			case "shutdown":
				return { op: "shutdown" };
		}
	}

	async #start(spec: DaemonSpec, owner?: string): Promise<DaemonRpcResult> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(spec.name)) {
			throw new Error("Daemon name must be 1-48 letters, numbers, dots, underscores, or hyphens");
		}
		if (spec.detached && spec.pty) {
			throw new Error("A detached daemon cannot allocate a PTY");
		}
		if (
			spec.pty &&
			process.platform === "win32" &&
			[".bat", ".cmd"].includes(path.extname(spec.application).toLowerCase())
		) {
			throw new Error('Windows batch files require application "cmd.exe" with the batch path after "/c"');
		}
		const existing = this.#records.get(spec.name);
		if (existing) await this.#refreshDetached(existing);
		if (existing && !terminalState(existing.snapshot.state)) {
			throw new Error(`Daemon ${spec.name} is already ${existing.snapshot.state}`);
		}
		if (spec.ready?.log) {
			try {
				new RegExp(spec.ready.log, "u");
			} catch (error) {
				throw new Error(`Invalid readiness regex: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const stat = await fs.stat(spec.cwd);
		if (!stat.isDirectory()) throw new Error(`Daemon cwd is not a directory: ${spec.cwd}`);
		const dir = path.join(this.#runtimeDir, "daemons", spec.name);
		const now = Date.now();
		const record: ManagedDaemon = {
			spec,
			snapshot: {
				name: spec.name,
				id: crypto.randomUUID(),
				state: "starting",
				createdAt: now,
				startedAt: now,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: spec.persist,
				detached: spec.detached,
			},
			dir,
			log: await DaemonLog.open(dir),
			generation: 0,
			stopRequested: false,
			logReady: !spec.ready?.log,
			portReady: spec.ready?.port === undefined,
			readinessBuffer: "",
			outputOffset: 0,
			readyPattern: spec.ready?.log ? new RegExp(spec.ready.log, "u") : undefined,
			consecutiveFailures: 0,
			persistQueue: Promise.resolve(),
		};
		syncReadyPending(record);
		this.#records.set(spec.name, record);
		await this.#launch(record);
		let readyTimedOut = false;
		if (spec.ready && !terminalState(record.snapshot.state)) {
			const ready = await this.#waitUntil(record, () => record.snapshot.state === "ready", spec.ready.timeoutMs);
			readyTimedOut = !ready && !terminalState(record.snapshot.state);
		}
		await record.persistQueue;
		return { op: "start", daemon: record.snapshot, readyTimedOut };
	}

	async #launch(record: ManagedDaemon): Promise<void> {
		record.generation++;
		const generation = record.generation;
		record.stopRequested = false;
		record.snapshot.state = record.spec.ready ? "starting" : "running";
		record.snapshot.startedAt = Date.now();
		record.snapshot.readyAt = undefined;
		record.snapshot.exitedAt = undefined;
		record.snapshot.exitCode = undefined;
		record.snapshot.exitReason = undefined;
		record.snapshot.pid = undefined;
		record.snapshot.readyMatch = undefined;
		record.logReady = !record.spec.ready?.log;
		record.portReady = record.spec.ready?.port === undefined;
		syncReadyPending(record);
		record.readinessBuffer = "";
		record.outputOffset = 0;
		this.#persist(record);
		try {
			if (record.spec.detached) await this.#launchDetached(record, generation);
			else if (record.spec.pty) await this.#launchPty(record, generation);
			else this.#launchPipe(record, generation);
			if (record.spec.ready?.port !== undefined) void this.#pollPort(record, generation, record.spec.ready);
			this.#markReady(record);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			record.log?.append(`Daemon launch failed: ${message}\n`);
			await this.#settle(record, generation, undefined, message);
		}
	}

	async #launchPty(record: ManagedDaemon, generation: number): Promise<void> {
		const session = new PtySession();
		record.pty = session;
		const options = {
			cwd: record.spec.cwd,
			env: workerEnvFromParent({ TERM: "xterm-256color", ...record.spec.env }),
			cols: DAEMON_PTY_COLUMNS,
			rows: DAEMON_PTY_ROWS,
		};
		const onChunk = (error: Error | null, chunk: string): void => {
			if (generation !== record.generation) return;
			if (error) record.log?.append(`PTY output error: ${error.message}\n`);
			if (chunk) this.#onOutput(record, generation, chunk);
		};
		const started = Promise.withResolvers<number | undefined>();
		const onStart = (error: Error | null, pid: number): void => {
			if (error) {
				record.log?.append(`PTY startup callback failed: ${error.message}\n`);
				started.resolve(undefined);
				return;
			}
			started.resolve(Number.isSafeInteger(pid) && pid > 0 ? pid : undefined);
		};
		let run: Promise<PtyRunResult>;
		if (process.platform === "win32") {
			run = session.startArgv(
				{
					application: record.spec.application,
					args: record.spec.args,
					...options,
				},
				onChunk,
				onStart,
			);
		} else {
			const argv = [record.spec.application, ...record.spec.args];
			const command = `exec ${argv.map(quoteShellArg).join(" ")}`;
			const shell = procmgr.getShellConfig().shell;
			run = session.start({ command, shell, ...options }, onChunk, onStart);
		}
		void run.then(
			async result => {
				await this.#onPtyExit(record, generation, result);
				started.resolve(undefined);
			},
			async error => {
				await this.#settle(record, generation, undefined, error instanceof Error ? error.message : String(error));
				started.resolve(undefined);
			},
		);

		const pid = await started.promise;
		if (pid !== undefined && generation === record.generation) {
			record.snapshot.pid = pid;
			this.#persist(record);
		}
	}

	#launchPipe(record: ManagedDaemon, generation: number): void {
		const process = Bun.spawn([record.spec.application, ...record.spec.args], {
			cwd: record.spec.cwd,
			env: workerEnvFromParent(record.spec.env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			...DAEMON_SPAWN_OPTIONS,
		});
		record.process = process;
		record.input = process.stdin;
		record.snapshot.pid = process.pid;
		this.#persist(record);
		const stdout = this.#drain(record, generation, process.stdout);
		const stderr = this.#drain(record, generation, process.stderr);
		void Promise.all([stdout, stderr, process.exited])
			.then(([, , exitCode]) => this.#settle(record, generation, exitCode))
			.catch(error =>
				this.#settle(record, generation, undefined, error instanceof Error ? error.message : String(error)),
			);
	}

	async #launchDetached(record: ManagedDaemon, generation: number): Promise<void> {
		const logPath = path.join(record.dir, LOG_FILE);
		const output = await fs.open(logPath, "a", 0o600);
		try {
			const process = Bun.spawn([record.spec.application, ...record.spec.args], {
				cwd: record.spec.cwd,
				env: workerEnvFromParent(record.spec.env),
				stdio: ["ignore", output.fd, output.fd],
				...DAEMON_SPAWN_OPTIONS,
			});
			record.process = process;
			record.snapshot.pid = process.pid;
			this.#persist(record);
			process.unref();
			void process.exited
				.then(exitCode => this.#settle(record, generation, exitCode))
				.catch(error =>
					this.#settle(record, generation, undefined, error instanceof Error ? error.message : String(error)),
				);
		} finally {
			await output.close();
		}
	}

	async #drain(record: ManagedDaemon, generation: number, stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (generation === record.generation)
					this.#onOutput(record, generation, decoder.decode(value, { stream: true }));
			}
			const tail = decoder.decode();
			if (tail && generation === record.generation) this.#onOutput(record, generation, tail);
		} finally {
			reader.releaseLock();
		}
	}

	#onOutput(record: ManagedDaemon, generation: number, raw: string): void {
		if (generation !== record.generation) return;
		const output = raw.toWellFormed();
		const text = record.log?.append(output) ?? output;
		record.snapshot.outputBytes += Buffer.byteLength(text, "utf8");
		this.#trackOutput(record, generation, sanitizeText(text));
	}

	async #readDetachedOutput(record: ManagedDaemon, generation: number): Promise<void> {
		if (!record.spec.detached || generation !== record.generation) return;
		const logPath = path.join(record.dir, LOG_FILE);
		let size: number;
		try {
			size = (await fs.stat(logPath)).size;
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		if (size < record.outputOffset) record.outputOffset = 0;
		if (size === record.outputOffset) return;
		const file = Bun.file(logPath);
		const raw = await file.slice(record.outputOffset, size).text();
		if (generation !== record.generation) return;
		record.outputOffset = size;
		record.snapshot.outputBytes = size;
		this.#trackOutput(record, generation, sanitizeText(raw));
	}

	#trackOutput(record: ManagedDaemon, generation: number, text: string): void {
		if (generation !== record.generation) return;
		record.readinessBuffer = (record.readinessBuffer + text).slice(-READINESS_BUFFER_CHARS);
		if (!record.logReady && record.readyPattern) {
			const match = record.readyPattern.exec(record.readinessBuffer);
			if (match) {
				record.logReady = true;
				record.snapshot.readyMatch = match[0].slice(0, 500);
				syncReadyPending(record);
			}
		}
		this.#markReady(record);
	}

	async #refreshDetached(record: ManagedDaemon): Promise<void> {
		if (!record.spec.detached || terminalState(record.snapshot.state)) return;
		const generation = record.generation;
		await this.#readDetachedOutput(record, generation);
		if (generation !== record.generation || record.process) return;
		const processRef = record.snapshot.pid === undefined ? null : Process.fromPid(record.snapshot.pid);
		if (processRef?.status() === "running") return;
		await this.#settle(record, generation);
	}

	async #pollPort(record: ManagedDaemon, generation: number, ready: DaemonReadySpec): Promise<void> {
		const host = ready.host ?? "127.0.0.1";
		const port = ready.port;
		if (port === undefined) return;
		while (generation === record.generation && !terminalState(record.snapshot.state)) {
			if (await connectPort(host, port)) {
				record.portReady = true;
				syncReadyPending(record);
				this.#markReady(record);
				return;
			}
			await Bun.sleep(100);
		}
	}

	#markReady(record: ManagedDaemon): void {
		if (!record.spec.ready || record.snapshot.state !== "starting") return;
		if (!record.logReady || !record.portReady) return;
		record.snapshot.state = "ready";
		record.snapshot.readyAt = Date.now();
		this.#persist(record);
	}

	async #onPtyExit(record: ManagedDaemon, generation: number, result: PtyRunResult): Promise<void> {
		return this.#settle(record, generation, result.exitCode, result.timedOut ? "timed out" : undefined);
	}

	async #settle(record: ManagedDaemon, generation: number, exitCode?: number, error?: string): Promise<void> {
		if (generation !== record.generation || terminalState(record.snapshot.state)) return;
		await this.#readDetachedOutput(record, generation);
		record.process = undefined;
		record.input = undefined;
		record.pty = undefined;
		record.snapshot.pid = undefined;
		record.snapshot.exitedAt = Date.now();
		record.snapshot.exitCode = exitCode;
		record.snapshot.exitReason = error;
		record.snapshot.readyPending = undefined;
		const failed = error !== undefined || (exitCode !== undefined && exitCode !== 0);
		const shouldRestart =
			!record.stopRequested &&
			(record.spec.restart === "always" || (record.spec.restart === "on-failure" && failed));
		if (shouldRestart && !this.#shuttingDown) {
			const uptime = Date.now() - record.snapshot.startedAt;
			record.consecutiveFailures = uptime >= 30_000 ? 0 : record.consecutiveFailures + 1;
			record.snapshot.restartCount++;
			record.snapshot.state = "restarting";
			const delay = Math.min(1_000 * 2 ** Math.min(record.consecutiveFailures, 5), RESTART_MAX_DELAY_MS);
			record.log?.append(
				`\n[daemon exited${exitCode === undefined ? "" : ` with code ${exitCode}`}; restarting in ${delay}ms]\n`,
			);
			this.#persist(record);
			record.restartTimer = setTimeout(() => {
				record.restartTimer = undefined;
				void this.#launch(record);
			}, delay);
			return;
		}
		record.snapshot.state = failed && !record.stopRequested ? "failed" : "exited";
		this.#persist(record);
		await record.log?.close();
		record.log = undefined;
	}

	async #logs(operation: Extract<DaemonOperation, { op: "logs" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.name);
		await this.#refreshDetached(record);
		const cursor = operation.cursor ?? record.snapshot.outputBytes;
		let timedOut = false;
		if (operation.follow && record.snapshot.outputBytes <= cursor && !terminalState(record.snapshot.state)) {
			const changed = await this.#waitUntil(
				record,
				() => record.snapshot.outputBytes > cursor || terminalState(record.snapshot.state),
				operation.timeoutMs,
			);
			timedOut = !changed;
		}
		const lines = Math.max(1, Math.min(1_000, Math.floor(operation.lines)));
		const output = record.log
			? await record.log.read(operation.head, lines, operation.grep)
			: await DaemonLog.readFiles(
					path.join(record.dir, LOG_FILE),
					path.join(record.dir, PREVIOUS_LOG_FILE),
					operation.head,
					lines,
					operation.grep,
				);
		return {
			op: "logs",
			name: record.snapshot.name,
			text: output.text,
			terminalText: record.spec.pty && operation.grep === undefined ? output.terminalText : undefined,
			cursor: record.snapshot.outputBytes,
			timedOut,
			state: record.snapshot.state,
		};
	}

	async #wait(operation: Extract<DaemonOperation, { op: "wait" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.name);
		await this.#refreshDetached(record);
		let matched: string | undefined;
		let pattern: RegExp | undefined;
		if (operation.pattern) {
			try {
				pattern = new RegExp(operation.pattern, "u");
			} catch (error) {
				throw new Error(`Invalid wait regex: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const condition = (): boolean => {
			if (pattern) {
				const match = pattern.exec(record.readinessBuffer);
				if (!match) return false;
				matched = match[0].slice(0, 500);
				return true;
			}
			if (operation.for === "exit") return terminalState(record.snapshot.state);
			return record.snapshot.state === "ready" || (record.snapshot.state === "running" && !record.spec.ready);
		};
		const reached = condition() || (await this.#waitUntil(record, condition, operation.timeoutMs));
		return { op: "wait", daemon: record.snapshot, matched, timedOut: !reached };
	}

	async #send(operation: Extract<DaemonOperation, { op: "send" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.name);
		await this.#refreshDetached(record);
		if (terminalState(record.snapshot.state) || record.snapshot.state === "stopping") {
			throw new Error(`Daemon ${operation.name} is ${record.snapshot.state}`);
		}
		if (operation.data === undefined && operation.signal === undefined) {
			throw new Error("send requires data or signal");
		}
		if (operation.data !== undefined) {
			if (record.pty) record.pty.write(operation.data);
			else if (record.input) {
				record.input.write(operation.data);
				await record.input.flush();
			} else throw new Error(`Daemon ${operation.name} stdin is unavailable`);
		}
		if (operation.signal) {
			if (process.platform === "win32" && record.pty) {
				if (operation.signal === "SIGINT") record.pty.write("\u0003");
				else record.pty.kill();
			} else {
				const processRef = record.snapshot.pid === undefined ? null : Process.fromPid(record.snapshot.pid);
				if (!processRef) throw new Error(`Daemon ${operation.name} process is unavailable`);
				processRef.killTree(SIGNAL_NUMBER[operation.signal]);
			}
		}
		return { op: "send", daemon: record.snapshot };
	}

	async #stopRecord(record: ManagedDaemon, timeoutMs: number): Promise<void> {
		await this.#refreshDetached(record);
		if (terminalState(record.snapshot.state)) return;
		record.stopRequested = true;
		if (record.restartTimer) {
			clearTimeout(record.restartTimer);
			record.restartTimer = undefined;
			record.snapshot.state = "exited";
			record.snapshot.exitedAt = Date.now();
			this.#persist(record);
			await record.log?.close();
			record.log = undefined;
			return;
		}
		record.snapshot.state = "stopping";
		this.#persist(record);
		const processRef = record.snapshot.pid === undefined ? null : Process.fromPid(record.snapshot.pid);
		if (processRef) await processRef.terminate({ group: true, gracefulMs: timeoutMs, timeoutMs: timeoutMs + 1_000 });
		else record.pty?.kill();
		const settled = await this.#waitUntil(record, () => terminalState(record.snapshot.state), timeoutMs + 1_000);
		if (!settled && record.pty) record.pty.kill();
	}

	async #restart(name: string): Promise<DaemonRpcResult> {
		const record = this.#record(name);
		await this.#stopRecord(record, 2_000);
		await record.log?.close();
		record.log = await DaemonLog.open(record.dir);
		record.stopRequested = false;
		await this.#launch(record);
		await record.persistQueue;
		return { op: "restart", daemon: record.snapshot };
	}

	async #waitUntil(record: ManagedDaemon, condition: () => boolean, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (Date.now() < deadline) {
			await this.#refreshDetached(record);
			if (condition()) return true;
			if (this.#shuttingDown && terminalState(record.snapshot.state)) return condition();
			await Bun.sleep(50);
		}
		await this.#refreshDetached(record);
		return condition();
	}

	#record(name: string): ManagedDaemon {
		const record = this.#records.get(name);
		if (record) return record;
		const names = [...this.#records.keys()];
		throw new Error(`Unknown daemon ${name}${names.length ? `. Available: ${names.join(", ")}` : ""}`);
	}

	#persist(record: ManagedDaemon): void {
		const metaPath = path.join(record.dir, META_FILE);
		const tempPath = `${metaPath}.${process.pid}.tmp`;
		record.persistQueue = record.persistQueue
			.then(async () => {
				await Bun.write(tempPath, JSON.stringify({ daemon: record.snapshot, spec: record.spec }));
				await fs.rename(tempPath, metaPath);
			})
			.catch(error => {
				logger.warn("Failed to persist daemon metadata", {
					name: record.snapshot.name,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	async #recoverRecords(): Promise<void> {
		const root = path.join(this.#runtimeDir, "daemons");
		const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
			if (isEnoent(error)) return [];
			throw error;
		});
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			try {
				const decoded: unknown = await Bun.file(path.join(dir, META_FILE)).json();
				if (typeof decoded !== "object" || decoded === null || !("daemon" in decoded) || !("spec" in decoded)) {
					continue;
				}
				const snapshot = parseDaemonSnapshot(decoded.daemon);
				const spec = parseDaemonSpec(decoded.spec);
				const processRef = snapshot.pid === undefined ? null : Process.fromPid(snapshot.pid);
				const detached =
					spec.detached &&
					!terminalState(snapshot.state) &&
					snapshot.state !== "stopping" &&
					processRef?.status() === "running";
				if (!detached) {
					if (processRef) await processRef.terminate({ group: true, gracefulMs: 500, timeoutMs: 2_000 });
					snapshot.pid = undefined;
					snapshot.state = "exited";
					snapshot.exitedAt = Date.now();
					snapshot.exitReason = "previous broker exited";
				} else if (snapshot.state === "restarting") {
					snapshot.state = spec.ready ? "starting" : "running";
				}
				snapshot.persist = spec.persist;
				snapshot.detached = spec.detached;
				const record: ManagedDaemon = {
					spec,
					snapshot,
					dir,
					generation: 0,
					stopRequested: !detached || snapshot.state === "stopping",
					logReady: detached && (!spec.ready?.log || snapshot.state === "ready"),
					portReady: detached && (spec.ready?.port === undefined || snapshot.state === "ready"),
					readinessBuffer: "",
					outputOffset: detached ? snapshot.outputBytes : 0,
					readyPattern: spec.ready?.log ? new RegExp(spec.ready.log, "u") : undefined,
					consecutiveFailures: 0,
					persistQueue: Promise.resolve(),
				};
				syncReadyPending(record);
				this.#records.set(snapshot.name, record);
				if (detached && spec.ready?.port !== undefined && snapshot.state !== "ready") {
					void this.#pollPort(record, record.generation, spec.ready);
				}
				this.#persist(record);
			} catch (error) {
				logger.warn("Failed to recover daemon record", {
					name: entry.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	#scheduleIdleShutdown(): void {
		if (this.#shuttingDown || this.#clients.size > 0) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			void (async () => {
				const livePersistent = [...this.#records.values()].some(
					record => record.spec.persist && !terminalState(record.snapshot.state),
				);
				if (this.#clients.size > 0 || livePersistent) return;
				if (await hasLiveDaemonProjectPresence(this.#runtimeDir)) {
					this.#scheduleIdleShutdown();
					return;
				}
				if (this.#clients.size === 0) await this.shutdown();
			})();
		}, this.#idleGraceMs);
	}
}

/** Start the detached per-project daemon broker selected by the CLI worker host. */
export async function startDaemonBrokerFromEnvironment(): Promise<void> {
	const projectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const runtimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	if (!projectDir || !runtimeDir) throw new Error("Daemon broker environment is incomplete");
	delete process.env[DAEMON_PROJECT_DIR_ENV];
	delete process.env[DAEMON_RUNTIME_DIR_ENV];
	const rawGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	delete process.env[DAEMON_IDLE_GRACE_ENV];
	const parsedGrace = rawGrace === undefined ? DEFAULT_IDLE_GRACE_MS : Number.parseInt(rawGrace, 10);
	const idleGraceMs = Number.isFinite(parsedGrace) && parsedGrace >= 0 ? parsedGrace : DEFAULT_IDLE_GRACE_MS;
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const lease = await acquireBrokerLease(runtimeDir);
	if (!lease) return;
	process.title = "omp daemon broker";
	const token = (await Bun.file(path.join(runtimeDir, TOKEN_FILE)).text()).trim();
	if (!token) throw new Error("Daemon broker token is empty");
	const broker = new DaemonBroker(projectDir, runtimeDir, token, idleGraceMs);
	const cancelCleanup = postmortem.register("daemon-broker", () => broker.shutdown());
	try {
		await broker.run();
	} finally {
		cancelCleanup();
		await releaseBrokerLease(lease);
	}
}
