import { afterEach, describe, expect, test } from "bun:test";
import { type EditMode, type EditModeSessionLike, resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";

const originalEditVariant = Bun.env.PI_EDIT_VARIANT;

function restoreEnv(): void {
	if (originalEditVariant === undefined) {
		delete Bun.env.PI_EDIT_VARIANT;
	} else {
		Bun.env.PI_EDIT_VARIANT = originalEditVariant;
	}
}

function createSession(args: {
	activeModel?: string;
	modelVariant?: EditMode | null;
	settingsMode?: EditMode;
}): EditModeSessionLike {
	return {
		getActiveModelString: () => args.activeModel,
		settings: {
			get: () => args.settingsMode ?? "hashline",
			getEditVariantForModel: () => args.modelVariant ?? null,
		},
	};
}

describe("resolveEditMode", () => {
	afterEach(() => {
		restoreEnv();
	});

	test("defaults Spark models to apply_patch mode", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "openai-codex/gpt-5.3-codex-spark" }))).toBe("apply_patch");
	});

	test("keeps explicit model variants ahead of Spark fallback", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(
			resolveEditMode(createSession({ activeModel: "openai-codex/gpt-5.3-codex-spark", modelVariant: "replace" })),
		).toBe("replace");
	});

	test("keeps model-specific fallbacks ahead of settings mode", () => {
		delete Bun.env.PI_EDIT_VARIANT;

		expect(
			resolveEditMode(createSession({ activeModel: "openai-codex/gpt-5.3-codex-spark", settingsMode: "hashline" })),
		).toBe("apply_patch");
	});
});
