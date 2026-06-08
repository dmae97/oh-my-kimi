import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as toolsManager from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import { handleYouTube } from "@oh-my-pi/pi-coding-agent/web/scrapers/youtube";
import { hookFetch } from "@oh-my-pi/pi-utils";

describe("handleYouTube with Parallel extract", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		process.env.PARALLEL_API_KEY = "test-parallel-key";
		await Settings.init({ inMemory: true, overrides: { "providers.fetch": "auto" } });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		delete process.env.PARALLEL_API_KEY;
	});

	it("returns Parallel extract content before yt-dlp fallback", async () => {
		const ensureToolSpy = vi.spyOn(toolsManager, "ensureTool");
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url === "https://api.parallel.ai/v1beta/extract") {
				return new Response(
					JSON.stringify({
						extract_id: "extract-youtube-1",
						results: [
							{
								url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
								title: "Video page",
								excerpts: [
									"Parallel summary for the video page that is comfortably longer than one hundred characters. ".repeat(
										2,
									),
								],
								full_content: null,
							},
						],
						errors: [],
						warnings: null,
						usage: null,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("unexpected", { status: 500 });
		});

		const result = await handleYouTube("https://youtu.be/dQw4w9WgXcQ", 10);
		expect(result?.method).toBe("parallel");
		expect(result?.finalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("Parallel summary for the video page");
		expect(result?.notes).toContain("Used Parallel extract for YouTube");
		expect(ensureToolSpy).not.toHaveBeenCalled();
	});
});
