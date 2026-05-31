import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { type Api, type AssistantMessage, getBundledModel, type Model } from "@oh-my-pi/pi-ai";
import { isSubcommand } from "../src/cli-commands";
import { getDefault, getEnumValues, getUi } from "../src/config/settings-schema";
import { TinyTitleDownloadProgressComponent } from "../src/modes/components/tiny-title-download-progress";
import { initTheme } from "../src/modes/theme/theme";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "../src/tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "../src/tiny/dtype";
import { ONLINE_TINY_TITLE_MODEL_KEY, TINY_TITLE_MODEL_OPTIONS, TINY_TITLE_MODEL_VALUES } from "../src/tiny/models";
import { tinyTitleClient } from "../src/tiny/title-client";
import { generateSessionTitle, raceFirstNonNull, TITLE_LOCAL_FALLBACK_DELAY_MS } from "../src/utils/title-generator";

async function flushMicrotasks(turns = 4): Promise<void> {
	for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>, tinyModel: string) {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return tinyModel;
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as never;
}

function mockOnlineTitle(title: string | null) {
	return vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "stop",
		content: title
			? [
					{
						type: "toolCall",
						id: "call-title",
						name: "set_title",
						arguments: { title },
					},
				]
			: [{ type: "text", text: "" }],
	} as never);
}

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("raceFirstNonNull", () => {
	it("resolves with local result without starting fallback", async () => {
		let fallbackStarted = false;
		const title = await raceFirstNonNull(
			Promise.resolve("Local Title"),
			() => {
				fallbackStarted = true;
				return Promise.resolve("Online Title");
			},
			TITLE_LOCAL_FALLBACK_DELAY_MS,
		);

		expect(title).toBe("Local Title");
		expect(fallbackStarted).toBe(false);
	});

	it("starts fallback after the hardcoded delay", async () => {
		vi.useFakeTimers();
		const local = Promise.withResolvers<string | null>();
		let fallbackStarted = false;
		const result = raceFirstNonNull(
			local.promise,
			() => {
				fallbackStarted = true;
				return Promise.resolve("Online Title");
			},
			TITLE_LOCAL_FALLBACK_DELAY_MS,
		);

		await flushMicrotasks();
		expect(fallbackStarted).toBe(false);
		vi.advanceTimersByTime(TITLE_LOCAL_FALLBACK_DELAY_MS - 1);
		await flushMicrotasks();
		expect(fallbackStarted).toBe(false);
		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(fallbackStarted).toBe(true);
		await expect(result).resolves.toBe("Online Title");
		local.resolve(null);
	});

	it("starts fallback immediately when local fails", async () => {
		let fallbackStarted = false;
		const title = await raceFirstNonNull(
			Promise.reject(new Error("local failed")),
			() => {
				fallbackStarted = true;
				return Promise.resolve("Online Title");
			},
			TITLE_LOCAL_FALLBACK_DELAY_MS,
		);

		expect(title).toBe("Online Title");
		expect(fallbackStarted).toBe(true);
	});

	it("returns null only after local and fallback return null", async () => {
		const title = await raceFirstNonNull(
			Promise.resolve(null),
			() => Promise.resolve(null),
			TITLE_LOCAL_FALLBACK_DELAY_MS,
		);

		expect(title).toBeNull();
	});

	it("runs the loser-cancel callback when local wins after fallback starts", async () => {
		vi.useFakeTimers();
		const local = Promise.withResolvers<string | null>();
		const fallback = Promise.withResolvers<string | null>();
		let fallbackStarted = false;
		let cancelCount = 0;
		const result = raceFirstNonNull(
			local.promise,
			() => {
				fallbackStarted = true;
				return fallback.promise;
			},
			TITLE_LOCAL_FALLBACK_DELAY_MS,
			() => {
				cancelCount += 1;
			},
		);

		vi.advanceTimersByTime(TITLE_LOCAL_FALLBACK_DELAY_MS);
		await flushMicrotasks();
		expect(fallbackStarted).toBe(true);

		local.resolve("Local Title");
		await expect(result).resolves.toBe("Local Title");
		expect(cancelCount).toBe(1);
		fallback.resolve(null);
	});
});

