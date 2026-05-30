import { describe, expect, it } from "bun:test";
import {
	normalizeTinyModelDevice,
	resolveTinyModelDevicePreference,
	tinyModelDeviceLoadOrder,
	type TinyModelDevice,
} from "../src/tiny/device";

function expectedDefaultDevice(): TinyModelDevice {
	if (process.platform === "win32") return "dml";
	if (process.platform === "linux" && process.arch === "x64") return "cuda";
	return "cpu";
}

describe("tiny model device selection", () => {
	it("defaults to the worker-safe accelerated provider for the platform", () => {
		const preference = resolveTinyModelDevicePreference(undefined);
		const expected = expectedDefaultDevice();

		const expectedOrder: readonly TinyModelDevice[] = expected === "cpu" ? ["cpu"] : [expected, "cpu"];
		expect(preference.device).toBe(expected);
		expect(tinyModelDeviceLoadOrder(preference)).toEqual(expectedOrder);
	});

	it("accepts metal as a WebGPU alias without enabling unsafe macOS worker teardown", () => {
		const expectedOrder: readonly TinyModelDevice[] = process.platform === "darwin" ? ["cpu"] : ["webgpu", "cpu"];

		expect(normalizeTinyModelDevice("metal")).toBe("webgpu");
		expect(tinyModelDeviceLoadOrder(resolveTinyModelDevicePreference("metal"))).toEqual(expectedOrder);
	});

	it("keeps explicit CPU runs CPU-only", () => {
		const preference = resolveTinyModelDevicePreference(" cpu ");

		expect(preference.device).toBe("cpu");
		expect(tinyModelDeviceLoadOrder(preference)).toEqual(["cpu"]);
	});

	it("rejects unknown ONNX execution providers", () => {
		expect(() => resolveTinyModelDevicePreference("neural-magic")).toThrow("Unsupported PI_TINY_DEVICE");
	});
});
