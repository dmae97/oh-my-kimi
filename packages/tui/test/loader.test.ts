import assert from "node:assert";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Loader } from "../src/components/loader.ts";
import type { TUI } from "../src/tui.ts";

function createFakeTui(): TUI {
	return { requestRender() {} } as unknown as TUI;
}

function renderText(loader: Loader): string {
	return stripVTControlCharacters(loader.render(120).join("\n"));
}

describe("Loader dynamic suffix", () => {
	it("appends the dynamic suffix to the rendered message", () => {
		const loader = new Loader(
			createFakeTui(),
			(s) => s,
			(s) => s,
			"Working...",
		);
		try {
			loader.setDynamicSuffix(() => " (3s · esc interrupt)");
			assert.ok(renderText(loader).includes("Working... (3s · esc interrupt)"));
		} finally {
			loader.stop();
		}
	});

	it("re-evaluates the suffix on display updates", () => {
		const loader = new Loader(
			createFakeTui(),
			(s) => s,
			(s) => s,
			"Working...",
		);
		try {
			let suffix = " (0s)";
			loader.setDynamicSuffix(() => suffix);
			assert.ok(renderText(loader).includes("(0s)"));
			suffix = " (1s)";
			loader.setMessage("Working...");
			const text = renderText(loader);
			assert.ok(text.includes("(1s)"));
			assert.ok(!text.includes("(0s)"));
		} finally {
			loader.stop();
		}
	});

	it("drops the suffix when cleared", () => {
		const loader = new Loader(
			createFakeTui(),
			(s) => s,
			(s) => s,
			"Working...",
		);
		try {
			loader.setDynamicSuffix(() => " (9s)");
			loader.setDynamicSuffix(undefined);
			assert.ok(!renderText(loader).includes("(9s)"));
		} finally {
			loader.stop();
		}
	});

	it("keeps ticking with a static indicator so the suffix stays fresh", () => {
		const loader = new Loader(
			createFakeTui(),
			(s) => s,
			(s) => s,
			"Working...",
			{ frames: ["●"] },
		);
		try {
			let calls = 0;
			loader.setDynamicSuffix(() => {
				calls++;
				return ` (${calls})`;
			});
			// Static single-frame indicators previously skipped the animation timer
			// entirely; with a dynamic suffix the timer must run.
			assert.ok(renderText(loader).includes("●"));
			assert.ok(calls > 0);
		} finally {
			loader.stop();
		}
	});
});
