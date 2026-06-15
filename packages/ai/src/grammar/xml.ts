import { AnthropicInbandScanner } from "./anthropic";
import { DeepSeekInbandScanner } from "./deepseek";
import { renderToolResponseResults, renderXmlInvocation, renderXmlToolCalls } from "./rendering";
import type { Grammar, InbandScanEvent, InbandScanner, InbandScannerOptions } from "./types";
import grammarPrompt from "./xml.md" with { type: "text" };

export class XmlInbandScanner implements InbandScanner {
	readonly #inner: InbandScanner;

	constructor(options: InbandScannerOptions = {}) {
		this.#inner =
			options.xmlTagset === "dsml" ? new DeepSeekInbandScanner(options) : new AnthropicInbandScanner(options);
	}

	feed(text: string): InbandScanEvent[] {
		return this.#inner.feed(text);
	}

	flush(): InbandScanEvent[] {
		return this.#inner.flush();
	}
}

const grammar: Grammar = {
	syntax: "xml",
	prompt: grammarPrompt,
	createScanner: options => new XmlInbandScanner(options),
	renderToolCall: renderXmlInvocation,
	renderAssistantToolCalls: renderXmlToolCalls,
	renderToolResults: renderToolResponseResults,
};

export default grammar;
