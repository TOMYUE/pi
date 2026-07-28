import { type Component, Container, Markdown, type MarkdownTheme, truncateToWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class UserMessageContent implements Component {
	private readonly markdown: Markdown;
	private outputPad: number;

	constructor(text: string, markdownTheme: MarkdownTheme, outputPad: number) {
		const userMarkdownTheme: MarkdownTheme = {
			...markdownTheme,
			italic: (content) => `\x1b[3m${content}\x1b[23m`,
		};
		this.markdown = new Markdown(
			text,
			0,
			0,
			userMarkdownTheme,
			{ italic: true },
			{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
		);
		this.outputPad = outputPad;
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}

	render(width: number): string[] {
		const leftPadding = " ".repeat(this.outputPad);
		const prefix = `${leftPadding}${theme.fg("success", "│")} `;
		const contentWidth = Math.max(1, width - this.outputPad - 2);
		const lines = this.markdown.render(contentWidth).map((line) => truncateToWidth(`${prefix}${line}`, width, ""));

		// Leave OSC 133's closing marker on its own zero-width row so terminals
		// do not mistake the final prompt row for the start of agent output.
		return [...lines, truncateToWidth(leftPadding, width, "")];
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private content?: UserMessageContent;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		if (this.outputPad === padding) return;
		this.outputPad = padding;
		this.content?.setOutputPad(padding);
	}

	private rebuild(): void {
		this.clear();
		this.content = new UserMessageContent(this.text, this.markdownTheme, this.outputPad);
		this.addChild(this.content);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
