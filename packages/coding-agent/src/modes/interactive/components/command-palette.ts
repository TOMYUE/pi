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
	onCancel: (draft: string) => void;
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
			this.options.onCancel(this.getDraft());
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
		if (width < 4) return [truncateToWidth("Commands", Math.max(1, width))];

		const lines: string[] = [];
		const innerWidth = width - 4;
		const border = (text: string) => theme.fg("borderAccent", text);
		lines.push(border(`┌${"─".repeat(width - 2)}┐`));
		lines.push(this.renderBoxLine(theme.bold(theme.fg("accent", "Slash commands")), width));

		const searchLabel = theme.fg("muted", "Search: /");
		const searchWidth = Math.max(1, innerWidth - visibleWidth(searchLabel));
		const searchLine = this.searchInput.render(searchWidth)[0] ?? "";
		lines.push(this.renderBoxLine(`${searchLabel}${searchLine}`, width));
		lines.push(border(`├${"─".repeat(width - 2)}┤`));

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
		lines.push(this.renderBoxLine(hint, width));
		lines.push(border(`└${"─".repeat(width - 2)}┘`));
		return lines;
	}

	private getDraft(): string {
		return `/${this.searchInput.getValue().replace(/^\/+/, "")}`;
	}

	private renderCommand(command: SlashCommand, selected: boolean, width: number): string {
		const prefix = selected ? "› " : "  ";
		const name = theme.fg(selected ? "accent" : "text", `/${command.name}`);
		const argumentHint = command.argumentHint ? theme.fg("muted", ` ${command.argumentHint}`) : "";
		const description = command.description ? theme.fg("muted", `  ${command.description}`) : "";
		return this.renderBoxLine(`${prefix}${name}${argumentHint}${description}`, width, selected);
	}

	private renderBoxLine(content: string, width: number, selected = false): string {
		const innerWidth = width - 4;
		const truncated = truncateToWidth(content, innerWidth);
		const padded = truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
		const body = selected ? theme.bg("selectedBg", padded) : padded;
		const side = theme.fg("borderAccent", "│");
		return `${side} ${body} ${side}`;
	}
}
