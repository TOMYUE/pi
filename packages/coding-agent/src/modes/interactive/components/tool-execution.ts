import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

class ToolDisclosureComponent implements Component {
	private readonly component: Component;
	private readonly isExpanded: () => boolean;
	private readonly getStatusMarker: () => string;

	constructor(component: Component, isExpanded: () => boolean, getStatusMarker: () => string) {
		this.component = component;
		this.isExpanded = isExpanded;
		this.getStatusMarker = getStatusMarker;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		const lines = this.component.render(contentWidth);
		const headerRow = lines.findIndex((line) => stripAnsi(line).trim().length > 0);
		if (headerRow < 0) return [];

		const disclosure = this.isExpanded() ? "▼" : "▶";
		const trailingSpaces = stripAnsi(lines[headerRow]).match(/\s+$/)?.[0].length ?? 0;
		const callSummary = truncateToWidth(
			lines[headerRow],
			Math.max(1, visibleWidth(lines[headerRow]) - trailingSpaces),
			"",
		);
		const header = truncateToWidth(
			`${this.getStatusMarker()} ${callSummary} ${theme.fg("toolTitle", disclosure)}`,
			width,
			"",
		);
		if (!this.isExpanded()) return [header];
		return [...lines.slice(0, headerRow), header, ...lines.slice(headerRow + 1)];
	}

	invalidate(): void {
		this.component.invalidate?.();
	}
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private callDisclosureComponent?: ToolDisclosureComponent;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;
	private toggleRow = -1;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 0);
		this.contentText = new Text("", 1, 0);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	private getStatusMarker(): string {
		if (this.isPartial) return theme.fg("muted", "·");
		if (this.result?.isError) return theme.fg("error", "✗");
		return theme.fg("success", "✓");
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (result.isError && !isPartial) {
			this.expanded = true;
		}
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	handleMouse(event: TuiMouseEvent): void {
		if (event.type === "press" && event.button === 0 && event.y === this.toggleRow) {
			this.setExpanded(!this.expanded);
		}
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			this.toggleRow = -1;
			return [];
		}

		let lines: string[];
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				this.toggleRow = -1;
				return [];
			}

			lines = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
		} else {
			lines = super.render(width);
		}

		this.toggleRow = lines.findIndex((line) => line.includes("▶") || line.includes("▼"));
		return lines;
	}

	private updateDisplay(): void {
		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				this.callDisclosureComponent = new ToolDisclosureComponent(
					this.createCallFallback(),
					() => this.expanded,
					() => this.getStatusMarker(),
				);
				renderContainer.addChild(this.callDisclosureComponent);
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					this.callDisclosureComponent = new ToolDisclosureComponent(
						component,
						() => this.expanded,
						() => this.getStatusMarker(),
					);
					renderContainer.addChild(this.callDisclosureComponent);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					this.callDisclosureComponent = new ToolDisclosureComponent(
						this.createCallFallback(),
						() => this.expanded,
						() => this.getStatusMarker(),
					);
					renderContainer.addChild(this.callDisclosureComponent);
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					if (this.expanded) {
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						if (this.expanded) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					} catch {
						this.resultRendererComponent = undefined;
						if (this.expanded) {
							const component = this.createResultFallback();
							if (component) {
								renderContainer.addChild(component);
								hasContent = true;
							}
						}
					}
				}
			}
		} else {
			this.contentText.setText(this.formatToolExecution(this.expanded));
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result && this.expanded) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(includeDetails: boolean): string {
		const disclosure = includeDetails ? "▼" : "▶";
		let text = `${this.getStatusMarker()} ${theme.fg("toolTitle", theme.bold(this.toolName))} ${theme.fg("toolTitle", disclosure)}`;
		if (!includeDetails) return text;
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
