import { describe, expect, it } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui/components/text";

describe("Text component", () => {
	it("reports whether setText changed the stored text", () => {
		const text = new Text("a");

		expect(text.setText("a")).toBe(false);
		expect(text.setText("b")).toBe(true);
		expect(text.getText()).toBe("b");
	});
});
