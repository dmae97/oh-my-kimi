/**
 * Contract (#4049 follow-up): a writable TUI guest must answer host
 * `ui-request` frames instead of silently dropping them. The guest presents
 * the ask through the hook selector/editor seam, answers with `ui-response`
 * (explicit cancel included), honors `ui-request-end` as
 * dismiss-without-responding, and clears stale presentations on resync/leave
 * so replayed requests never double-answer.
 *
 * The host side of the wire contract (broadcast, replay-on-hello, response
 * resolution) is covered by read-only.test.ts; here a scripted host socket
 * drives a real CollabGuestLink over the in-memory relay so every guest→host
 * frame is observable.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	type CollabSessionState,
	formatCollabLink,
	parseCollabLink,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type {
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { InteractiveModeContext, InteractiveSelectorDialogOptions } from "@oh-my-pi/pi-coding-agent/modes/types";

// ── In-memory transport (same contract as the other collab tests) ──────────

let activeRelay: InMemoryRelay | null = null;
const RealWebSocket = globalThis.WebSocket;

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	binaryType = "arraybuffer";
	readyState: number = FakeWebSocket.CONNECTING;
	readonly role: "host" | "guest";
	peerId = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	readonly #relay: InMemoryRelay;

	constructor(url: string) {
		const relay = activeRelay;
		if (!relay) throw new Error("FakeWebSocket: no active in-memory relay");
		this.#relay = relay;
		this.role = new URL(url).searchParams.get("role") === "host" ? "host" : "guest";
		queueMicrotask(() => {
			if (this.readyState !== FakeWebSocket.CONNECTING) return;
			this.readyState = FakeWebSocket.OPEN;
			relay.connect(this);
			this.onopen?.();
		});
	}

	send(data: Uint8Array): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		const bytes = new Uint8Array(data);
		queueMicrotask(() => this.#relay.forward(this, bytes));
	}

	close(_code?: number): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.#relay.disconnect(this);
		queueMicrotask(() => this.onclose?.({ code: 1000, reason: "closed" }));
	}

	deliver(bytes: Uint8Array): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		const copy = new Uint8Array(bytes);
		queueMicrotask(() => this.onmessage?.({ data: copy.buffer }));
	}

	deliverControl(json: string): void {
		if (this.readyState !== FakeWebSocket.OPEN) return;
		queueMicrotask(() => this.onmessage?.({ data: json }));
	}
}

class InMemoryRelay {
	#host: FakeWebSocket | null = null;
	readonly #guests = new Map<number, FakeWebSocket>();
	#nextPeerId = 1;

	connect(ws: FakeWebSocket): void {
		if (ws.role === "host") {
			this.#host = ws;
			return;
		}
		ws.peerId = this.#nextPeerId++;
		this.#guests.set(ws.peerId, ws);
		this.#host?.deliverControl(JSON.stringify({ t: "peer-joined", peer: ws.peerId }));
	}

	forward(from: FakeWebSocket, bytes: Uint8Array): void {
		if (from.role === "host") {
			const envelope = unpackEnvelope(bytes);
			if (!envelope) return;
			if (envelope.peerId === 0) {
				for (const guest of this.#guests.values()) guest.deliver(bytes);
			} else {
				this.#guests.get(envelope.peerId)?.deliver(bytes);
			}
			return;
		}
		rewriteEnvelopePeer(bytes, from.peerId);
		this.#host?.deliver(bytes);
	}

	disconnect(ws: FakeWebSocket): void {
		if (ws.role === "host") {
			if (this.#host === ws) this.#host = null;
			return;
		}
		this.#guests.delete(ws.peerId);
		this.#host?.deliverControl(JSON.stringify({ t: "peer-left", peer: ws.peerId }));
	}
}

// ── Guest harness ───────────────────────────────────────────────────────────

/** One hook-dialog presentation captured from the guest link. */
interface DialogStub {
	kind: "select" | "editor";
	title: string;
	options?: ExtensionUISelectItem[];
	prefill?: string;
	dialogOptions?: ExtensionUIDialogOptions;
	/** Flipped when the guest dismissed the presentation via the abort signal. */
	aborted: boolean;
	whenAborted: Promise<void>;
	/** Simulate the user submitting (string) or cancelling (undefined). */
	settle(value: string | undefined): void;
}

interface UiResponseRecord {
	reqId: number;
	value: string | undefined;
}

