import type { DataType } from "@huggingface/transformers";
import { $env } from "@oh-my-pi/pi-utils";

/** ONNX quantization / precision for local tiny models (transformers.js `dtype`). */
export type TinyModelDtype = DataType;

const DTYPE_VALUES: Record<TinyModelDtype, true> = {
	auto: true,
	fp32: true,
	fp16: true,
	q8: true,
	int8: true,
	uint8: true,
	q4: true,
	bnb4: true,
	q4f16: true,
	q2: true,
	q2f16: true,
	q1: true,
	q1f16: true,
};

/**
 * Validate and canonicalize a `PI_TINY_DTYPE` value. Returns `undefined` when
 * unset/blank so callers fall back to the per-model spec dtype, and throws on an
 * unrecognized value so a misconfiguration fails loudly instead of silently
 * loading a different precision than requested.
 */
export function normalizeTinyModelDtype(value: string | undefined): TinyModelDtype | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw in DTYPE_VALUES) return raw as TinyModelDtype;
	throw new Error(
		`Unsupported PI_TINY_DTYPE=${JSON.stringify(value)}. Use auto, fp32, fp16, q8, int8, uint8, q4, bnb4, q4f16, q2, q2f16, q1, or q1f16.`,
	);
}

/**
 * Resolve the `PI_TINY_DTYPE` override. `undefined` means "use the per-model spec
 * dtype" (currently `q4` for every shipped model); a concrete value overrides the
 * precision for whichever local tiny model loads.
 */
export function resolveTinyModelDtypeOverride(
	value: string | undefined = $env.PI_TINY_DTYPE,
): TinyModelDtype | undefined {
	return normalizeTinyModelDtype(value);
}
