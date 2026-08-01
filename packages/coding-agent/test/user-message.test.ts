import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

describe("UserMessageComponent", () => {
	test("renders an italic prompt with a green accent and an invisible closing marker line", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0]).toContain("\x1b[3m");
		expect(lines[0]).toContain(theme.fg("success", "hello"));
		expect(stripAnsi(lines[0])).toContain(" ┃ hello");
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(stripAnsi(lines[1])).toBe(" ");
	});

	test("keeps the accent continuous across wrapped and explicit prompt lines", () => {
		initTheme("dark");

		const component = new UserMessageComponent("one two three four\nsecond line", undefined, 0);
		const visibleLines = component
			.render(12)
			.map((line) => stripAnsi(line))
			.filter((line) => line.includes("┃"));

		expect(visibleLines.length).toBeGreaterThan(2);
		expect(visibleLines.every((line) => line.startsWith("┃ "))).toBe(true);
		expect(visibleLines.every((line) => line.length <= 12)).toBe(true);
	});
});