interface GuestUiHarness {
	guest: CollabGuestLink;
	hostSocket: CollabSocket;
	/** Every presentation the guest ever made, in order. */
	dialogLog: DialogStub[];
	/** Every ui-response the scripted host ever received, in order. */
	uiResponses: UiResponseRecord[];
	nextDialog(): Promise<DialogStub>;
	nextUiResponse(): Promise<UiResponseRecord>;
	/**
	 * Deterministic apply-chain barrier: send a sentinel `error` frame and
	 * resolve once the guest surfaces it. Frames apply strictly in arrival
	 * order, so every frame sent before the sentinel has fully applied.
	 */
	barrier(): Promise<void>;
	/** Re-send the welcome (resync); the guest clears stale presentations on it. */
	sendWelcome(): void;
	cleanup(): Promise<void>;
}

function makeState(): CollabSessionState {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

async function makeHarness(opts?: { readOnly?: boolean }): Promise<GuestUiHarness> {
	const roomId = "ui-request-room";
	const roomKey = generateRoomKey();
	const cryptoKey = await importRoomKey(roomKey);
	const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);

	const dialogLog: DialogStub[] = [];
	const dialogQueue: DialogStub[] = [];
	const dialogWaiters: ((stub: DialogStub) => void)[] = [];
	const presentStub = (
		fields: Omit<DialogStub, "aborted" | "whenAborted" | "settle">,
	): Promise<string | undefined> => {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const abortGate = Promise.withResolvers<void>();
		let settled = false;
		const stub: DialogStub = {
			...fields,
			aborted: false,
			whenAborted: abortGate.promise,
			settle: value => {
				if (settled) return;
				settled = true;
				resolve(value);
			},
		};
		// Mirror ExtensionUiController.#presentDialog: an abort settles the
		// dialog with undefined and dismisses it.
		fields.dialogOptions?.signal?.addEventListener(
			"abort",
			() => {
				stub.aborted = true;
				abortGate.resolve();
				if (!settled) {
					settled = true;
					resolve(undefined);
				}
			},
			{ once: true },
		);
		dialogLog.push(stub);
		const waiter = dialogWaiters.shift();
		if (waiter) waiter(stub);
		else dialogQueue.push(stub);
		return promise;
	};
	const nextDialog = (): Promise<DialogStub> => {
		const queued = dialogQueue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<DialogStub>();
		dialogWaiters.push(resolve);
		return promise;
	};

	const uiResponses: UiResponseRecord[] = [];
	const responseQueue: UiResponseRecord[] = [];
	const responseWaiters: ((record: UiResponseRecord) => void)[] = [];
	const nextUiResponse = (): Promise<UiResponseRecord> => {
		const queued = responseQueue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<UiResponseRecord>();
		responseWaiters.push(resolve);
		return promise;
	};

	let barrierSeq = 0;
	const errorWaiters = new Map<string, () => void>();
	const barrier = (): Promise<void> => {
		const sentinel = `__barrier_${++barrierSeq}__`;
		const { promise, resolve } = Promise.withResolvers<void>();
		errorWaiters.set(sentinel, resolve);
		hostSocket.send({ t: "error", message: sentinel });
		return promise;
	};

	const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
	const hostOpen = Promise.withResolvers<void>();
	const sendWelcome = (): void => {
		hostSocket.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
			state: makeState(),
			agents: [],
			entryCount: 0,
			readOnly: opts?.readOnly ? true : undefined,
		});
	};
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = frame => {
		if (frame.t === "hello") sendWelcome();
		if (frame.t === "ui-response") {
			const record: UiResponseRecord = { reqId: frame.reqId, value: frame.value };
			uiResponses.push(record);
			const waiter = responseWaiters.shift();
			if (waiter) waiter(record);
			else responseQueue.push(record);
		}
	};
	hostSocket.connect();
	await hostOpen.promise;

	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: (message: string) => {
			// The guest prefixes host error frames ("Collab host: <message>");
			// match the embedded sentinel.
			for (const [sentinel, waiter] of errorWaiters) {
				if (message.includes(sentinel)) {
					errorWaiters.delete(sentinel);
					waiter();
					return;
				}
			}
		},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve() },
		syncRunningSubagentBadge: () => {},
		showHookSelector: (
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: InteractiveSelectorDialogOptions,
		): Promise<string | undefined> => presentStub({ kind: "select", title, options, dialogOptions }),
		showHookEditor: (
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> => presentStub({ kind: "editor", title, prefill, dialogOptions }),
	} as unknown as InteractiveModeContext;

	const guest = new CollabGuestLink(ctx);
	await guest.join(link);

	return {
		guest,
		hostSocket,
		dialogLog,
		uiResponses,
		nextDialog,
		nextUiResponse,
		barrier,
		sendWelcome,
		cleanup: async () => {
			await guest.leave("test cleanup").catch(() => {});
			hostSocket.close();
		},
	};
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