describe("tiny title generator routing", () => {
	it("keeps online-only behavior when Tiny Model is Online", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "online"),
		);

		expect(title).toBe("Online Title");
		expect(local).not.toHaveBeenCalled();
		expect(online).toHaveBeenCalledTimes(1);
	});

	it("uses the local client for selected local models", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
		);

		expect(title).toBe("Local Title");
		expect(local).toHaveBeenCalledWith("lfm2-350m", "Investigate routing");
		expect(online).not.toHaveBeenCalled();
	});

	it("starts online fallback immediately when local returns null", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(tinyTitleClient, "generate").mockResolvedValue(null);
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate fallback",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
		);

		expect(title).toBe("Online Title");
		expect(online).toHaveBeenCalledTimes(1);
	});

	it("aborts the online request when delayed local generation wins", async () => {
		vi.useFakeTimers();
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = Promise.withResolvers<string | null>();
		const onlineHold = Promise.withResolvers<AssistantMessage>();
		let onlineSignal: AbortSignal | undefined;
		vi.spyOn(tinyTitleClient, "generate").mockReturnValue(local.promise);
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, options) => {
			onlineSignal = options?.signal;
			return onlineHold.promise;
		});

		const result = generateSessionTitle(
			"Investigate cancellation",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
		);

		vi.advanceTimersByTime(TITLE_LOCAL_FALLBACK_DELAY_MS);
		await flushMicrotasks();
		expect(onlineSignal?.aborted).toBe(false);

		local.resolve("Local Title");
		await expect(result).resolves.toBe("Local Title");
		expect(onlineSignal?.aborted).toBe(true);
		onlineHold.resolve({ stopReason: "abort", content: [] } as never);
	});

	it("keeps local generation alive when the delayed online fallback wins", async () => {
		vi.useFakeTimers();
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = Promise.withResolvers<string | null>();
		let localSettled = false;
		void local.promise.then(() => {
			localSettled = true;
		});
		vi.spyOn(tinyTitleClient, "generate").mockReturnValue(local.promise);
		mockOnlineTitle("Online Title");

		const result = generateSessionTitle(
			"Investigate background download",
			createRegistry(model),
			createSettings(model, "lfm2-700m"),
		);

		vi.advanceTimersByTime(TITLE_LOCAL_FALLBACK_DELAY_MS);
		await flushMicrotasks();
		await expect(result).resolves.toBe("Online Title");
		expect(localSettled).toBe(false);

		local.resolve("Late Local Title");
		await flushMicrotasks();
		expect(localSettled).toBe(true);
	});
});

describe("providers.tinyModel schema", () => {
	it("keeps enum values and UI options in sync with the tiny model registry", () => {
		expect(getEnumValues("providers.tinyModel")).toEqual([...TINY_TITLE_MODEL_VALUES]);
		expect(getUi("providers.tinyModel")?.options).toEqual(TINY_TITLE_MODEL_OPTIONS);
		expect(getDefault("providers.tinyModel")).toBe(ONLINE_TINY_TITLE_MODEL_KEY);
	});
});

describe("tiny model acceleration schema", () => {
	it("keeps the device setting in sync with the device module constants", () => {
		expect(getEnumValues("providers.tinyModelDevice")).toEqual([...TINY_MODEL_DEVICE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDevice")?.options).toEqual(TINY_MODEL_DEVICE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDevice")).toBe(TINY_MODEL_DEVICE_DEFAULT);
	});

	it("keeps the precision setting in sync with the dtype module constants", () => {
		expect(getEnumValues("providers.tinyModelDtype")).toEqual([...TINY_MODEL_DTYPE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDtype")?.options).toEqual(TINY_MODEL_DTYPE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDtype")).toBe(TINY_MODEL_DTYPE_DEFAULT);
	});
});

describe("tiny title download progress UI", () => {
	it("renders progress updates and completion state", () => {
		const component = new TinyTitleDownloadProgressComponent("lfm2-700m");
		component.update({
			modelKey: "lfm2-700m",
			status: "progress_total",
			name: "onnx-community/LFM2-700M-ONNX",
			progress: 50,
			loaded: 50,
			total: 100,
			files: {},
		});
		expect(component.render(80).join("\n")).toContain("LFM2 700M");
		expect(component.isComplete()).toBe(false);
		component.update({ modelKey: "lfm2-700m", status: "ready", task: "text-generation", model: "repo" });
		expect(component.isComplete()).toBe(true);
	});
});

describe("tiny-models CLI", () => {
	it("registers tiny-models as a top-level subcommand", () => {
		expect(isSubcommand("tiny-models")).toBe(true);
	});
});
