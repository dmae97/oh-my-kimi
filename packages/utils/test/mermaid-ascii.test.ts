import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type Canvas = string[][];

interface CanvasModule {
	canvasToString(canvas: Canvas, options?: { colorMode?: "none" }): string;
	drawText(canvas: Canvas, start: { x: number; y: number }, text: string, forceOverwrite?: boolean): void;
	mergeCanvases(base: Canvas, offset: { x: number; y: number }, useAscii: boolean, ...overlays: Canvas[]): Canvas;
	mkCanvas(x: number, y: number): Canvas;
}

function assertCanvasModule(value: unknown): asserts value is CanvasModule {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("beautiful-mermaid canvas module did not load");
	}
	const module = value as Record<string, unknown>;
	for (const key of ["canvasToString", "drawText", "mergeCanvases", "mkCanvas"]) {
		if (typeof module[key] !== "function") {
			throw new TypeError(`beautiful-mermaid canvas export missing: ${key}`);
		}
	}
}

async function loadCanvasModule(): Promise<CanvasModule> {
	const modulePath = path.resolve(import.meta.dir, "../../../node_modules/beautiful-mermaid/src/ascii/canvas.ts");
	const moduleValue: unknown = await import(pathToFileURL(modulePath).href);
	assertCanvasModule(moduleValue);
	return moduleValue;
}

describe("Mermaid ASCII patched dependency", () => {
	it("preserves an existing emoji label when a later narrow label collides with it", async () => {
		const { canvasToString, drawText, mergeCanvases, mkCanvas } = await loadCanvasModule();
		const base = mkCanvas(4, 0);
		drawText(base, { x: 0, y: 0 }, "🚀", true);

		const overlay = mkCanvas(4, 0);
		drawText(overlay, { x: 0, y: 0 }, "A", true);

		const rendered = canvasToString(mergeCanvases(base, { x: 0, y: 0 }, false, overlay), {
			colorMode: "none",
		}).trimEnd();

		expect(rendered).toBe("🚀");
	});
});