const harnessCleanups: (() => Promise<void>)[] = [];
let writeSpy: { mockRestore(): void } | null = null;

beforeEach(() => {
	activeRelay = new InMemoryRelay();
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
});

afterEach(async () => {
	for (const cleanup of harnessCleanups.splice(0).reverse()) await cleanup();
	writeSpy?.mockRestore();
	writeSpy = null;
	globalThis.WebSocket = RealWebSocket;
	activeRelay = null;
});

async function openHarness(opts?: { readOnly?: boolean }): Promise<GuestUiHarness> {
	const harness = await makeHarness(opts);
	harnessCleanups.push(harness.cleanup);
	return harness;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("collab TUI guest ui-request handling (#4049)", () => {
	it("presents a select ui-request through the hook selector and round-trips the answer", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: {
				reqId: 1,
				kind: "select",
				title: "Deploy?",
				options: ["Yes", { label: "No", description: "abort the deploy" }],
				initialIndex: 1,
				selectionMarker: "radio",
				checkedIndices: [0],
				markableCount: 2,
				helpText: "pick one",
			},
		});

		const dialog = await h.nextDialog();
		expect(dialog.kind).toBe("select");
		expect(dialog.title).toBe("Deploy?");
		expect(dialog.options).toEqual(["Yes", { label: "No", description: "abort the deploy" }]);
		expect(dialog.dialogOptions?.initialIndex).toBe(1);
		expect(dialog.dialogOptions?.selectionMarker).toBe("radio");
		expect(dialog.dialogOptions?.checkedIndices).toEqual([0]);
		expect(dialog.dialogOptions?.markableCount).toBe(2);
		expect(dialog.dialogOptions?.helpText).toBe("pick one");

		dialog.settle("Yes");
		expect(await h.nextUiResponse()).toEqual({ reqId: 1, value: "Yes" });
	});

	it("presents an editor ui-request and sends an explicit cancel as ui-response without a value", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 2, kind: "editor", title: "Edit the prompt", prefill: "draft text" },
		});

		const dialog = await h.nextDialog();
		expect(dialog.kind).toBe("editor");
		expect(dialog.title).toBe("Edit the prompt");
		expect(dialog.prefill).toBe("draft text");

		dialog.settle(undefined); // user cancelled (escape) — must still answer, like web's Cancel
		const response = await h.nextUiResponse();
		expect(response.reqId).toBe(2);
		expect(response.value).toBeUndefined();
	});

	it("dismisses the presentation on ui-request-end and never responds for the ended request", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 3, kind: "select", title: "Answered elsewhere", options: ["A"] },
		});
		const dialog = await h.nextDialog();
		expect(dialog.aborted).toBe(false);

		h.hostSocket.send({ t: "ui-request-end", reqId: 3 });
		await dialog.whenAborted;
		expect(dialog.aborted).toBe(true);

		// A late settle on the dismissed dialog must also stay silent.
		dialog.settle("A");

		// Prove silence via wire ordering: a fresh request's response is the
		// first and only ui-response the host ever receives.
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 4, kind: "select", title: "Next", options: ["B"] },
		});
		const next = await h.nextDialog();
		next.settle("B");
		expect(await h.nextUiResponse()).toEqual({ reqId: 4, value: "B" });
		expect(h.uiResponses).toEqual([{ reqId: 4, value: "B" }]);
	});

	it("clears stale presentations on resync and answers the replayed request exactly once", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 7, kind: "select", title: "Pending ask", options: ["Go"] },
		});
		const first = await h.nextDialog();

		// Resync: the host re-welcomes and replays every still-pending request
		// (mirrors CollabHost.#handleHello for writable peers).
		h.sendWelcome();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 7, kind: "select", title: "Pending ask", options: ["Go"] },
		});

		await first.whenAborted; // stale presentation dismissed by the resync
		const replay = await h.nextDialog();
		expect(replay.title).toBe("Pending ask");
		expect(replay.aborted).toBe(false);

		replay.settle("Go");
		expect(await h.nextUiResponse()).toEqual({ reqId: 7, value: "Go" });
		expect(h.uiResponses).toEqual([{ reqId: 7, value: "Go" }]);
	});

	it("dismisses a pending presentation on leave without responding", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 9, kind: "editor", title: "Still open" },
		});
		const dialog = await h.nextDialog();

		await h.guest.leave("user left");
		await dialog.whenAborted;
		expect(dialog.aborted).toBe(true);
		// Socket detached on leave and the identity check already failed: no
		// response was recorded for the dismissed ask.
		expect(h.uiResponses).toEqual([]);
	});

	it("never presents ui-requests on a read-only link", async () => {
		const h = await openHarness({ readOnly: true });
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 11, kind: "select", title: "Should not show", options: ["X"] },
		});

		await h.barrier(); // frames apply in order: the ui-request has fully applied
		expect(h.dialogLog).toHaveLength(0);
		expect(h.uiResponses).toEqual([]);
	});
});

