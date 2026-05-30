import type { DeviceType } from "@huggingface/transformers";
import { $env } from "@oh-my-pi/pi-utils";

export type TinyModelDevice = DeviceType;

export interface TinyModelDevicePreference {
	device: TinyModelDevice;
	raw: string | undefined;
}

const CPU_DEVICE: TinyModelDevice = "cpu";
const CPU_ONLY_ORDER: readonly TinyModelDevice[] = [CPU_DEVICE];
const DARWIN_WEBGPU_UNSAFE_ORDER: readonly TinyModelDevice[] = [CPU_DEVICE];

const DEVICE_VALUES: Record<TinyModelDevice, true> = {
	auto: true,
	gpu: true,
	cpu: true,
	wasm: true,
	webgpu: true,
	cuda: true,
	dml: true,
	coreml: true,
	webnn: true,
	"webnn-npu": true,
	"webnn-gpu": true,
	"webnn-cpu": true,
};

function defaultTinyModelDevice(): TinyModelDevice {
	if (process.platform === "win32") return "dml";
	if (process.platform === "linux" && process.arch === "x64") return "cuda";
	return CPU_DEVICE;
}

function usesDarwinWorkerWebGpu(device: TinyModelDevice): boolean {
	return process.platform === "darwin" && (device === "gpu" || device === "webgpu" || device === "auto");
}

export function normalizeTinyModelDevice(value: string | undefined): TinyModelDevice | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "metal") return "webgpu";
	if (raw in DEVICE_VALUES) return raw as TinyModelDevice;
	throw new Error(
		`Unsupported PI_TINY_DEVICE=${JSON.stringify(value)}. Use cpu, gpu, metal, webgpu, auto, cuda, dml, coreml, wasm, webnn, webnn-gpu, webnn-cpu, or webnn-npu.`,
	);
}

export function resolveTinyModelDevicePreference(
	value: string | undefined = $env.PI_TINY_DEVICE,
): TinyModelDevicePreference {
	return {
		device: normalizeTinyModelDevice(value) ?? defaultTinyModelDevice(),
		raw: value,
	};
}

export function tinyModelDeviceLoadOrder(preference: TinyModelDevicePreference): readonly TinyModelDevice[] {
	if (preference.device === CPU_DEVICE) return CPU_ONLY_ORDER;
	if (usesDarwinWorkerWebGpu(preference.device)) return DARWIN_WEBGPU_UNSAFE_ORDER;
	return [preference.device, CPU_DEVICE];
}
