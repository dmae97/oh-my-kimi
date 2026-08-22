import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	captureHostResourceSnapshot,
	computeHostResourceSnapshotDigest,
	effectiveAvailableMemoryBytes,
	HOST_RESOURCE_SNAPSHOT_VERSION,
	type HostResourceProbeIo,
	type HostResourceSnapshot,
} from "../src/core/host-resource-snapshot.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Fully healthy probe fixture; overrides model individual probe faults. */
function healthyIo(overrides: Partial<HostResourceProbeIo> = {}): Partial<HostResourceProbeIo> {
	return {
		platform: () => "linux",
		arch: () => "x64",
		cpuCount: () => 8,
		availableMemory: () => 2 * GIB,
		constrainedMemory: () => 4 * GIB,
		totalmem: () => 16 * GIB,
		freemem: () => 3 * GIB,
		rssBytes: () => 200 * MIB,
		heapStatistics: () => ({ heapUsedBytes: 100 * MIB, heapLimitBytes: 4 * GIB }),
		statfs: async () => ({ bavail: 1000n, bsize: 4096n }),
		sampleSystemCpuPercent: async () => 42.5,
		osRelease: () => "6.8.0-generic",
		fileExists: () => false,
		...overrides,
	};
}

function throwingIo(): Partial<HostResourceProbeIo> {
	const boom = () => {
		throw new Error("probe failure");
	};
	return {
		platform: boom,
		arch: boom,
		cpuCount: boom,
		availableMemory: boom,
		constrainedMemory: boom,
		totalmem: boom,
		freemem: boom,
		rssBytes: boom,
		heapStatistics: boom,
		statfs: async () => boom(),
		sampleSystemCpuPercent: async () => boom(),
		osRelease: boom,
		fileExists: boom,
	};
}

