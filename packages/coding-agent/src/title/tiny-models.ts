export const ONLINE_TINY_TITLE_MODEL_KEY = "online";

export interface TinyTitleLocalModelSpec {
	key: string;
	repo: string;
	dtype: "q4";
	label: string;
	description: string;
	contextNote: string;
}

export const TINY_TITLE_LOCAL_MODELS = [
	{
		key: "lfm2-350m",
		repo: "onnx-community/LFM2-350M-ONNX",
		dtype: "q4",
		label: "LFM2 350M",
		description: "Recommended local model; best speed/quality balance, about 212 MB cached.",
		contextNote: "Best local default from the CPU title-generation spike.",
	},
	{
		key: "qwen3-0.6b",
		repo: "onnx-community/Qwen3-0.6B-ONNX",
		dtype: "q4",
		label: "Qwen3 0.6B",
		description: "Most robust local option; slower first load, about 500 MB cached.",
		contextNote: "Use when title quality matters more than local startup cost.",
	},
	{
		key: "gemma-270m",
		repo: "onnx-community/gemma-3-270m-it-ONNX",
		dtype: "q4",
		label: "Gemma 270M",
		description: "Smallest viable local option; lower quality, lowest cache footprint.",
		contextNote: "Use on constrained machines that still need local titles.",
	},
	{
		key: "qwen2.5-0.5b",
		repo: "onnx-community/Qwen2.5-0.5B-Instruct",
		dtype: "q4",
		label: "Qwen2.5 0.5B",
		description: "Balanced local fallback; moderate quality and cache footprint.",
		contextNote: "Useful when Qwen3 is too heavy but Gemma quality is insufficient.",
	},
	{
		key: "lfm2-700m",
		repo: "onnx-community/LFM2-700M-ONNX",
		dtype: "q4",
		label: "LFM2 700M",
		description: "Highest-quality local option; larger and slower than LFM2 350M.",
		contextNote: "Use when local title quality is preferred over startup cost.",
	},
] as const satisfies readonly TinyTitleLocalModelSpec[];

export const TINY_TITLE_MODEL_VALUES = [
	ONLINE_TINY_TITLE_MODEL_KEY,
	"lfm2-350m",
	"qwen3-0.6b",
	"gemma-270m",
	"qwen2.5-0.5b",
	"lfm2-700m",
] as const;

export type TinyTitleModelKey = (typeof TINY_TITLE_MODEL_VALUES)[number];
export type TinyTitleLocalModelKey = (typeof TINY_TITLE_LOCAL_MODELS)[number]["key"];

type MissingTinyTitleModelValue = Exclude<
	typeof ONLINE_TINY_TITLE_MODEL_KEY | TinyTitleLocalModelKey,
	TinyTitleModelKey
>;
type ExtraTinyTitleModelValue = Exclude<TinyTitleModelKey, typeof ONLINE_TINY_TITLE_MODEL_KEY | TinyTitleLocalModelKey>;
const TINY_TITLE_MODEL_VALUES_MATCH_REGISTRY: MissingTinyTitleModelValue extends never
	? ExtraTinyTitleModelValue extends never
		? true
		: never
	: never = true;
void TINY_TITLE_MODEL_VALUES_MATCH_REGISTRY;

export const TINY_TITLE_MODEL_OPTIONS = [
	{
		value: ONLINE_TINY_TITLE_MODEL_KEY,
		label: "Online (pi/smol)",
		description: "Current online title generation path; no local model download or CPU inference.",
	},
	...TINY_TITLE_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: TinyTitleModelKey; label: string; description: string }>;

export function isTinyTitleLocalModelKey(value: string): value is TinyTitleLocalModelKey {
	return TINY_TITLE_LOCAL_MODELS.some(model => model.key === value);
}

export function getTinyTitleModelSpec(key: TinyTitleLocalModelKey): (typeof TINY_TITLE_LOCAL_MODELS)[number] {
	const spec = TINY_TITLE_LOCAL_MODELS.find(model => model.key === key);
	if (!spec) throw new Error(`Unknown tiny title model: ${key}`);
	return spec;
}
