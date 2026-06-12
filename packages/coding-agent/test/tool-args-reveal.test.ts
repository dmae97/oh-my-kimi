import { afterEach, describe, expect, it, vi } from "bun:test";
import { STREAMING_REVEAL_FRAME_MS } from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";
import { ToolArgsRevealController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tool-args-reveal";

class RecordingArgsComponent {
	frames: Array<Record<string, unknown>> = [];

	updateArgs(args: unknown): void {
		this.frames.push(args as Record<string, unknown>);
	}
}

function makeController(options: { smooth?: boolean; requestRender?: () => void } = {}) {
	const component = new RecordingArgsComponent();
	const controller = new ToolArgsRevealController({
		getSmoothStreaming: () => options.smooth ?? true,
		requestRender: options.requestRender ?? (() => {}),
	});
	return { component, controller };
}

function partialOf(frame: Record<string, unknown>): string {
	const partial = frame.__partialJson;
	if (typeof partial !== "string") {
		throw new Error("Expected __partialJson string on revealed frame");
	}
	return partial;
}

function drain(frames: number): void {
	for (let i = 0; i < frames; i++) {
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
	}
}

describe("tool args reveal", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reveals streamed JSON args as monotonic re-parsed prefixes", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const content = "line one\\nline two\\nline three of a streamed write payload";
		const target = `{"path":"a.ts","content":"${content}"}`;

		const initial = controller.setTarget("call-1", target, false, { path: "a.ts" });
		expect(partialOf(initial)).toBe("");
		controller.bind("call-1", component);
		drain(100);

		const partials = component.frames.map(partialOf);
		expect(partials.at(-1)).toBe(target);
		for (let i = 1; i < partials.length; i++) {
			expect(partials[i].length).toBeGreaterThanOrEqual(partials[i - 1].length);
			expect(target.startsWith(partials[i])).toBe(true);
		}
		// The parsed preview field grows with the reveal instead of popping in whole.
		const contents = component.frames
			.map(frame => frame.content)
			.filter((value): value is string => typeof value === "string");
		const finalContent = contents.at(-1);
		expect(finalContent).toBeDefined();
		expect(contents.some(value => value.length < finalContent!.length)).toBe(true);
	});

	it("passes the full target through untouched when smoothing is disabled", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const { component, controller } = makeController({ smooth: false, requestRender });
		const target = `{"path":"a.ts","content":"abc"}`;
		const fullArgs = { path: "a.ts", content: "abc" };

		const renderArgs = controller.setTarget("call-1", target, false, fullArgs);
		controller.bind("call-1", component);
		drain(10);

		expect(renderArgs).toEqual({ ...fullArgs, __partialJson: target });
		expect(component.frames).toHaveLength(0);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("finish drops the reveal so no further frames are pushed", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();

		controller.setTarget("call-1", `{"path":"a.ts","content":"abcdefghijklmnop"}`, false, {});
		controller.bind("call-1", component);
		drain(1);
		const frames = component.frames.length;
		controller.finish("call-1");
		drain(10);

		expect(component.frames).toHaveLength(frames);
	});

	it("flushAll snaps live entries to the full received stream", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const target = `{"path":"a.ts","content":"${"x".repeat(500)}"}`;

		controller.setTarget("call-1", target, false, {});
		controller.bind("call-1", component);
		drain(1);
		expect(partialOf(component.frames.at(-1)!).length).toBeLessThan(target.length);
		controller.flushAll();

		expect(partialOf(component.frames.at(-1)!)).toBe(target);
		const frames = component.frames.length;
		drain(10);
		expect(component.frames).toHaveLength(frames);
	});

	it("never splits a surrogate pair at a frame boundary", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const target = `{"content":"${"😀🎉".repeat(40)}"}`;

		controller.setTarget("call-1", target, false, {});
		controller.bind("call-1", component);
		drain(100);

		expect(partialOf(component.frames.at(-1)!)).toBe(target);
		for (const frame of component.frames) {
			expect(partialOf(frame).isWellFormed()).toBe(true);
		}
	});

	it("exposes custom raw-input streams as { input } without JSON parsing", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		const target = "*** Begin Patch\n*** Update File: a.ts\n-old\n+new\n*** End Patch";

		controller.setTarget("call-1", target, true, { input: target });
		controller.bind("call-1", component);
		drain(100);

		for (const frame of component.frames) {
			expect(frame.input).toBe(partialOf(frame));
		}
		expect(component.frames.at(-1)!.input).toBe(target);
	});
});