describe("captureHostResourceSnapshot", () => {
	it("captures a fully populated snapshot with no diagnostics on a healthy host", async () => {
		const snapshot = await captureHostResourceSnapshot({
			io: healthyIo(),
			now: () => new Date("2026-08-21T01:02:03.000Z"),
		});
		expect(snapshot.schemaVersion).toBe(HOST_RESOURCE_SNAPSHOT_VERSION);
		expect(snapshot.observedAt).toBe("2026-08-21T01:02:03.000Z");
		expect(snapshot.platform).toBe("linux");
		expect(snapshot.arch).toBe("x64");
		expect(snapshot.logicalCpuCount).toBe(8);
		expect(snapshot.processAvailableMemoryBytes).toBe(2 * GIB);
		expect(snapshot.constrainedMemoryBytes).toBe(4 * GIB);
		expect(snapshot.hostTotalMemoryBytes).toBe(16 * GIB);
		expect(snapshot.hostFreeMemoryBytes).toBe(3 * GIB);
		expect(snapshot.processRssBytes).toBe(200 * MIB);
		expect(snapshot.heapUsedBytes).toBe(100 * MIB);
		expect(snapshot.heapLimitBytes).toBe(4 * GIB);
		expect(snapshot.systemCpuPercent).toBe(42.5);
		expect(snapshot.workspaceAvailableBytes).toBe(1000 * 4096);
		expect(snapshot.environment).toBe("native");
		expect(snapshot.diagnostics).toEqual([]);
	});

	it("computes workspace bytes from bavail * bsize and clamps BigInt overflow (§6.5)", async () => {
		const overflow = await captureHostResourceSnapshot({
			io: healthyIo({ statfs: async () => ({ bavail: 2n ** 62n, bsize: 2n ** 20n }) }),
		});
		expect(overflow.workspaceAvailableBytes).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("degrades a rejecting disk probe to null plus a bounded diagnostic", async () => {
		const snapshot = await captureHostResourceSnapshot({
			io: healthyIo({
				statfs: async () => {
					throw new Error("EACCES: /very/private/path");
				},
			}),
		});
		expect(snapshot.workspaceAvailableBytes).toBeNull();
		expect(snapshot.diagnostics).toContain("probe.disk.unavailable");
		// Bounded codes only: probe error text (which may carry paths) is never recorded.
		expect(JSON.stringify(snapshot)).not.toContain("private");
	});

	it("times out a hanging disk probe within the preflight deadline (§6.3)", async () => {
		const startedAt = Date.now();
		const snapshot = await captureHostResourceSnapshot({
			maxProbeMs: 60,
			io: healthyIo({ statfs: () => new Promise(() => {}) }),
		});
		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(snapshot.workspaceAvailableBytes).toBeNull();
		expect(snapshot.diagnostics).toContain("probe.disk.timeout");
	});

	it("times out a hanging CPU probe and records probe.cpu.timeout", async () => {
		const snapshot = await captureHostResourceSnapshot({
			maxProbeMs: 60,
			io: healthyIo({ sampleSystemCpuPercent: () => new Promise(() => {}) }),
		});
		expect(snapshot.systemCpuPercent).toBeNull();
		expect(snapshot.diagnostics).toContain("probe.cpu.timeout");
	});

	it("records an unavailable CPU sample and clamps out-of-range samples", async () => {
		const unavailable = await captureHostResourceSnapshot({
			io: healthyIo({ sampleSystemCpuPercent: async () => null }),
		});
		expect(unavailable.systemCpuPercent).toBeNull();
		expect(unavailable.diagnostics).toContain("probe.cpu.unavailable");

		const outOfRange = await captureHostResourceSnapshot({
			io: healthyIo({ sampleSystemCpuPercent: async () => 250 }),
		});
		expect(outOfRange.systemCpuPercent).toBe(100);
	});

	it("treats non-positive memory readings as unavailable (constrainedMemory() 0 means unknown)", async () => {
		const snapshot = await captureHostResourceSnapshot({
			io: healthyIo({ constrainedMemory: () => 0, availableMemory: () => Number.NaN }),
		});
		expect(snapshot.constrainedMemoryBytes).toBeNull();
		expect(snapshot.processAvailableMemoryBytes).toBeNull();
		expect(snapshot.diagnostics).toContain("probe.constrained-memory.unavailable");
		expect(snapshot.diagnostics).toContain("probe.available-memory.unavailable");
	});

	it("treats no-limit sentinels above MAX_SAFE_INTEGER as unavailable (WSL cgroup 2^64 fixture, §6.4)", async () => {
		const snapshot = await captureHostResourceSnapshot({
			io: healthyIo({ constrainedMemory: () => 2 ** 64 }),
		});
		expect(snapshot.constrainedMemoryBytes).toBeNull();
		expect(snapshot.diagnostics).toContain("probe.constrained-memory.unavailable");
		// The sentinel never enters the §6.4 min-of-known candidate set.
		expect(effectiveAvailableMemoryBytes(snapshot)).toBe(2 * GIB);
	});

	it("never rejects even when every probe source throws (§23.2 property 6)", async () => {
		const snapshot = await captureHostResourceSnapshot({ io: throwingIo(), maxProbeMs: 60 });
		expect(snapshot.schemaVersion).toBe(HOST_RESOURCE_SNAPSHOT_VERSION);
		expect(snapshot.processAvailableMemoryBytes).toBeNull();
		expect(snapshot.constrainedMemoryBytes).toBeNull();
		expect(snapshot.hostTotalMemoryBytes).toBeNull();
		expect(snapshot.hostFreeMemoryBytes).toBeNull();
		expect(snapshot.workspaceAvailableBytes).toBeNull();
		expect(snapshot.systemCpuPercent).toBeNull();
		expect(snapshot.processRssBytes).toBe(0);
		expect(snapshot.heapUsedBytes).toBe(0);
		expect(snapshot.heapLimitBytes).toBe(0);
		expect(snapshot.environment).toBe("unknown");
		expect(snapshot.logicalCpuCount).toBeGreaterThanOrEqual(1);
		expect(snapshot.diagnostics.length).toBeGreaterThan(0);
	});

	it("never rejects for any random subset of throwing probes (seeded property, §23.2 property 6)", async () => {
		const random = mulberry32(0x0fc52026);
		const faultKeys = Object.keys(throwingIo()) as ReadonlyArray<keyof HostResourceProbeIo>;
		for (let iteration = 0; iteration < 40; iteration++) {
			const faulty = throwingIo();
			const io: Partial<HostResourceProbeIo> = { ...healthyIo() };
			for (const key of faultKeys) {
				if (random() < 0.4) {
					(io as Record<string, unknown>)[key] = faulty[key];
				}
			}
			const snapshot = await captureHostResourceSnapshot({ io, maxProbeMs: 60 });
			expect(snapshot.schemaVersion).toBe(HOST_RESOURCE_SNAPSHOT_VERSION);
		}
	});

	it("detects WSL and container environments as hints only", async () => {
		const wsl = await captureHostResourceSnapshot({
			io: healthyIo({ osRelease: () => "5.15.167.4-microsoft-standard-WSL2" }),
		});
		expect(wsl.environment).toBe("wsl");

		const container = await captureHostResourceSnapshot({
			io: healthyIo({ fileExists: (target) => target === "/.dockerenv" }),
		});
		expect(container.environment).toBe("container");

		const windows = await captureHostResourceSnapshot({
			io: healthyIo({ platform: () => "win32" }),
		});
		expect(windows.environment).toBe("native");
	});

	it("keeps the privacy boundary: no cwd, hostname, or username in the snapshot (§6.2)", async () => {
		const cwd = "/home/secret-user/very-private-project";
		let probedPath: string | null = null;
		const snapshot = await captureHostResourceSnapshot({
			cwd,
			io: healthyIo({
				statfs: async (target) => {
					probedPath = target;
					return { bavail: 10n, bsize: 4096n };
				},
			}),
		});
		expect(probedPath).toBe(cwd);
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("secret-user");
		expect(serialized).not.toContain("very-private-project");
		const hostname = os.hostname();
		if (hostname.length >= 4) {
			expect(serialized).not.toContain(hostname);
		}
		const username = os.userInfo().username;
		if (username.length >= 4) {
			expect(serialized).not.toContain(username);
		}
		expect(Object.keys(snapshot).sort()).toEqual(
			[
				"schemaVersion",
				"observedAt",
				"platform",
				"arch",
				"logicalCpuCount",
				"processAvailableMemoryBytes",
				"constrainedMemoryBytes",
				"hostTotalMemoryBytes",
				"hostFreeMemoryBytes",
				"processRssBytes",
				"heapUsedBytes",
				"heapLimitBytes",
				"systemCpuPercent",
				"workspaceAvailableBytes",
				"environment",
				"diagnostics",
			].sort(),
		);
	});

	it("settles an awaited probe that is the only pending work in a bare process", () => {
		// Regression lock: probe timers must stay ref'd while awaited. With
		// unref'd timers, a headless `node` process awaiting one probe (the
		// doctor CLI shape) exits with an unsettled top-level await instead of
		// settling the timeout path.
		const moduleUrl = new URL("../src/core/host-resource-snapshot.ts", import.meta.url);
		const script = [
			`import { captureHostResourceSnapshot } from ${JSON.stringify(moduleUrl.href)};`,
			"const snapshot = await captureHostResourceSnapshot({",
			"\tmaxProbeMs: 80,",
			"\tio: { statfs: () => new Promise(() => {}), sampleSystemCpuPercent: () => new Promise(() => {}) },",
			"});",
			"console.log(JSON.stringify({ settled: true, diagnostics: snapshot.diagnostics }));",
		].join("\n");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omk-probe-settle-"));
		const scriptPath = path.join(dir, "probe-settle.mts");
		try {
			fs.writeFileSync(scriptPath, script);
			const stdout = execFileSync(process.execPath, ["--no-warnings", scriptPath], {
				encoding: "utf8",
				timeout: 15_000,
				cwd: path.dirname(fileURLToPath(moduleUrl)),
			});
			let result: { settled: boolean; diagnostics: string[] };
			try {
				result = JSON.parse(stdout.trim()) as { settled: boolean; diagnostics: string[] };
			} catch (error) {
				throw new Error(`probe child emitted invalid JSON: ${stdout.slice(0, 200)} (${String(error)})`);
			}
			expect(result.settled).toBe(true);
			expect(result.diagnostics).toContain("probe.disk.timeout");
			expect(result.diagnostics).toContain("probe.cpu.timeout");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("captures real host values without throwing (integration smoke)", async () => {
		const snapshot = await captureHostResourceSnapshot({ maxProbeMs: 300 });
		expect(snapshot.schemaVersion).toBe(HOST_RESOURCE_SNAPSHOT_VERSION);
		expect(snapshot.logicalCpuCount).toBeGreaterThanOrEqual(1);
		expect(snapshot.processRssBytes).toBeGreaterThan(0);
	});
});

describe("effectiveAvailableMemoryBytes", () => {
	it("returns the minimum known positive candidate (§6.4)", async () => {
		const snapshot = await captureHostResourceSnapshot({
			io: healthyIo({
				availableMemory: () => 2 * GIB,
				constrainedMemory: () => 1 * GIB,
				freemem: () => 3 * GIB,
			}),
		});
		expect(effectiveAvailableMemoryBytes(snapshot)).toBe(1 * GIB);
	});

	it("ignores unknown candidates and returns null when none is known", async () => {
		const partial = await captureHostResourceSnapshot({
			io: healthyIo({ availableMemory: () => null, constrainedMemory: () => 0, freemem: () => 3 * GIB }),
		});
		expect(effectiveAvailableMemoryBytes(partial)).toBe(3 * GIB);

		const unknown = await captureHostResourceSnapshot({
			io: healthyIo({
				availableMemory: () => null,
				constrainedMemory: () => 0,
				freemem: () => {
					throw new Error("freemem unavailable");
				},
			}),
		});
		expect(effectiveAvailableMemoryBytes(unknown)).toBeNull();
	});
});

describe("computeHostResourceSnapshotDigest", () => {
	it("is stable for identical snapshots and sensitive to field changes", async () => {
		const now = () => new Date("2026-08-21T01:02:03.000Z");
		const first = await captureHostResourceSnapshot({ io: healthyIo(), now });
		const second = await captureHostResourceSnapshot({ io: healthyIo(), now });
		expect(computeHostResourceSnapshotDigest(first)).toBe(computeHostResourceSnapshotDigest(second));

		const changed: HostResourceSnapshot = { ...first, hostFreeMemoryBytes: 1 * GIB };
		expect(computeHostResourceSnapshotDigest(changed)).not.toBe(computeHostResourceSnapshotDigest(first));
		expect(computeHostResourceSnapshotDigest(first)).toMatch(/^[0-9a-f]{64}$/);
	});
});

/** Deterministic PRNG for the seeded fault-injection property (§23.2 fixed seed). */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
