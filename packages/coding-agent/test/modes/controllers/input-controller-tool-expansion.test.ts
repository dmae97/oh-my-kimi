import { describe, expect, it, vi } from "bun:test";
import { InputController } from "../../../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";

describe("InputController tool output expansion", () => {
	it("allows unknown viewport mutation when toggling tool output expansion", () => {
		const expandable = { setExpanded: vi.fn() };
		const inert = { render: vi.fn(() => []) };
		const requestRender = vi.fn();
		const ctx = {
			toolOutputExpanded: false,
			chatContainer: { children: [expandable, inert] },
			ui: { requestRender },
		} as unknown as InteractiveModeContext;

		new InputController(ctx).toggleToolOutputExpansion();

		expect(ctx.toolOutputExpanded).toBe(true);
		expect(expandable.setExpanded).toHaveBeenCalledWith(true);
		expect(requestRender).toHaveBeenCalledWith(false, { allowUnknownViewportMutation: true });
	});
});
