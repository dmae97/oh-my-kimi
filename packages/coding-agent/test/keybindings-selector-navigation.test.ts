import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { ExtensionList } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-list";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { HistorySearchComponent } from "@oh-my-pi/pi-coding-agent/modes/components/history-search";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import { UserMessageSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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
	// add() batches writes behind a 100ms AsyncDrain timer. Drive that timer with
	// fake timers so the flush is instant instead of waiting real wall-clock time.
	vi.useFakeTimers();
	try {
		const writes = prompts.map(prompt => storage.add(prompt));
		vi.advanceTimersByTime(100);
		await Promise.all(writes);
	} finally {
		vi.useRealTimers();
	}
	return storage;
}

describe("selector navigation keybindings", () => {
	it("uses tui.select.down in the session selector", () => {
		setKeybindings(TEST_KEYBINDINGS);
		const selected: string[] = [];
		const selector = new SessionSelectorComponent(
			[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
			session => selected.push(session.path),
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

	it("supports page and home/end navigation in history search", async () => {
		setKeybindings(KeybindingsManager.inMemory());
		const selected: string[] = [];
		// Added oldest-first; getRecent returns newest-first, so index 0 is "p14", index 14 is "p0".
		const storage = await createHistoryStorage(Array.from({ length: 15 }, (_, i) => `p${i}`));
		const selector = new HistorySearchComponent(
			storage,
			prompt => selected.push(prompt),
			() => {},
		);

		const PAGE_UP = "\x1b[5~";
		const PAGE_DOWN = "\x1b[6~";
		const HOME = "\x1b[H";
		const END = "\x1b[F";

		selector.handleInput(PAGE_DOWN); // index 0 -> 10  (p4)
		selector.handleInput("\n");
		selector.handleInput(END); // -> 14, last  (p0)
		selector.handleInput("\n");
		selector.handleInput(PAGE_UP); // index 14 -> 4  (p10)
		selector.handleInput("\n");
		selector.handleInput(HOME); // -> 0, first  (p14)
		selector.handleInput("\n");

		expect(selected).toEqual(["p4", "p0", "p10", "p14"]);
	});
});
