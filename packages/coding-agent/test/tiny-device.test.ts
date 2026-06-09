import { describe, expect, it } from "bun:test";
import {
	normalizeTinyModelDevice,
	resolveTinyModelDevicePreference,
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
	type TinyModelDevice,
	tinyModelDeviceLoadOrder,
	tinyModelDeviceSettingToEnv,
} from "@oh-my-pi/pi-coding-agent/tiny/device";

describe("tiny model device selection", () => {
	it("defaults to CPU-only inference on every platform", () => {
		const preference = resolveTinyModelDevicePreference(undefined);

		expect(preference.device).toBe("cpu");
		expect(tinyModelDeviceLoadOrder(preference)).toEqual(["cpu"]);
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

describe("tiny model device setting → PI_TINY_DEVICE mapping", () => {
	it("returns undefined for the default sentinel so the worker keeps its CPU default", () => {
		expect(tinyModelDeviceSettingToEnv(TINY_MODEL_DEVICE_DEFAULT)).toBeUndefined();
		expect(tinyModelDeviceSettingToEnv(undefined)).toBeUndefined();
		expect(tinyModelDeviceSettingToEnv("")).toBeUndefined();
	});

	it("forwards a concrete device value verbatim for the worker to validate", () => {
		expect(tinyModelDeviceSettingToEnv("metal")).toBe("metal");
		expect(tinyModelDeviceSettingToEnv("cuda")).toBe("cuda");
	});

	it("keeps submenu options aligned with the accepted values", () => {
		expect(TINY_MODEL_DEVICE_SETTING_OPTIONS.map(option => option.value)).toEqual([
			...TINY_MODEL_DEVICE_SETTING_VALUES,
		]);
	});
});
