import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { ExtensionList } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-list";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { HistorySearchComponent } from "@oh-my-pi/pi-coding-agent/modes/components/history-search";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/oauth-selector";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import { UserMessageSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import type { SessionInfo, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const CTRL_N = "\x0e";
const CTRL_P = "\x10";
const TEST_KEYBINDINGS = KeybindingsManager.inMemory({
	"tui.select.up": "ctrl+p",
	"tui.select.down": "ctrl+n",
});

const tempDirs: string[] = [];

class EmptyCredentialStore implements AuthCredentialStore {
	close(): void {}

	listAuthCredentials(_provider?: string): StoredAuthCredential[] {
		return [];
	}

	updateAuthCredential(_id: number, _credential: AuthCredential): void {}

	deleteAuthCredential(_id: number, _disabledCause: string): void {}

	tryDisableAuthCredentialIfMatches(_id: number, _expectedData: string, _disabledCause: string): boolean {
		return false;
	}

	replaceAuthCredentialsForProvider(_provider: string, _credentials: AuthCredential[]): StoredAuthCredential[] {
		return [];
	}

	upsertAuthCredentialForProvider(_provider: string, _credential: AuthCredential): StoredAuthCredential[] {
		return [];
	}

	deleteAuthCredentialsForProvider(_provider: string, _disabledCause: string): void {}

	getCache(_key: string, _options?: { includeExpired?: boolean }): string | null {
		return null;
	}

	setCache(_key: string, _value: string, _expiresAtSec: number): void {}

	cleanExpiredCache(): void {}
}

beforeAll(() => {
	initTheme();
});

afterEach(async () => {
	setKeybindings(KeybindingsManager.inMemory());
	HistoryStorage.resetInstance();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createSession(id: string, title: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
}

function createMessageNode(id: string, parentId: string | null, content: string): SessionTreeNode {
	const message: AgentMessage = { role: "user", content, timestamp: 1 };
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: "2024-01-01T00:00:00Z",
			message,
		},
		children: [],
	};
}

function createExtension(id: string, displayName: string): Extension {
	return {
		id,
		kind: "tool",
		name: id,
		displayName,
		description: displayName,
		path: `/tmp/${id}.md`,
		source: {
			provider: "test-provider",
			providerName: "Test Provider",
			level: "project",
		},
		state: "active",
		raw: {},
	};
}

async function createHistoryStorage(prompts: string[]): Promise<HistoryStorage> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-history-nav-"));
	tempDirs.push(dir);
	HistoryStorage.resetInstance();
	const storage = HistoryStorage.open(path.join(dir, "history.db"));
	for (const prompt of prompts) {
		await storage.add(prompt);
	}
	return storage;
}

function createAuthStorage(): AuthStorage {
	return new AuthStorage(new EmptyCredentialStore());
}

describe("selector navigation keybindings", () => {
	it("uses tui.select.down in the session selector", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const selected: string[] = [];
		const selector = new SessionSelectorComponent(
			[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
			path => selected.push(path),
			() => {},
			() => {},
		);

		selector.handleInput(CTRL_N);
		selector.handleInput("\n");

		expect(selected).toEqual(["/tmp/session-b.jsonl"]);
	});

	it("uses tui.select.down in the session tree", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const root = createMessageNode("root", null, "Root");
		const child = createMessageNode("child", "root", "Child");
		root.children.push(child);
		const selected: string[] = [];
		const selector = new TreeSelectorComponent(
			[root],
			"root",
			40,
			id => selected.push(id),
			() => {},
		);
		selector.handleInput(CTRL_N);
		selector.handleInput("\n");

		expect(selected).toEqual(["child"]);
	});

	it("uses tui.select.up in the user message selector", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const selected: string[] = [];
		const selector = new UserMessageSelectorComponent(
			[
				{ id: "first", text: "First" },
				{ id: "second", text: "Second" },
				{ id: "third", text: "Third" },
			],
			id => selected.push(id),
			() => {},
		);

		selector.getMessageList().handleInput(CTRL_P);
		selector.getMessageList().handleInput("\n");

		expect(selected).toEqual(["second"]);
	});

	it("uses tui.select.down in the extension list", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const list = new ExtensionList([createExtension("tool-a", "Tool A"), createExtension("tool-b", "Tool B")]);

		list.handleInput(CTRL_N);

		expect(list.getSelectedExtension()?.id).toBe("tool-a");
	});

	it("uses tui.select.down in the OAuth selector", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const selected: string[] = [];
		const selector = new OAuthSelectorComponent(
			"login",
			createAuthStorage(),
			id => selected.push(id),
			() => {},
		);

		selector.handleInput(CTRL_N);
		selector.handleInput("\n");

		expect(selected).toEqual(["alibaba-coding-plan"]);
	});

	it("uses tui.select.down in history search", async () => {
		setKeybindings(TEST_KEYBINDINGS);
		const selected: string[] = [];
		const storage = await createHistoryStorage(["old prompt", "middle prompt", "new prompt"]);
		const selector = new HistorySearchComponent(
			storage,
			prompt => selected.push(prompt),
			() => {},
		);
		selector.handleInput(CTRL_N);
		selector.handleInput("\n");

		expect(selected).toEqual(["middle prompt"]);
	});
});
