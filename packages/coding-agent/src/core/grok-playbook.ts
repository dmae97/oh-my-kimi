import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

export const GROK_OAUTH_PROVIDER = "xai";

const GROK_PLAYBOOK_FILENAME = "grok.md";

/** Cap live system-prompt append size to reduce threshold autocompaction churn on Grok sessions. */
export const GROK_PLAYBOOK_MAX_APPEND_CHARS = 24_000;

/** Read ~/.omk/agent/grok.md for appending to the system prompt on Grok OAuth sessions. */
export function loadGrokPlaybookAppend(): string | undefined {
	const path = join(getAgentDir(), GROK_PLAYBOOK_FILENAME);
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		let text = readFileSync(path, "utf-8").trim();
		if (text.length === 0) {
			return undefined;
		}
		if (text.length > GROK_PLAYBOOK_MAX_APPEND_CHARS) {
			text = `${text.slice(0, GROK_PLAYBOOK_MAX_APPEND_CHARS)}\n\n[... grok.md truncated for system prompt; full file: ${path}]`;
		}
		return text;
	} catch {
		return undefined;
	}
}

export function grokPlaybookAppendForProvider(provider: string | undefined): string | undefined {
	if (provider !== GROK_OAUTH_PROVIDER) {
		return undefined;
	}
	return loadGrokPlaybookAppend();
}
