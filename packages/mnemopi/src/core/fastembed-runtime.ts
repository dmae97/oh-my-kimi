import { createRequire } from "node:module";
import * as path from "node:path";
import {
	ensureRuntimeInstalled,
	getFastembedRuntimeDir,
	installRuntimeModuleResolver,
	logger,
	type RuntimeInstallSpec,
	resolveRuntimeModule,
} from "@oh-my-pi/pi-utils";
import type * as Fastembed from "fastembed";
import packageManifest from "../../package.json" with { type: "json" };

type FastembedModule = typeof Fastembed;

/** Runtime install inputs for the optional fastembed embedding stack. */
export interface FastembedRuntimeInstallPlan {
	/** Cache directory key; changes when runtime resolution policy changes. */
	versionKey: string;
	/** Dependency graph written to the runtime cache package manifest. */
	install: RuntimeInstallSpec;
}

/**
 * `fastembed` and `onnxruntime-node` are optional peers (~270MB of native
 * assets across platforms), never bundled and never installed eagerly. When
 * the direct import cannot resolve — bundled `dist/cli.js`, compiled binary,
 * a consumer that skipped the optional peers, or a native loader failure from
 * fastembed's nested ORT — the pinned pair is `bun install`ed into a
 * per-version runtime cache on first use and loaded from there (#2389, #2920).
 *
 * The pins live in `peerDependencies` as exact versions (not `catalog:`) so
 * this module reads concrete specs even when the workspace manifest is
 * inlined into a bundle; a workspace test asserts they match the catalog.
 */
const FASTEMBED_SPEC = packageManifest.peerDependencies.fastembed;
const ORT_SPEC = packageManifest.peerDependencies["onnxruntime-node"];

/** Build the deterministic fastembed runtime install plan used by local embeddings. */
export function fastembedRuntimeInstallPlan(): FastembedRuntimeInstallPlan {
	return {
		versionKey: `fastembed-${FASTEMBED_SPEC}_ort-${ORT_SPEC}_forced-ort`.replace(/[^A-Za-z0-9._-]/g, "_"),
		install: {
			dependencies: { fastembed: FASTEMBED_SPEC, "onnxruntime-node": ORT_SPEC },
			overrides: { "onnxruntime-common": ORT_SPEC, "onnxruntime-node": ORT_SPEC },
		},
	};
}
let fastembedLoad: Promise<FastembedModule> | null = null;

export function loadFastembed(): Promise<FastembedModule> {
	fastembedLoad ??= loadFastembedOnce().catch(error => {
		fastembedLoad = null;
		throw error;
	});
	return fastembedLoad;
}

async function loadFastembedOnce(): Promise<FastembedModule> {
	// Dynamic imports: both packages are optional peers that eagerly load
	// native addons and may be absent at runtime — a static import would load
	// the addon at module-init and crash every consumer without the peers.
	try {
		// Preload the pinned ORT before fastembed's nested ORT — only on Windows,
		// where loading the older binding first triggers a DLL-reuse crash.
		if (process.platform === "win32") {
			await import("onnxruntime-node");
		}
		return await import("fastembed");
	} catch (error) {
		if (!isRecoverableFastembedLoadError(error)) throw error;
		logger.debug("mnemopi: fastembed not loadable, using on-demand runtime install", {
			error: String(error),
		});
		return loadFromRuntimeInstall();
	}
}

async function loadFromRuntimeInstall(): Promise<FastembedModule> {
	const plan = fastembedRuntimeInstallPlan();
	const runtimeDir = await ensureRuntimeInstalled({
		runtimeDir: path.join(getFastembedRuntimeDir(), plan.versionKey),
		install: plan.install,
		probePackage: "fastembed",
	});
	const nodeModules = path.join(runtimeDir, "node_modules");
	// The compiled-binary resolver ignores `main`/`exports` for real-FS bare
	// specifiers (Bun #1763); route the runtime graph's requires (fastembed →
	// onnxruntime-node, @anush008/tokenizers → platform binding, …) through
	// the runtime cache.
	installRuntimeModuleResolver({ runtimeNodeModules: nodeModules });
	if (process.platform === "win32") {
		const ortEntry = resolveRuntimeModule(nodeModules, "onnxruntime-node");
		if (ortEntry) createRequire(ortEntry)(ortEntry);
	}
	const entry = resolveRuntimeModule(nodeModules, "fastembed");
	if (!entry) throw new Error(`fastembed runtime install at ${runtimeDir} has no loadable entry`);
	const requireRuntime = createRequire(entry);
	return requireRuntime(entry) as FastembedModule;
}

function isRecoverableFastembedLoadError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
	if (name === "ResolveMessage") return true;
	if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || code === "ERR_DLOPEN_FAILED") return true;
	return typeof message === "string" && /cannot find (module|package)/i.test(message);
}
