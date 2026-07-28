import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class ThinkingBlockComponent extends Container {
	private text: string;
	private expanded: boolean;
	private markdownTheme: MarkdownTheme;
	private label: string;
	private outputPad: number;

	constructor(text: string, expanded: boolean, markdownTheme: MarkdownTheme, label: string, outputPad: number) {
		super();
		this.text = text;
		this.expanded = expanded;
		this.markdownTheme = markdownTheme;
		this.label = label;
		this.outputPad = outputPad;
		this.rebuild();
	}

	update(text: string, markdownTheme: MarkdownTheme, label: string, outputPad: number): void {
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.label = label;
		this.outputPad = outputPad;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	handleMouse(event: TuiMouseEvent): void {
		if (event.type === "press" && event.button === 0 && event.y === 0) {
			this.setExpanded(!this.expanded);
		}
	}

	private rebuild(): void {
		this.clear();
		const disclosure = this.expanded ? "▼" : "▶";
		this.addChild(new Text(theme.italic(theme.fg("thinkingText", `${disclosure} ${this.label}`)), this.outputPad, 0));
		if (this.expanded) {
			this.addChild(
				new Markdown(this.text, this.outputPad + 2, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("thinkingText", text),
					italic: true,
				}),
			);
		}
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private thinkingBlocks: ThinkingBlockComponent[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = true,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		for (const block of this.thinkingBlocks) {
			block.setExpanded(!hide);
		}
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		let thinkingBlockIndex = 0;
		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme));
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				let thinkingBlock = this.thinkingBlocks[thinkingBlockIndex];
				if (!thinkingBlock) {
					thinkingBlock = new ThinkingBlockComponent(
						thinkingBlocks.join("\n\n"),
						!this.hideThinkingBlock,
						this.markdownTheme,
						this.hiddenThinkingLabel,
						this.outputPad,
					);
					this.thinkingBlocks.push(thinkingBlock);
				} else {
					thinkingBlock.update(
						thinkingBlocks.join("\n\n"),
						this.markdownTheme,
						this.hiddenThinkingLabel,
						this.outputPad,
					);
				}
				thinkingBlockIndex++;
				this.contentContainer.addChild(thinkingBlock);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}
		this.thinkingBlocks.length = thinkingBlockIndex;

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					theme.fg(
						"error",
						"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					),
					this.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
