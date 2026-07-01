import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown, type MarkdownTheme } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const WIDTH = 72;
const FROZEN_CODE_PREFIX = "```ts\nconst frozen = 1;\n```\n\n";

function renderCold(text: string, theme: MarkdownTheme): readonly string[] {
	clearRenderCache();
	const md = new Markdown(text, 0, 0, theme);
	return md.render(WIDTH);
}

describe("Markdown streaming prefix render cache", () => {
	it("reuses rendered frozen prefix lines during transient append renders", () => {
		let codeBlockCalls = 0;
		let codeBlockBorderCalls = 0;
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			codeBlock: text => {
				codeBlockCalls++;
				return defaultMarkdownTheme.codeBlock(text);
			},
			codeBlockBorder: text => {
				codeBlockBorderCalls++;
				return defaultMarkdownTheme.codeBlockBorder(text);
			},
		};

		const firstText = `${FROZEN_CODE_PREFIX}tail one`;
		const secondText = `${FROZEN_CODE_PREFIX}tail one plus more streamed words`;
		const md = new Markdown(firstText, 0, 0, theme);
		md.transientRenderCache = true;
		md.render(WIDTH);

		codeBlockCalls = 0;
		codeBlockBorderCalls = 0;
		md.setText(secondText);
		const streamingLines = md.render(WIDTH);

		expect(codeBlockCalls).toBe(0);
		expect(codeBlockBorderCalls).toBe(0);
		expect(streamingLines).toEqual(renderCold(secondText, theme));
	});

	it("advances the rendered prefix cache when a new stable block freezes", () => {
		let codeBlockCalls = 0;
		let codeBlockBorderCalls = 0;
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			codeBlock: text => {
				codeBlockCalls++;
				return defaultMarkdownTheme.codeBlock(text);
			},
			codeBlockBorder: text => {
				codeBlockBorderCalls++;
				return defaultMarkdownTheme.codeBlockBorder(text);
			},
		};
		const firstBlock = "```ts\nconst first = 1;\n```\n\n";
		const secondBlock = "```ts\nconst second = 2;\n```\n\n";
		const firstText = `${firstBlock}first tail`;
		const secondText = `${firstBlock}${secondBlock}second tail`;
		const thirdText = `${firstBlock}${secondBlock}second tail plus more words`;
		const md = new Markdown(firstText, 0, 0, theme);
		md.transientRenderCache = true;
		md.render(WIDTH);

		md.setText(secondText);
		md.render(WIDTH);

		codeBlockCalls = 0;
		codeBlockBorderCalls = 0;
		md.setText(thirdText);
		const streamingLines = md.render(WIDTH);

		expect(codeBlockCalls).toBe(0);
		expect(codeBlockBorderCalls).toBe(0);
		expect(streamingLines).toEqual(renderCold(thirdText, theme));
	});

	it("drops cached prefix lines after truncating to a previously frozen prefix", () => {
		const prefix = "---\n\n";
		const md = new Markdown(`${prefix}body`, 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		md.render(WIDTH);

		md.setText(prefix);
		const streamingLines = md.render(WIDTH);

		expect(streamingLines).toEqual(renderCold(prefix, defaultMarkdownTheme));
	});
});
