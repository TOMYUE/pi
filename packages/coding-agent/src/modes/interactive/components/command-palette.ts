import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SlashCommand,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface CommandPaletteOptions {
	maxVisible: () => number;
	onSubmit: (command: SlashCommand) => void;
	onComplete: (text: string) => void;
	onCancel: () => void;
}

/** Searchable slash-command palette shown independently from the composer. */
export class CommandPaletteComponent implements Component, Focusable {
	private readonly commands: SlashCommand[];
	private readonly searchInput = new Input();
	private readonly options: CommandPaletteOptions;
	private filteredCommands: SlashCommand[];
	private selectedIndex = 0;
	private _focused = false;

	constructor(commands: SlashCommand[], options: CommandPaletteOptions) {
		this.commands = commands;
		this.filteredCommands = commands;
		this.options = options;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredCommands.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredCommands.length - 1 : this.selectedIndex - 1;
			}
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredCommands.length > 0) {
				this.selectedIndex = this.selectedIndex === this.filteredCommands.length - 1 ? 0 : this.selectedIndex + 1;
			}
			return;
		}
		if (kb.matches(data, "tui.input.tab")) {
			const selected = this.filteredCommands[this.selectedIndex];
			if (selected) this.options.onComplete(`/${selected.name} `);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.filteredCommands[this.selectedIndex];
			if (selected) this.options.onSubmit(selected);
			return;
		}

		this.searchInput.handleInput(data);
		const query = this.searchInput.getValue();
		const argumentMatch = query.match(/^(\S+)(\s.*)$/s);
		if (argumentMatch) {
			const command = this.commands.find(
				(candidate) => candidate.name.toLowerCase() === argumentMatch[1]?.toLowerCase(),
			);
			if (command) {
				this.options.onComplete(`/${command.name}${argumentMatch[2]}`);
				return;
			}
		}

		this.filteredCommands = fuzzyFilter(this.commands, query, (command) =>
			[command.name, command.argumentHint, command.description].filter(Boolean).join(" "),
		);
		this.selectedIndex = 0;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("Command Palette", Math.max(1, width))];

		const lines: string[] = [];
		const innerWidth = width - 4;
		const border = (text: string) => theme.fg("borderMuted", text);
		const title = `─ ${theme.bold(theme.fg("accent", "Command Palette"))} `;
		lines.push(`${border("╭")}${title}${border(`${"─".repeat(Math.max(0, width - visibleWidth(title) - 2))}╮`)}`);
		lines.push(this.renderBoxLine("", width));

		const searchLine = this.searchInput.render(Math.max(1, innerWidth))[0] ?? "";
		lines.push(this.renderBoxLine(searchLine, width));
		lines.push(this.renderBoxLine("", width));

		if (this.filteredCommands.length === 0) {
			lines.push(this.renderBoxLine(theme.fg("muted", "No matching commands"), width));
		} else {
			const maxVisible = Math.max(1, this.options.maxVisible());
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredCommands.length - maxVisible),
			);
			const endIndex = Math.min(startIndex + maxVisible, this.filteredCommands.length);
			for (let i = startIndex; i < endIndex; i++) {
				const command = this.filteredCommands[i];
				if (!command) continue;
				lines.push(this.renderCommand(command, i === this.selectedIndex, width));
			}
		}

		const hint =
			rawKeyHint("↑↓", "navigate") +
			"  " +
			keyHint("tui.select.confirm", "run") +
			"  " +
			keyHint("tui.input.tab", "insert") +
			"  " +
			keyHint("tui.select.cancel", "close");
		lines.push(this.renderBoxLine("", width));
		lines.push(this.renderBoxLine(hint, width));
		lines.push(border(`╰${"─".repeat(width - 2)}╯`));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderCommand(command: SlashCommand, selected: boolean, width: number): string {
		if (width < 48) {
			return this.renderBoxLine(theme.bold(theme.fg("text", command.name)), width, selected);
		}

		const categoryWidth = Math.min(
			12,
			Math.max(6, ...this.commands.map((item) => visibleWidth(item.category ?? ""))),
		);
		const commandWidth = Math.min(28, Math.max(12, ...this.commands.map((item) => visibleWidth(item.name))));
		const shortcut = truncateToWidth(command.shortcut ?? "", 12, "");
		const descriptionWidth = Math.max(0, width - 4 - categoryWidth - commandWidth - visibleWidth(shortcut) - 6);
		const category = truncateToWidth(command.category ?? "", categoryWidth, "").padStart(categoryWidth);
		const name = truncateToWidth(command.name, commandWidth - 2, "").padEnd(commandWidth);
		const descriptionText = command.argumentHint
			? command.description
				? `${command.argumentHint} — ${command.description}`
				: command.argumentHint
			: (command.description ?? "");
		const description = truncateToWidth(descriptionText.replace(/[\r\n]+/g, " "), descriptionWidth, "");
		const descriptionPadding = " ".repeat(Math.max(0, descriptionWidth - visibleWidth(description)));
		const categoryColor = selected ? "text" : "dim";
		const descriptionColor = selected ? "accent" : "muted";
		return this.renderBoxLine(
			`${theme.fg(categoryColor, category)}  ${theme.bold(theme.fg("text", name))}${theme.fg(descriptionColor, description + descriptionPadding)}  ${theme.bold(theme.fg("accent", shortcut))}`,
			width,
			selected,
		);
	}

	private renderBoxLine(content: string, width: number, selected = false): string {
		const innerWidth = width - 4;
		const truncated = truncateToWidth(content, innerWidth);
		const padded = truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		const body = selected ? theme.bg("selectedBg", padded) : padded;
		const side = theme.fg("borderMuted", "│");
		return `${side} ${body} ${side}`;
	}
}
