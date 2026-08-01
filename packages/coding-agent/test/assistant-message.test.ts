import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops as visible errors", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thought");
		expect(rendered).toContain("maximum output token limit");
		expect(rendered).toContain("response may be incomplete");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thought/g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("  reasoning"))).toBe(true);
	});

	test("collapses thinking by default and toggles only from its disclosure row", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]),
		);
		let lines = component.render(80);
		expect(stripAnsi(lines.join("\n"))).toContain("▶ Thought");
		expect(stripAnsi(lines.join("\n"))).not.toContain("private reasoning");

		const disclosureRow = lines.findIndex((line) => stripAnsi(line).includes("▶ Thought"));
		const target = component.getMouseTargetAtRow(disclosureRow);
		expect(target?.y).toBe(0);
		target?.component.handleMouse?.({ type: "press", button: 0, x: 1, y: target.y });

		lines = component.render(80);
		expect(stripAnsi(lines.join("\n"))).toContain("▼ Thought");
		expect(stripAnsi(lines.join("\n"))).toContain("private reasoning");

		const detailsRow = lines.findIndex((line) => stripAnsi(line).includes("private reasoning"));
		const detailsTarget = component.getMouseTargetAtRow(detailsRow);
		detailsTarget?.component.handleMouse?.({ type: "press", button: 0, x: 3, y: detailsTarget.y });
		expect(stripAnsi(component.render(80).join("\n"))).toContain("private reasoning");
	});

	test("shows Thinking while streaming, then Thought while preserving expansion after completion", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent();
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "first partial thought" }]), true);
		const disclosureRow = component.render(80).findIndex((line) => stripAnsi(line).includes("▶ Thinking..."));
		const target = component.getMouseTargetAtRow(disclosureRow);
		target?.component.handleMouse?.({ type: "press", button: 0, x: 1, y: target.y });

		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "updated partial thought" }]),
			true,
		);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▼ Thinking...");

		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "updated complete thought" }]),
			false,
		);
		const completed = stripAnsi(component.render(80).join("\n"));
		expect(completed).toContain("▼ Thought");
		expect(completed).not.toContain("Thinking...");
		expect(completed).toContain("updated complete thought");
	});

	test("supports custom active and completed thinking labels", () => {
		initTheme("dark");

		const labels = { active: "Asking Oracle...", complete: "Oracle has spoken" };
		const component = new AssistantMessageComponent(undefined, true, undefined, labels);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "consulting" }]), true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▶ Asking Oracle...");

		labels.complete = "mutated";
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "answer received" }]), false);
		const completed = stripAnsi(component.render(80).join("\n"));
		expect(completed).toContain("▶ Oracle has spoken");
		expect(completed).not.toContain("mutated");
	});

	test("keeps legacy custom thinking labels after completion", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(undefined, true, undefined, "Pondering...");
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "partial" }]), true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▶ Pondering...");

		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "complete" }]), false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▶ Pondering...");
	});

	test("relabels completed thinking without rebuilding message content", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "complete" }]),
			false,
		);
		const contentContainer = component.children[0] as Container;
		const thinkingBlock = contentContainer.children[1] as Container;
		const markdown = thinkingBlock.children[1];
		const updateContent = vi.spyOn(component, "updateContent");
		component.setHiddenThinkingLabel({ active: "Asking Oracle...", complete: "Oracle has spoken" });

		expect(updateContent).not.toHaveBeenCalled();
		expect(thinkingBlock.children[1]).toBe(markdown);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("▼ Oracle has spoken");
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" ┃ hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("┃ hello"))).toBe(true);
	});
});