// ── Proto handshake (#4049: ui-request frames require COLLAB_PROTO >= 3) ───
//
// The ui-request/ui-response grammar shipped without a proto bump, so v2
// guests joined fine and silently dropped host asks. These tests pin the
// enforcement: a real CollabHost must reject stale-proto hellos with an
// observable error frame (never a welcome), current-proto guests must still
// complete a full ui-request round trip, and a rejected CollabGuestLink
// join must fail fast with the host's reason instead of hanging until the
// welcome timeout.

/** Minimal InteractiveModeContext double: only the members CollabHost touches. */
function makeHostContext(): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-proto",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-proto", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "proto test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

/** Raw wire-speaking guest with a configurable hello proto. */
async function joinRawGuest(
	link: string,
	proto: number,
): Promise<{ socket: CollabSocket; nextFrame(): Promise<CollabFrame> }> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	// Directed welcome/error/ui frames only: the host's debounced broadcasts
	// (state/agents/entry/event/bus) and the snapshot-chunk train interleave
	// nondeterministically with the frames these tests assert on.
	const filtered: Record<string, true> = {
		state: true,
		agents: true,
		entry: true,
		event: true,
		bus: true,
		"snapshot-chunk": true,
	};
	socket.onFrame = frame => {
		if (filtered[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto, name: `guest-v${proto}`, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

describe("collab proto handshake (#4049)", () => {
	it("host rejects a stale-proto hello with a protocol-mismatch error and never welcomes or admits the guest", async () => {
		const host = new CollabHost(makeHostContext());
		await host.start("ws://localhost:8787");
		const guest = await joinRawGuest(host.link, COLLAB_PROTO - 1);
		try {
			const reply = await guest.nextFrame();
			if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
			expect(reply.message).toContain("protocol mismatch");
			expect(reply.message).toContain(`host speaks v${COLLAB_PROTO}`);
			expect(reply.message).toContain(`guest sent v${COLLAB_PROTO - 1}`);
			// The rejected guest was never admitted: no participant entry, and a
			// host ask finds no writable peer to route to.
			expect(host.participants.filter(p => p.role !== "host")).toEqual([]);
			expect(host.requestGuestUi({ kind: "select", title: "anyone?", options: ["Yes"] })).toBeNull();
		} finally {
			guest.socket.close();
			await host.stop("test done");
		}
	});

	it("welcomes a current-proto guest at v3 and round-trips a ui-request", async () => {
		const host = new CollabHost(makeHostContext());
		await host.start("ws://localhost:8787");
		const guest = await joinRawGuest(host.link, COLLAB_PROTO);
		try {
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
			expect(welcome.proto).toBe(COLLAB_PROTO);
			expect(welcome.proto).toBe(3);

			const pending = host.requestGuestUi({ kind: "select", title: "Continue?", options: ["Yes"] });
			if (!pending) throw new Error("expected writable guest UI request");
			const request = await guest.nextFrame();
			if (request.t !== "ui-request") throw new Error(`expected ui-request, got ${request.t}`);
			guest.socket.send({ t: "ui-response", reqId: request.request.reqId, value: "Yes" });
			expect(await pending).toBe("Yes");
		} finally {
			guest.socket.close();
			await host.stop("test done");
		}
	});

	it("CollabGuestLink.join fails fast with the host's rejection message instead of hanging for the welcome", async () => {
		// Scripted host that rejects every hello the way CollabHost does for a
		// proto mismatch. The real guest must surface that message from join().
		const roomId = "proto-reject-room";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") {
				hostSocket.send({
					t: "error",
					message: `protocol mismatch: host speaks v${COLLAB_PROTO + 1}, guest sent v${frame.proto}`,
				});
			}
		};
		hostSocket.connect();
		await hostOpen.promise;

		const ctx = {
			settings: { get: () => "" },
			sessionManager: { getSessionFile: () => null },
		} as unknown as InteractiveModeContext;
		const guest = new CollabGuestLink(ctx);
		try {
			await expect(guest.join(link)).rejects.toThrow(/protocol mismatch/);
		} finally {
			hostSocket.close();
		}
	});
});
