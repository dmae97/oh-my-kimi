import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const uiStub = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;

function makeSshComponent() {
	return new ToolExecutionComponent("ssh", { host: "sccpu", command: "uptime" }, {}, undefined, uiStub);
}

function result(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function expectLive(component: ToolExecutionComponent): void {
	expect(component.isTranscriptBlockFinalized()).toBe(false);
	expect(component.getNativeScrollbackLiveRegionStart()).toBe(0);
}

function expectFinal(component: ToolExecutionComponent): void {
	expect(component.isTranscriptBlockFinalized()).toBe(true);
	expect(component.getNativeScrollbackLiveRegionStart()).toBeUndefined();
}

describe("ssh tool transcript finalization", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("keeps partial SSH results in the native-scrollback live region", () => {
		const component = makeSshComponent();

		component.updateResult(result("connecting…"), true);

		expectLive(component);
	});

	it("keeps pending SSH previews in the live region before a result arrives", () => {
		for (const expanded of [false, true]) {
			const component = makeSshComponent();
			component.setExpanded(expanded);
			component.setArgsComplete();

			expectLive(component);
		}
	});

	it("moves the block out of the live region as soon as the SSH result settles", () => {
		const component = makeSshComponent();
		component.updateResult(result("connecting…"), true);
		expectLive(component);

		component.updateResult(result("done\n"), false);

		expectFinal(component);
	});
});
