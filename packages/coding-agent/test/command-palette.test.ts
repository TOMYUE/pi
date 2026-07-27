import type { SlashCommand } from "@earendil-works/pi-tui";
import { Container, setKeybindings, Text, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { CommandPaletteComponent } from "../src/modes/interactive/components/command-palette.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const sourceInfo: SourceInfo = {
	path: "/tmp/command.ts",
	source: "local",
	scope: "project",
	origin: "top-level",
};

function renderText(component: CommandPaletteComponent, width = 100): string {
	return component
		.render(width)
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

function createPalette(
	commands: SlashCommand[],
	callbacks: {
		onSubmit?: (command: SlashCommand) => void;
		onComplete?: (text: string) => void;
		onCancel?: () => void;
	} = {},
): CommandPaletteComponent {
	return new CommandPaletteComponent(commands, {
		maxVisible: () => 10,
		onSubmit: callbacks.onSubmit ?? (() => {}),
		onComplete: callbacks.onComplete ?? (() => {}),
		onCancel: callbacks.onCancel ?? (() => {}),
	});
}

describe("CommandPaletteComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(KeybindingsManager.create("/tmp/pi-command-palette-test"));
	});

	test("fuzzy-filters commands and invokes the selected result", () => {
		const onSubmit = vi.fn();
		const palette = createPalette(
			[
				{ name: "model", description: "Select model" },
				{ name: "hotkeys", description: "Show keyboard shortcuts" },
			],
			{ onSubmit },
		);

		palette.handleInput("h");
		palette.handleInput("k");
		expect(renderText(palette)).toContain("hotkeys");
		expect(renderText(palette)).not.toContain("model");

		palette.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "hotkeys" }));
	});

	test("supports navigation, Tab completion, argument entry, and draft restoration", () => {
		const onComplete = vi.fn();
		const onCancel = vi.fn();
		const commands: SlashCommand[] = [
			{ name: "settings", description: "Open settings" },
			{ name: "model", description: "Select model", argumentHint: "<provider/model>" },
		];

		const navigated = createPalette(commands, { onComplete });
		navigated.handleInput("\x1b[B");
		navigated.handleInput("\t");
		expect(onComplete).toHaveBeenCalledWith("/model ");

		const withArguments = createPalette(commands, { onComplete });
		for (const character of "model ") withArguments.handleInput(character);
		expect(onComplete).toHaveBeenCalledWith("/model ");

		const cancelled = createPalette(commands, { onCancel });
		for (const character of "mod") cancelled.handleInput(character);
		cancelled.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledWith();
	});

	test("finds contributed commands by plugin, prompt, and skill source", () => {
		const commands: SlashCommand[] = [
			{ name: "deploy", description: "Deploy project", category: "extension" },
			{ name: "review", description: "Review changes", category: "prompt" },
			{ name: "skill:inspect", description: "Inspect code", category: "skill" },
		];

		for (const [query, expectedName, expectedText] of [
			["plugin", "deploy", "deploy"],
			["prompt", "review", "review"],
			["skill", "skill:inspect", "Inspect code"],
		] as const) {
			const palette = createPalette(commands);
			for (const character of query) palette.handleInput(character);
			const output = renderText(palette);
			expect(output).toContain(expectedText);
			for (const command of commands) {
				if (command.name !== expectedName) expect(output).not.toContain(command.name);
			}
		}
	});

	test("renders within narrow widths", () => {
		const palette = createPalette([{ name: "model", description: "A long command description" }]);
		for (const width of [1, 4, 12, 40]) {
			for (const line of palette.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("InteractiveMode slash-command aggregation", () => {
	test("uses the same complete command set for the palette and autocomplete", () => {
		const skillCommands = new Map<string, string>();
		const extensionArgumentCompletion = vi.fn(() => null);
		const fakeThis = {
			session: {
				scopedModels: [],
				modelRuntime: { getAvailable: () => [] },
				promptTemplates: [{ name: "review", description: "Review changes", argumentHint: "<focus>", sourceInfo }],
				extensionRunner: {
					getRegisteredCommands: () => [
						{
							name: "deploy",
							invocationName: "deploy",
							description: "Deploy project",
							sourceInfo,
							getArgumentCompletions: extensionArgumentCompletion,
						},
						{
							name: "model",
							invocationName: "tools:model",
							description: "Extension model command",
							sourceInfo,
						},
					],
				},
				resourceLoader: {
					getSkills: () => ({
						skills: [{ name: "inspect", description: "Inspect code", filePath: "/tmp/SKILL.md", sourceInfo }],
					}),
				},
			},
			settingsManager: { getEnableSkillCommands: () => true },
			skillCommands,
			getLoginProviderOptions: () => [],
			prefixAutocompleteDescription: (description: string | undefined) => description,
			getAppKeyDisplay: () => "ctrl+l",
		};
		const createSlashCommands = (
			InteractiveMode as unknown as {
				prototype: { createSlashCommands(this: typeof fakeThis): SlashCommand[] };
			}
		).prototype.createSlashCommands;

		const commands = createSlashCommands.call(fakeThis);
		const names = commands.map((command) => command.name);
		const categories = Object.fromEntries(commands.map((command) => [command.name, command.category]));

		expect(names).toEqual(expect.arrayContaining(BUILTIN_SLASH_COMMANDS.map((command) => command.name)));
		expect(names).toEqual(expect.arrayContaining(["review", "deploy", "tools:model", "skill:inspect"]));
		expect(categories).toMatchObject({
			review: "prompt",
			deploy: "extension",
			"tools:model": "extension",
			"skill:inspect": "skill",
		});
		expect(commands.find((command) => command.name === "deploy")?.getArgumentCompletions).toBe(
			extensionArgumentCompletion,
		);
		expect(skillCommands.get("skill:inspect")).toBe("/tmp/SKILL.md");
	});
});

describe("CustomEditor command-palette trigger", () => {
	test("consumes a typed slash only in an empty editor and leaves paste/direct commands unchanged", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create("/tmp/pi-editor-test"));
		const onCommandPalette = vi.fn(() => true);
		editor.onCommandPalette = onCommandPalette;

		editor.handleInput("/");
		expect(onCommandPalette).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");

		editor.handleInput("\x1b[200~/model openai/gpt\x1b[201~");
		expect(onCommandPalette).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("/model openai/gpt");

		editor.setText("");
		editor.handleInput("\x1b[47u");
		expect(onCommandPalette).toHaveBeenCalledTimes(2);
		expect(editor.getText()).toBe("");
	});

	test("falls back to normal slash autocomplete when the palette declines to open", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create("/tmp/pi-editor-test"));
		editor.onCommandPalette = () => false;

		editor.handleInput("/");
		expect(editor.getText()).toBe("/");
	});
});

describe("command palette overlay", () => {
	test("renders independently without moving the fixed composer", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const transcript = new Container();
		const composer = new Container();
		transcript.addChild(new Text("TRANSCRIPT", 0, 0));
		composer.addChild(new Text("FIXED COMPOSER", 0, 0));
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.start();
		try {
			await terminal.waitForRender();
			const before = terminal.getViewport();
			const composerRow = before.findIndex((line) => line.includes("FIXED COMPOSER"));

			tui.showOverlay(createPalette([{ name: "model", description: "Select model" }]), {
				anchor: "center",
				width: "80%",
				maxHeight: "70%",
			});
			tui.requestRender(true);
			await terminal.waitForRender();
			const after = terminal.getViewport();

			expect(after.findIndex((line) => line.includes("FIXED COMPOSER"))).toBe(composerRow);
			expect(after.some((line) => line.includes("Command Palette"))).toBe(true);
		} finally {
			tui.stop();
		}
	});
});
