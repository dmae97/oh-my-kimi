/**
 * OTLP trace export bootstrap.
 *
 * oh-my-pi's agent core (`@oh-my-pi/pi-agent-core`) emits OpenTelemetry GenAI
 * spans through the global `@opentelemetry/api` tracer, but only when a
 * TracerProvider is registered in the process — otherwise the API returns a
 * no-op tracer and the spans are silently dropped. The shipped CLI never
 * registered one, so headless / embedded hosts (e.g. an ACP harness that
 * spawns `omp` as a child process) had no way to collect omp's internal traces.
 *
 * This module registers a NodeTracerProvider with an OTLP/proto exporter when
 * the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (or `..._TRACES_ENDPOINT`) env var
 * is set, following the zero-code OTEL env contract: the exporter reads its
 * endpoint, headers, and timeout from `OTEL_EXPORTER_OTLP_*` itself. The
 * consuming process configures the destination entirely through env; omp stays
 * provider-agnostic and ships no vendor coupling. Only the `http/protobuf`
 * transport is supported — an `OTEL_EXPORTER_OTLP*_PROTOCOL` of `grpc` or
 * `http/json` declines rather than misrouting spans.
 *
 * The OTLP/proto exporter on the 2.x line is used deliberately: the 1.x line
 * deadlocks under Bun — its `req.on('close')` handler fires a spurious failure
 * after the success path. `exporter-trace-otlp-proto@0.218` paired with
 * `sdk-trace-base@2.7` exports cleanly on Bun.
 */
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import type * as TraceNode from "@opentelemetry/sdk-trace-node";

/**
 * Periodic flush interval. A long-lived `omp` process (the ACP server is
 * spawned once and reused across many turns) would otherwise hold finished
 * spans until the batch window elapses or the process exits.
 */
const FLUSH_INTERVAL_MS = 30_000;

let provider: TraceNode.NodeTracerProvider | undefined;
let initPromise: Promise<void> | undefined;

/**
 * Whether {@link initTelemetryExport} registered a real provider. The CLI uses
 * this to decide whether to switch on the agent loop's telemetry config — there
 * is no point emitting spans into a no-op tracer.
 */
export function isTelemetryExportEnabled(): boolean {
	return provider !== undefined;
}

/**
 * Register the global TracerProvider + OTLP exporter when an OTLP endpoint is
 * configured via env. Idempotent, and a no-op when no endpoint is set (or when
 * the OTEL kill-switches are engaged), so it is safe to call unconditionally at
 * startup.
 */
export async function initTelemetryExport(): Promise<void> {
	if (provider) return;
	if (initPromise) return initPromise;

	// The OTEL env contract parses booleans and enum lists case-insensitively, so
	// OTEL_SDK_DISABLED=TRUE and OTEL_TRACES_EXPORTER=None must also disable export.
	if (process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;
	if (tracesExporterDisabled(process.env.OTEL_TRACES_EXPORTER)) return;

	const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (!endpoint) return;

	// We only ship the http/protobuf transport (the line validated on Bun). The
	// OTEL contract lets OTEL_EXPORTER_OTLP*_PROTOCOL select grpc / http/json;
	// rather than silently send protobuf-over-HTTP to a grpc :4317 port and lose
	// every span, decline when an unsupported protocol is requested.
	const protocol = (process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL)
		?.trim()
		.toLowerCase();
	if (protocol && protocol !== "http/protobuf") {
		logger.warn(
			`OTEL trace export disabled: OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is unsupported (only http/protobuf)`,
		);
		return;
	}

	initPromise = registerProvider();
	return initPromise;
}

async function registerProvider(): Promise<void> {
	const [
		{ AsyncLocalStorageContextManager },
		{ OTLPTraceExporter },
		{ resourceFromAttributes },
		{ BatchSpanProcessor },
		{ NodeTracerProvider },
	] = await Promise.all([
		import("@opentelemetry/context-async-hooks"),
		import("@opentelemetry/exporter-trace-otlp-proto"),
		import("@opentelemetry/resources"),
		import("@opentelemetry/sdk-trace-base"),
		import("@opentelemetry/sdk-trace-node"),
	]);

	// The exporter reads endpoint/headers/timeout from OTEL_EXPORTER_OTLP_* itself,
	// so there is nothing to thread through here.
	const exporter = new OTLPTraceExporter();
	const tracerProvider = new NodeTracerProvider({
		resource: resourceFromAttributes({
			"service.name": process.env.OTEL_SERVICE_NAME ?? "oh-my-pi",
		}),
		spanProcessors: [new BatchSpanProcessor(exporter)],
	});
	// register() installs the global tracer provider and the W3C trace-context +
	// baggage propagators; the explicit AsyncLocalStorage context manager keeps
	// parent/child span linkage working under Bun.
	tracerProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });
	provider = tracerProvider;

	const flushTimer = setInterval(() => {
		provider?.forceFlush().catch(() => {});
	}, FLUSH_INTERVAL_MS);
	flushTimer.unref();

	// Shut down through postmortem rather than a bare signal listener. postmortem
	// owns SIGINT/SIGTERM/SIGHUP/exit and quit(), and awaits registered cleanups
	// before calling process.exit — so the batch processor's final OTLP export
	// completes instead of being cut off mid-flight on the shutdown path.
	postmortem.register("otel-trace-export", async () => {
		clearInterval(flushTimer);
		await provider?.shutdown();
	});
}

/**
 * Parse the `OTEL_TRACES_EXPORTER` selection. The value is a case-insensitive,
 * comma-separated list; the literal `none` disables span export entirely.
 */
function tracesExporterDisabled(raw: string | undefined): boolean {
	if (!raw) return false;
	return raw.split(",").some(entry => entry.trim().toLowerCase() === "none");
}

/**
 * Flush any buffered spans to the exporter. No-op when export is disabled.
 * Hosts embedding the agent can call this at natural boundaries (e.g. the end
 * of a turn) so traces surface promptly rather than on the batch interval.
 */
export async function flushTelemetryExport(): Promise<void> {
	await provider?.forceFlush();
}
