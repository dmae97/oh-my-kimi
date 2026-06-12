import { describe, expect, it } from "bun:test";
import { generateRoomKey, importRoomKey, open, seal } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import {
	type CollabFrame,
	DEFAULT_RELAY_URL,
	formatCollabLink,
	generateRoomId,
	packEnvelope,
	parseCollabLink,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";

describe("collab crypto", () => {
	it("round-trips a frame through seal/open", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame: CollabFrame = { t: "prompt", text: "check bun.lock — and ünïcode 🚀" };
		const sealed = await seal(key, frame);
		expect(await open(key, sealed)).toEqual(frame);
	});

	it("rejects tampered ciphertext", async () => {
		const key = await importRoomKey(generateRoomKey());
		const sealed = await seal(key, { t: "abort" });
		sealed[sealed.length - 1]! ^= 0xff;
		expect(open(key, sealed)).rejects.toThrow();
	});

	it("rejects frames sealed with a different key", async () => {
		const sealed = await seal(await importRoomKey(generateRoomKey()), { t: "abort" });
		const otherKey = await importRoomKey(generateRoomKey());
		expect(open(otherKey, sealed)).rejects.toThrow();
	});
});

describe("collab link format", () => {
	const key = generateRoomKey();
	const roomId = generateRoomId();

	it("collapses the default relay to a bare roomId#key link", () => {
		const link = formatCollabLink(DEFAULT_RELAY_URL, roomId, key);
		expect(link).toBe(`${roomId}#${Buffer.from(key).toString("base64url")}`);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`${DEFAULT_RELAY_URL}/r/${roomId}`);
		expect(parsed.roomId).toBe(roomId);
		expect(parsed.key).toEqual(key);
	});

	it("drops the wss scheme for custom relays and infers it on parse", () => {
		const link = formatCollabLink("wss://relay.example.com:8443", roomId, key);
		expect(link.startsWith("relay.example.com:8443/r/")).toBe(true);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com:8443/r/${roomId}`);
	});

	it("keeps full ws:// URLs for localhost relays", () => {
		const link = formatCollabLink("ws://localhost:7475", roomId, key);
		expect(link.startsWith("ws://localhost:7475/r/")).toBe(true);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`ws://localhost:7475/r/${roomId}`);
	});

	it("rewrites https relay URLs to wss", () => {
		const parsed = parseCollabLink(`https://relay.example.com/r/${roomId}#${Buffer.from(key).toString("base64url")}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com/r/${roomId}`);
	});

	it("rejects plain ws:// for non-localhost hosts", () => {
		const parsed = parseCollabLink(`ws://relay.example.com/r/${roomId}#${Buffer.from(key).toString("base64url")}`);
		expect("error" in parsed && parsed.error.includes("wss://")).toBe(true);
	});

	it("rejects keys that are not 32 base64url bytes", () => {
		expect("error" in parseCollabLink(`${roomId}#dG9vc2hvcnQ`)).toBe(true);
		expect("error" in parseCollabLink(`${roomId}#not+base64url/`)).toBe(true);
	});
});

describe("collab wire envelope", () => {
	it("round-trips peer id and payload", () => {
		const payload = new Uint8Array([1, 2, 3, 250]);
		const packed = packEnvelope(0xdeadbeef, payload);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked?.peerId).toBe(0xdeadbeef);
		expect(unpacked?.payload).toEqual(payload);
	});

	it("rewrites the peer id in place without touching the payload", () => {
		const packed = packEnvelope(0, new Uint8Array([9, 8, 7]));
		rewriteEnvelopePeer(packed, 42);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked?.peerId).toBe(42);
		expect(unpacked?.payload).toEqual(new Uint8Array([9, 8, 7]));
	});

	it("returns null for frames shorter than the header", () => {
		expect(unpackEnvelope(new Uint8Array([0, 0]))).toBeNull();
	});
});
