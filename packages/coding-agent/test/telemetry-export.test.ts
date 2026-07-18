import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { initTelemetryExport, isTelemetryExportEnabled } from "@oh-my-pi/pi-coding-agent/telemetry-export";

/**
 * Gating contract for the OTLP export bootstrap. These cases all short-circuit
 * before a provider is registered, so they never mutate the module singleton
 * and are order-independent. The positive export path runs in a subprocess (see
 * the "exports spans" test) so the registered global provider can't leak here.
 */
const OTEL_KEYS = [
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	"OTEL_SDK_DISABLED",
	"OTEL_TRACES_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_METRICS_EXPORTER",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(OTEL_KEYS.map(k => [k, process.env[k]]));
	for (const k of OTEL_KEYS) delete process.env[k];
});

afterEach(() => {
	for (const k of OTEL_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("initTelemetryExport gating", () => {
	it("stays disabled when no OTLP endpoint is configured", async () => {
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when OTEL_SDK_DISABLED=true even with an endpoint", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_SDK_DISABLED = "true";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when OTEL_TRACES_EXPORTER=none and only the traces endpoint is set", async () => {
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_TRACES_EXPORTER = "none";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("declines unsupported OTLP protocols instead of misrouting spans", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317";
		process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);

		process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("honors the kill-switches case-insensitively per the OTEL env contract", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_SDK_DISABLED = "TRUE";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);

		delete process.env.OTEL_SDK_DISABLED;
		process.env.OTEL_TRACES_EXPORTER = "otlp,None";
		process.env.OTEL_LOGS_EXPORTER = "none";
		process.env.OTEL_METRICS_EXPORTER = "none";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when every signal exporter is set to none", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_TRACES_EXPORTER = "none";
		process.env.OTEL_LOGS_EXPORTER = "none";
		process.env.OTEL_METRICS_EXPORTER = "none";
		await initTelemetryExport();
		expect(isTelemetryExportEnabled()).toBe(false);
	});
});

describe("initTelemetryExport signals export path", () => {
	it("registers a provider and exports spans to an OTLP/proto receiver", async () => {
		// Run in a subprocess: initTelemetryExport() registers a process-global
		// provider, so exercising the positive path in-process would leak that
		// singleton into every later test. The probe stands up its own loopback
		// receiver and exits 0 only when a protobuf trace export actually lands.
		const probe = fileURLToPath(new URL("./otel-export-probe.ts", import.meta.url));
		const proc = Bun.spawn(["bun", probe], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		expect(stdout).toContain("PROBE: RECEIVED");
		expect(code).toBe(0);
	}, 20_000);

	it("exports log records and metrics to OTLP/proto receivers", async () => {
		// Same subprocess isolation as the trace probe: the logs/metrics probe
		// drives the bridged logger and the agent telemetry metric hooks, then
		// asserts protobuf POSTs landed at both /v1/logs and /v1/metrics.
		const probe = fileURLToPath(new URL("./otel-signals-probe.ts", import.meta.url));
		const proc = Bun.spawn(["bun", probe], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
		expect(stdout).toContain("PROBE: RECEIVED");
		expect(code).toBe(0);
	}, 20_000);
});
