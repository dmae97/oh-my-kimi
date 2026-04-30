/**
 * Module load timing via Bun.plugin.
 *
 * When `PI_TIMING` is set, this module installs a Bun plugin that measures the
 * file-read step of every TS/JS module load and records it as a span in the
 * hierarchical timing tree (see {@link logger.printTimings}).
 *
 * The plugin's onLoad handler runs in the importing code's async context, so
 * each module-load span is attached to whichever {@link logger.time} span was
 * active when the import was resolved. Modules loaded before any explicit
 * `time()` span (i.e. the static-import phase at startup) attach to the root.
 *
 * **Coverage:** the plugin only sees imports made after pi-utils is fully loaded
 * (i.e. after this file finishes evaluating). Pi-utils's own modules and Bun
 * built-ins are not covered. Everything in the application tree is.
 *
 * **What's measured:** time from `onLoad` invocation to handing transpilable
 * source back to Bun. That captures filesystem read latency and any pre-transpile
 * cost. Bun's internal transpile/evaluate steps run after we return and are not
 * separately timed by this plugin.
 */
import { plugin } from "bun";
import { recordModuleLoadSpan, startTiming } from "./logger";

// Restrict to TS/TSX only. node_modules ships CommonJS `.js`/`.cjs` that Bun
// auto-detects when loaded via its default path; if we intercept and return
// `{ contents, loader: "js" }`, Bun forces ESM and CJS modules fail to load
// (e.g. `Missing 'default' export`). Our own source tree (where the
// interesting timing lives) is uniformly TypeScript, so a TS-only filter is
// both safe and sufficient.
const MODULE_LOADER_FILTER = /\.[mc]?tsx?$/;

function loaderFor(path: string): "ts" | "tsx" {
	if (path.endsWith(".tsx")) return "tsx";
	return "ts";
}

if (process.env.PI_TIMING) {
	// Seed the root span before installing the plugin so any synchronous import
	// chain triggered by this module's evaluation can already attach load spans.
	startTiming();

	plugin({
		name: "pi-module-load-timer",
		setup(build) {
			build.onLoad({ filter: MODULE_LOADER_FILTER }, async args => {
				const start = performance.now();
				const contents = await Bun.file(args.path).text();
				const duration = performance.now() - start;
				recordModuleLoadSpan(args.path, start, duration);
				return { contents, loader: loaderFor(args.path) };
			});
		},
	});
}
