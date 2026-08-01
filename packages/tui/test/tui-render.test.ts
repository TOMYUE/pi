import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Image } from "../src/components/image.ts";
import type { Terminal } from "../src/terminal.ts";
import {
	deleteKittyImage,
	encodeKitty,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";
import { type Component, Container, CURSOR_MARKER, TUI, type TuiMouseEvent } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	inputs: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	invalidate(): void {}
}

class MouseComponent extends TestComponent {
	mouseEvents: TuiMouseEvent[] = [];
	handleMouse(event: TuiMouseEvent): void {
		this.mouseEvents.push(event);
	}
}

class CountingContainer extends Container {
	renderCount = 0;

	override render(width: number): string[] {
		this.renderCount++;
		return super.render(width);
	}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];
	private lifecycleEvents: string[] = [];

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.lifecycleEvents.push("start");
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.lifecycleEvents.push("stop");
		super.stop();
	}

	override write(data: string): void {
		this.writes.push(data);
		this.lifecycleEvents.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	getLifecycleEvents(): string[] {
		return [...this.lifecycleEvents];
	}

	clearWrites(): void {
		this.writes = [];
		this.lifecycleEvents = [];
	}
}

class ThrowingTerminal implements Terminal {
	readonly writes: string[] = [];
	stopCalls = 0;
	readonly columns = 80;
	readonly rows = 24;
	readonly kittyProtocolActive = false;

	start(): void {
		throw new Error("start failed");
	}
	stop(): void {
		this.stopCalls++;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isItalic();
}

describe("TUI debug logging", () => {
	it("writes redraw logs to the provided directory", async () => {
		const logDir = mkdtempSync(join(tmpdir(), "pi-tui-log-"));
		try {
			await withEnv({ PI_DEBUG_REDRAW: "1" }, async () => {
				const terminal = new VirtualTerminal(40, 10);
				const tui = new TUI(terminal, undefined, logDir);
				const component = new TestComponent();
				tui.addChild(component);
				component.lines = ["test"];
				tui.start();
				await terminal.waitForRender();

				assert.match(readFileSync(join(logDir, "pi-debug.log"), "utf-8"), /fullRender: first render/);
				tui.stop();
			});
		} finally {
			rmSync(logDir, { recursive: true, force: true });
		}
	});
});

describe("TUI Kitty image cleanup", () => {
	it("clears reserved Kitty image rows before drawing appended image placements", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(
				writes.includes(`\x1b[2K\r\n\x1b[2K\x1b[1A${imageSequence}\x1b[1B`),
				"reserved rows should be cleared before the image placement is drawn",
			);
			assert.ok(
				!writes.includes(`${imageSequence}\r\n\x1b[2K`),
				"reserved row clears must not run after the image placement is drawn",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("falls back to full redraw when Kitty image pre-clear would scroll", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 2);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			component.lines = ["before", ...image.render(40), "after"];
			tui.requestRender();
			await terminal.waitForRender();

			assert.ok(tui.fullRedraws > redrawsBeforeImage, "unsafe image pre-clear should force a full redraw");
			assert.ok(terminal.getWrites().includes("\x1b[2J"), "fallback should clear and fully redraw");

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("reserves Kitty image rows before drawing during full redraw fallbacks", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["l0", "l1", "l2", "l3", "l4"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["l0", "l1", "l2", "l3", "l4", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(tui.fullRedraws > redrawsBeforeImage, "scrolling image append should force a full redraw");
			assert.ok(
				writes.includes(`\r\n\r\n\x1b[2A${imageSequence}\x1b[2B`),
				"full redraw should reserve visible image rows before drawing the placement",
			);
			assert.ok(
				!writes.includes(`${imageSequence}\r\n\x1b[0m`),
				"full redraw must not write reserved padding rows after drawing the placement",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("does not use cursor-up placement for Kitty images taller than the viewport", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 6 },
				{ widthPx: 60, heightPx: 60 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			assert.ok(imageLines.length > terminal.rows, "test image should exceed the viewport height");

			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender(true);
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes(imageSequence), "image placement should be drawn");
			assert.ok(
				!writes.includes(`\x1b[${imageLines.length - 1}A${imageSequence}`),
				"taller-than-viewport images must keep the #4461 first-row placement path",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("deletes changed image ids before drawing moved placements", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const oldImage = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		component.lines = ["top", oldImage];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const newImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
		component.lines = [newImage, ""];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(42));
		const drawIndex = writes.indexOf(newImage);
		assert.ok(deleteIndex >= 0, "changed old image should be deleted");
		assert.ok(drawIndex >= 0, "new image should be drawn");
		assert.ok(deleteIndex < drawIndex, "old image must be deleted before the new placement is drawn");

		tui.stop();
	});

	it("redraws image lines when an earlier reserved image row changes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 88, moveCursor: false });
		component.lines = ["", image];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["covered", image];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(88));
		const drawIndex = writes.indexOf(image);
		assert.ok(deleteIndex >= 0, "image should be deleted when a reserved row changes");
		assert.ok(drawIndex >= 0, "unchanged image line should be redrawn after deleting the placement");
		assert.ok(deleteIndex < drawIndex, "old placement must be deleted before the image line is redrawn");
		assert.ok(!writes.includes("\x1b[2J"), "reserved row changes should not force a full redraw");

		tui.stop();
	});

	it("deletes previously rendered image ids during full redraws", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = [encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 77, moveCursor: false })];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["plain text"];
		tui.requestRender(true);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(77));
		const clearIndex = writes.indexOf("\x1b[2J");
		assert.ok(deleteIndex >= 0, "previous image should be deleted during full redraw");
		assert.ok(clearIndex >= 0, "full redraw should clear the screen");
		assert.ok(deleteIndex < clearIndex, "old image should be deleted before the screen is cleared");

		tui.stop();
	});
});

describe("TUI resize handling", () => {
	it("triggers full re-render when terminal height changes", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new VirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["Line 0", "Line 1", "Line 2"];
			tui.start();
			await terminal.waitForRender();

			const initialRedraws = tui.fullRedraws;

			// Resize height
			terminal.resize(40, 15);
			await terminal.waitForRender();

			// Should have triggered a full redraw
			assert.ok(tui.fullRedraws > initialRedraws, "Height change should trigger full redraw");

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Line 0"), "Content preserved after height change");

			tui.stop();
		});
	});

	it("skips full re-render on height changes in Termux", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const initialRedraws = tui.fullRedraws;
			for (const height of [15, 8, 14, 11]) {
				terminal.resize(40, height);
				await terminal.waitForRender();
			}

			assert.strictEqual(tui.fullRedraws, initialRedraws, "Height change should not trigger full redraw");
			assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Height change should not clear the screen");
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");

			const viewport = terminal.getViewport();
			assert.ok(viewport.join("\n").includes("Line 19"), "Latest content remains visible after resize");

			tui.stop();
		});
	});

	it("triggers full re-render when terminal width changes", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Resize width
		terminal.resize(60, 10);
		await terminal.waitForRender();

		// Should have triggered a full redraw
		assert.ok(tui.fullRedraws > initialRedraws, "Width change should trigger full redraw");

		tui.stop();
	});
});

describe("TUI content shrinkage", () => {
	it("clears empty rows when content shrinks significantly", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		// Start with many lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Shrink to fewer lines
		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		// Should have triggered a full redraw to clear empty rows
		assert.ok(tui.fullRedraws > initialRedraws, "Content shrinkage should trigger full redraw");

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "First line preserved");
		assert.ok(viewport[1]?.includes("Line 1"), "Second line preserved");
		// Lines below should be empty (cleared)
		assert.strictEqual(viewport[2]?.trim(), "", "Line 2 should be cleared");
		assert.strictEqual(viewport[3]?.trim(), "", "Line 3 should be cleared");

		tui.stop();
	});

	it("handles shrink to single line", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to single line
		component.lines = ["Only line"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Only line"), "Single line rendered");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});

	it("handles shrink to empty", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// All lines should be empty
		assert.strictEqual(viewport[0]?.trim(), "", "Line 0 should be cleared");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});
});

describe("TUI differential rendering", () => {
	it("tracks cursor correctly when content shrinks with unchanged remaining lines", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render: 5 identical lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to 3 lines, all identical to before (no content changes in remaining lines)
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		// cursorRow should be 2 (last line of new content)
		// Verify by doing another render with a change on line 1
		component.lines = ["Line 0", "CHANGED", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// Line 1 should show "CHANGED", proving cursor tracking was correct
		assert.ok(viewport[1]?.includes("CHANGED"), `Expected "CHANGED" on line 1, got: ${viewport[1]}`);

		tui.stop();
	});

	it("renders correctly when only a middle line changes (spinner case)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render
		component.lines = ["Header", "Working...", "Footer"];
		tui.start();
		await terminal.waitForRender();

		// Simulate spinner animation - only middle line changes
		const spinnerFrames = ["|", "/", "-", "\\"];
		for (const frame of spinnerFrames) {
			component.lines = ["Header", `Working ${frame}`, "Footer"];
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Header"), `Header preserved: ${viewport[0]}`);
			assert.ok(viewport[1]?.includes(`Working ${frame}`), `Spinner updated: ${viewport[1]}`);
			assert.ok(viewport[2]?.includes("Footer"), `Footer preserved: ${viewport[2]}`);
		}

		tui.stop();
	});

	it("resets styles after each rendered line", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["\x1b[3mItalic", "Plain"];
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});

	it("renders correctly when first line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only first line
		component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("CHANGED"), `First line changed: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("Line 3"), `Line 3 preserved: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when last line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only last line
		component.lines = ["Line 0", "Line 1", "Line 2", "CHANGED"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED"), `Last line changed: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when multiple non-adjacent lines change", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Change lines 1 and 3, keep 0, 2, 4 the same
		component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("CHANGED 1"), `Line 1 changed: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED 3"), `Line 3 changed: ${viewport[3]}`);
		assert.ok(viewport[4]?.includes("Line 4"), `Line 4 preserved: ${viewport[4]}`);

		tui.stop();
	});

	it("handles transition from content to empty and back to content", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Start with content
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "Initial content rendered");

		// Clear to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		// Add content back - this should work correctly even after empty state
		component.lines = ["New Line 0", "New Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("New Line 0"), `New content rendered: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("New Line 1"), `New content line 1: ${viewport[1]}`);

		tui.stop();
	});

	it("full re-renders when deleted lines move the viewport upward", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should trigger a full redraw");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);

		tui.stop();
	});

	it("appends after a shrink without another full redraw once the viewport is reset", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should reset the viewport with a full redraw");
		const redrawsAfterShrink = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redrawsAfterShrink, "Append should stay on the differential path");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 0", "Line 1", "Line 2", "", ""]);

		tui.stop();
	});

	it("clears stale content when maxLinesRendered was inflated by a transient component", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const chat = new TestComponent();
		const editor = new TestComponent();
		tui.addChild(chat);
		tui.addChild(editor);

		const longChat = Array.from({ length: 15 }, (_, i) => `Chat ${i}`);
		const shortChat = Array.from({ length: 12 }, (_, i) => `Chat ${i}`);
		const editorLines = ["Editor 0", "Editor 1", "Editor 2"];
		const selectorLines = Array.from({ length: 8 }, (_, i) => `Selector ${i}`);

		chat.lines = longChat;
		editor.lines = editorLines;
		tui.start();
		await terminal.waitForRender();

		editor.lines = selectorLines;
		tui.requestRender();
		await terminal.waitForRender();

		editor.lines = editorLines;
		tui.requestRender();
		await terminal.waitForRender();

		const redrawsBeforeSwitch = tui.fullRedraws;
		chat.lines = shortChat;
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > redrawsBeforeSwitch, "Branch switch should trigger a full redraw");

		const viewport = terminal.getViewport();
		for (let i = 0; i < 10; i++) {
			const line = viewport[i] ?? "";
			assert.ok(!line.includes("Chat 12"), `Stale "Chat 12" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 13"), `Stale "Chat 13" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 14"), `Stale "Chat 14" at viewport row ${i}`);
		}

		assert.deepStrictEqual(viewport, [
			"Chat 5",
			"Chat 6",
			"Chat 7",
			"Chat 8",
			"Chat 9",
			"Chat 10",
			"Chat 11",
			"Editor 0",
			"Editor 1",
			"Editor 2",
		]);

		tui.stop();
	});
});

describe("TUI fixed-bottom fullscreen rendering", () => {
	it("restores fullscreen terminal state when terminal startup fails", () => {
		const terminal = new ThrowingTerminal();
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		tui.setFixedBottom(component);

		assert.throws(() => tui.start(), /start failed/);
		assert.strictEqual(terminal.stopCalls, 1);
		assert.strictEqual(
			terminal.writes.join(""),
			"\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l",
		);

		tui.stop();
		assert.strictEqual(terminal.stopCalls, 1);
	});

	it("reuses the transcript for scoped composer renders", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const transcript = new CountingContainer();
		const history = new TestComponent();
		const composer = new TestComponent();
		history.lines = Array.from({ length: 20_000 }, (_, i) => `Line ${i}`);
		composer.lines = ["Composer"];
		transcript.addChild(history);
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(transcript.renderCount, 1);

		for (let i = 0; i < 100; i++) {
			composer.lines = [`Composer ${i}`];
			tui.requestRenderFor(composer);
			await terminal.waitForRender();
		}

		assert.strictEqual(transcript.renderCount, 1);
		assert.strictEqual(terminal.getViewport()[7], "Composer 99");

		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		assert.strictEqual(transcript.renderCount, 1);
		assert.strictEqual(terminal.getViewport()[0], "Line 19987");
		tui.stop();
	});

	it("invalidates the transcript cache for transcript changes, width changes, and full invalidation", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TUI(terminal);
		const transcript = new CountingContainer();
		const history = new TestComponent();
		const composer = new TestComponent();
		history.lines = ["Line 0", "Line 1"];
		composer.lines = ["Composer"];
		transcript.addChild(history);
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.start();
		await terminal.waitForRender();

		history.lines[1] = "Line 1 changed";
		tui.requestRenderFor(history);
		await terminal.waitForRender();
		assert.strictEqual(transcript.renderCount, 2);
		assert.strictEqual(terminal.getViewport()[1], "Line 1 changed");

		const added = new TestComponent();
		added.lines = ["Added"];
		transcript.addChild(added);
		tui.requestRenderFor(transcript);
		await terminal.waitForRender();
		assert.strictEqual(transcript.renderCount, 3);
		assert.ok(terminal.getViewport().includes("Added"));

		transcript.removeChild(added);
		tui.requestRenderFor(transcript);
		await terminal.waitForRender();
		assert.strictEqual(transcript.renderCount, 4);
		assert.ok(!terminal.getViewport().includes("Added"));

		terminal.resize(35, 6);
		await terminal.waitForRender();
		assert.strictEqual(transcript.renderCount, 5);

		tui.invalidate();
		tui.requestRenderFor(composer);
		await terminal.waitForRender();
		assert.strictEqual(transcript.renderCount, 6);
		tui.stop();
	});

	it("lets a dirty transcript request win when it coalesces with a scoped request", async () => {
		const terminal = new VirtualTerminal(30, 5);
		const tui = new TUI(terminal);
		const transcript = new CountingContainer();
		const history = new TestComponent();
		const composer = new TestComponent();
		history.lines = ["Before"];
		composer.lines = ["Composer"];
		transcript.addChild(history);
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.start();
		await terminal.waitForRender();

		composer.lines = ["Composer changed"];
		tui.requestRenderFor(composer);
		history.lines = ["After"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(transcript.renderCount, 2);
		assert.strictEqual(terminal.getViewport()[0], "After");
		assert.strictEqual(terminal.getViewport()[4], "Composer changed");
		tui.stop();
	});

	it("keeps the composer anchored while transcript output streams", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TUI(terminal);
		const transcript = new TestComponent();
		const composer = new TestComponent();
		transcript.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		composer.lines = ["Composer top", "Composer bottom"];
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);

		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), [
			"Line 4",
			"Line 5",
			"Line 6",
			"Line 7",
			"Line 8",
			"Line 9",
			"Composer top",
			"Composer bottom",
		]);

		transcript.lines[9] = "Line 9 streaming";
		transcript.lines.push("Line 10");
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), [
			"Line 5",
			"Line 6",
			"Line 7",
			"Line 8",
			"Line 9 streaming",
			"Line 10",
			"Composer top",
			"Composer bottom",
		]);

		tui.stop();
	});

	it("scrolls only the transcript and holds position while new output arrives", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TUI(terminal);
		const transcript = new TestComponent();
		const composer = new TestComponent();
		transcript.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		composer.lines = ["Composer top", "Composer bottom"];
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;10;3M");
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), [
			"Line 3",
			"Line 4",
			"Line 5",
			"Line 6",
			"Line 7",
			"Line 8",
			"Composer top",
			"Composer bottom",
		]);

		transcript.lines.push("Line 12", "Line 13");
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), [
			"Line 3",
			"Line 4",
			"Line 5",
			"Line 6",
			"Line 7",
			"Line 8",
			"Composer top",
			"Composer bottom",
		]);

		terminal.sendInput("\x1b[<65;10;3M");
		terminal.sendInput("\x1b[<65;10;3M");
		await terminal.waitForRender();
		transcript.lines.push("Line 14");
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), [
			"Line 9",
			"Line 10",
			"Line 11",
			"Line 12",
			"Line 13",
			"Line 14",
			"Composer top",
			"Composer bottom",
		]);

		tui.stop();
	});

	it("supports keyboard transcript paging and boundary navigation with mouse capture on or off", async () => {
		for (const mouseCapture of [false, true]) {
			const terminal = new VirtualTerminal(30, 8);
			const tui = new TUI(terminal);
			tui.setMouseCapture(mouseCapture);
			const transcript = new TestComponent();
			const composer = new TestComponent();
			transcript.lines = Array.from({ length: 16 }, (_, i) => `Line ${i}`);
			composer.lines = ["Composer top", "Composer bottom"];
			tui.addChild(transcript);
			tui.addChild(composer);
			tui.setFixedBottom(composer);
			tui.start();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport().slice(0, 6), [
				"Line 5",
				"Line 6",
				"Line 7",
				"Line 8",
				"Line 9",
				"Line 10",
			]);

			terminal.sendInput("\x1b[1;5H");
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport().slice(0, 6), [
				"Line 0",
				"Line 1",
				"Line 2",
				"Line 3",
				"Line 4",
				"Line 5",
			]);

			terminal.sendInput("\x1b[1;5F");
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport().slice(0, 6), [
				"Line 10",
				"Line 11",
				"Line 12",
				"Line 13",
				"Line 14",
				"Line 15",
			]);

			terminal.sendInput("\x1b[5~");
			terminal.sendInput("\x1b[6~");
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport().slice(0, 6), [
				"Line 10",
				"Line 11",
				"Line 12",
				"Line 13",
				"Line 14",
				"Line 15",
			]);

			tui.stop();
		}
	});

	it("anchors the composer after a Termux height resize", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			const terminal = new VirtualTerminal(30, 8);
			const tui = new TUI(terminal);
			const transcript = new TestComponent();
			const composer = new TestComponent();
			transcript.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
			composer.lines = ["Composer top", "Composer bottom"];
			tui.addChild(transcript);
			tui.addChild(composer);
			tui.setFixedBottom(composer);
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeResize = tui.fullRedraws;

			terminal.resize(30, 10);
			await terminal.waitForRender();
			assert.ok(tui.fullRedraws > redrawsBeforeResize);
			assert.deepStrictEqual(terminal.getViewport(), [
				"Line 4",
				"Line 5",
				"Line 6",
				"Line 7",
				"Line 8",
				"Line 9",
				"Line 10",
				"Line 11",
				"Composer top",
				"Composer bottom",
			]);

			tui.stop();
		});
	});

	it("rerenders height-aware transcript components after a fullscreen resize", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TUI(terminal);
		const transcript: Component = {
			render: () => [`Height ${terminal.rows}`],
			invalidate: () => {},
		};
		const composer = new TestComponent();
		composer.lines = ["Composer"];
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().includes("Height 8"));

		terminal.resize(30, 6);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().includes("Height 6"));
		assert.ok(!terminal.getViewport().includes("Height 8"));

		tui.stop();
	});

	it("keeps the focused composer line visible when the composer is taller than the terminal", async () => {
		const terminal = new VirtualTerminal(30, 5);
		const tui = new TUI(terminal);
		const transcript = new TestComponent();
		const composer = new TestComponent();
		transcript.lines = ["Transcript"];
		composer.lines = Array.from({ length: 8 }, (_, i) =>
			i === 1 ? `Composer ${i}${CURSOR_MARKER}` : `Composer ${i}`,
		);
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), [
			"Composer 1",
			"Composer 2",
			"Composer 3",
			"Composer 4",
			"Composer 5",
		]);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 10, y: 0 });
		tui.stop();
	});

	it("pads a short transcript and composites overlays across the fullscreen frame", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TUI(terminal);
		const transcript = new TestComponent();
		const composer = new TestComponent();
		const overlay = new TestComponent();
		transcript.lines = ["Transcript"];
		composer.lines = ["Composer top", "Composer bottom"];
		overlay.lines = ["Overlay"];
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.start();
		await terminal.waitForRender();

		tui.showOverlay(overlay, { row: 1, col: 2, width: 7 });
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport(), [
			"Transcript",
			"  Overlay".padEnd(30),
			"",
			"",
			"",
			"",
			"Composer top",
			"Composer bottom",
		]);
		tui.stop();
	});

	it("hides Kitty image blocks that cross the transcript boundary", async () => {
		const terminal = new LoggingVirtualTerminal(30, 5);
		const tui = new TUI(terminal);
		const transcript = new TestComponent();
		const composer = new TestComponent();
		const image = encodeKitty("AAAA", { columns: 2, rows: 3, imageId: 91, moveCursor: false });
		transcript.lines = ["before", image, "", "", "after"];
		composer.lines = ["Composer top", "Composer bottom"];
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.start();
		await terminal.waitForRender();

		assert.ok(!terminal.getWrites().includes(image));
		assert.deepStrictEqual(terminal.getViewport(), ["", "", "after", "Composer top", "Composer bottom"]);
		tui.stop();
	});

	it("clips partial iTerm2 image blocks at both transcript boundaries and preserves fully visible blocks", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			const imageLines = image.render(30);
			const payload = imageLines.at(-1) ?? "";
			assert.ok(payload.startsWith("\x1b[2A\x1b]1337;File="));

			for (const { transcriptLines, scrollToTop, visible } of [
				{ transcriptLines: [...imageLines, "after", "tail"], scrollToTop: false, visible: false },
				{ transcriptLines: ["before", "top", ...imageLines, "after"], scrollToTop: true, visible: false },
				{ transcriptLines: imageLines, scrollToTop: false, visible: true },
			]) {
				const terminal = new LoggingVirtualTerminal(30, 5);
				const tui = new TUI(terminal);
				const transcript = new TestComponent();
				const composer = new TestComponent();
				transcript.lines = transcriptLines;
				composer.lines = ["Composer", "Input"];
				tui.addChild(transcript);
				tui.addChild(composer);
				tui.setFixedBottom(composer);
				tui.start();
				await terminal.waitForRender();
				if (scrollToTop) {
					terminal.clearWrites();
					terminal.sendInput("\x1b[1;5H");
					await terminal.waitForRender();
				}

				assert.strictEqual(terminal.getWrites().includes("\x1b]1337;File="), visible);
				assert.strictEqual(terminal.getWrites().includes(payload), visible);
				tui.stop();
			}
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("restores cached iTerm2 and Kitty image blocks after scrolling them through viewport boundaries", async () => {
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			for (const protocol of ["iterm2", "kitty"] as const) {
				setCapabilities({ images: protocol, trueColor: true, hyperlinks: true });
				const image = new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ maxWidthCells: 3 },
					{ widthPx: 30, heightPx: 30 },
				);
				const imageLines = image.render(30);
				const payload = protocol === "iterm2" ? (imageLines.at(-1) ?? "") : imageLines[0];
				for (const { lines, clippedKey, restoreKey } of [
					{
						lines: ["l0", "l1", ...imageLines, "l5", "l6", "l7"],
						clippedKey: "\x1b[1;5F",
						restoreKey: "\x1b[1;5H",
					},
					{ lines: ["l0", "l1", "l2", ...imageLines, "l6"], clippedKey: "\x1b[1;5H", restoreKey: "\x1b[1;5F" },
				]) {
					const terminal = new LoggingVirtualTerminal(30, 7);
					const tui = new TUI(terminal);
					const transcript = new CountingContainer();
					const history = new TestComponent();
					const composer = new TestComponent();
					history.lines = lines;
					composer.lines = ["Composer", "Input"];
					transcript.addChild(history);
					tui.addChild(transcript);
					tui.addChild(composer);
					tui.setFixedBottom(composer);
					tui.start();
					await terminal.waitForRender();

					terminal.clearWrites();
					terminal.sendInput(clippedKey);
					await terminal.waitForRender();
					assert.ok(!terminal.getWrites().includes(payload));
					terminal.clearWrites();
					terminal.sendInput(restoreKey);
					await terminal.waitForRender();
					assert.ok(terminal.getWrites().includes(payload));
					assert.strictEqual(transcript.renderCount, 1);
					tui.stop();
				}
				resetCapabilitiesCache();
			}
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("enters and restores alternate screen and mouse modes exactly once", async () => {
		const terminal = new LoggingVirtualTerminal(30, 5);
		const tui = new TUI(terminal);
		const transcript = new TestComponent();
		const composer = new TestComponent();
		transcript.lines = ["Transcript"];
		composer.lines = ["Composer"];
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.setFocus(composer);
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1002h\x1b[?1006h"));
		terminal.sendInput("\x1b[<0;10;3M");
		assert.deepStrictEqual(composer.inputs, []);
		const startEvents = terminal.getLifecycleEvents();
		assert.ok(startEvents.findIndex((event) => event.includes("\x1b[?1049h")) < startEvents.indexOf("start"));

		terminal.clearWrites();
		tui.stop();
		tui.stop();
		const stopEvents = terminal.getLifecycleEvents();
		assert.ok(stopEvents.indexOf("stop") < stopEvents.findIndex((event) => event.includes("\x1b[?1049l")));
		assert.strictEqual(terminal.getWrites().match(/\x1b\[\?1049l/g)?.length, 1);
		assert.strictEqual(terminal.getWrites().match(/\x1b\[\?1000l/g)?.length, 1);
		assert.strictEqual(terminal.getWrites().match(/\x1b\[\?1002l/g)?.length, 1);
		assert.strictEqual(terminal.getWrites().match(/\x1b\[\?1003l/g)?.length, 1);
		assert.strictEqual(terminal.getWrites().match(/\x1b\[\?1006l/g)?.length, 1);

		terminal.clearWrites();
		tui.requestRender();
		tui.stop();
		await new Promise<void>((resolve) => process.nextTick(resolve));
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getWrites().match(/\x1b\[\?1049h/g)?.length, 1);
		assert.deepStrictEqual(terminal.getViewport(), ["Transcript", "", "", "", "Composer"]);
		tui.stop();
		assert.strictEqual(terminal.getWrites().match(/\x1b\[\?1049l/g)?.length, 1);
	});

	it("routes SGR mouse reports to a focused nested composer descendant", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TUI(terminal);
		const transcript = new TestComponent();
		transcript.lines = Array.from({ length: 12 }, (_, index) => `Line ${index}`);
		const composer = new Container();
		const heading = new TestComponent();
		heading.lines = ["Heading"];
		const editor = new MouseComponent();
		editor.lines = ["Editor 0", "Editor 1"];
		composer.addChild(heading);
		composer.addChild(editor);
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;6;7M");
		terminal.sendInput("\x1b[<0;6;7M");
		terminal.sendInput("\x1b[<32;8;8M");
		terminal.sendInput("\x1b[<0;8;8m");
		await terminal.waitForRender();
		assert.deepStrictEqual(editor.mouseEvents, [
			{ type: "wheel", button: 0, x: 5, y: 0, wheelDirection: "up" },
			{ type: "press", button: 0, x: 5, y: 0, wheelDirection: undefined },
			{ type: "drag", button: 0, x: 7, y: 1, wheelDirection: undefined },
			{ type: "release", button: 0, x: 7, y: 1, wheelDirection: undefined },
		]);

		terminal.sendInput("\x1b[<64;6;2M");
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "Line 4");
		tui.stop();
	});

	it("routes transcript clicks through cached nested layouts after scrolling", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TUI(terminal);
		const transcript = new Container();
		const before = new TestComponent();
		before.lines = Array.from({ length: 9 }, (_, index) => `Before ${index}`);
		const nested = new Container();
		const heading = new TestComponent();
		heading.lines = ["Heading"];
		const disclosure = new MouseComponent();
		disclosure.lines = ["Disclosure", "Details"];
		const after = new TestComponent();
		after.lines = ["After 0", "After 1", "After 2"];
		nested.addChild(heading);
		nested.addChild(disclosure);
		transcript.addChild(before);
		transcript.addChild(nested);
		transcript.addChild(after);
		const composer = new MouseComponent();
		composer.lines = ["Composer"];
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.setFocus(composer);
		tui.start();
		await terminal.waitForRender();

		// Scroll from logical row 8 to row 5, then click logical row 10.
		terminal.sendInput("\x1b[<64;2;2M");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;4;6M");
		await terminal.waitForRender();

		assert.deepStrictEqual(disclosure.mouseEvents, [
			{ type: "press", button: 0, x: 3, y: 0, wheelDirection: undefined },
		]);
		assert.deepStrictEqual(composer.mouseEvents, []);
		tui.stop();
	});

	it("captures primary drag and release above and below the focused editor", async () => {
		for (const releaseRow of [1, 8]) {
			const terminal = new VirtualTerminal(30, 8);
			const tui = new TUI(terminal);
			const transcript = new TestComponent();
			transcript.lines = ["Transcript"];
			const editor = new MouseComponent();
			editor.lines = ["Editor"];
			tui.addChild(transcript);
			tui.addChild(editor);
			tui.setFixedBottom(editor);
			tui.setFocus(editor);
			tui.start();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;5;8M");
			terminal.sendInput(`\x1b[<32;6;${releaseRow}M`);
			terminal.sendInput(`\x1b[<0;6;${releaseRow}m`);
			assert.deepStrictEqual(editor.mouseEvents, [
				{ type: "press", button: 0, x: 4, y: 0, wheelDirection: undefined },
				{ type: "drag", button: 0, x: 5, y: releaseRow - 8, wheelDirection: undefined },
				{ type: "release", button: 0, x: 5, y: releaseRow - 8, wheelDirection: undefined },
			]);
			tui.stop();
		}
	});

	it("keeps primary capture when fixed-bottom geometry changes between press and release", async () => {
		const terminal = new VirtualTerminal(30, 8);
		const tui = new TUI(terminal);
		const transcript = new TestComponent();
		transcript.lines = ["Transcript"];
		const composer = new Container();
		const heading = new TestComponent();
		heading.lines = ["Heading"];
		const editor = new MouseComponent();
		editor.lines = ["Editor 0", "Editor 1"];
		const footer = new TestComponent();
		footer.lines = ["Footer"];
		composer.addChild(heading);
		composer.addChild(editor);
		composer.addChild(footer);
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;6M");
		await terminal.waitForRender();
		footer.lines.push("Footer 2");
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<32;6;2M");
		terminal.sendInput("\x1b[<0;6;2m");

		assert.deepStrictEqual(editor.mouseEvents, [
			{ type: "press", button: 0, x: 4, y: 0, wheelDirection: undefined },
			{ type: "drag", button: 0, x: 5, y: -3, wheelDirection: undefined },
			{ type: "release", button: 0, x: 5, y: -3, wheelDirection: undefined },
		]);
		tui.stop();
	});

	it("consumes SGR horizontal wheel reports without dispatching them", async () => {
		const terminal = new VirtualTerminal(30, 5);
		const tui = new TUI(terminal);
		const editor = new MouseComponent();
		editor.lines = ["Editor"];
		tui.addChild(editor);
		tui.setFixedBottom(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<66;5;5M");
		terminal.sendInput("\x1b[<67;5;5M");
		assert.deepStrictEqual(editor.mouseEvents, []);
		assert.deepStrictEqual(editor.inputs, []);
		tui.stop();
	});

	it("does not enable or consume mouse reports when capture is off and still disables all modes", async () => {
		const terminal = new LoggingVirtualTerminal(30, 5);
		const tui = new TUI(terminal);
		const transcript = new TestComponent();
		const composer = new TestComponent();
		transcript.lines = ["Transcript"];
		composer.lines = ["Composer"];
		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFixedBottom(composer);
		tui.setFocus(composer);
		tui.setMouseCapture(false);

		tui.start();
		await terminal.waitForRender();
		assert.ok(!terminal.getWrites().includes("\x1b[?1000h"));
		assert.ok(!terminal.getWrites().includes("\x1b[?1006h"));

		const report = "\x1b[<64;10;3M";
		terminal.sendInput(report);
		assert.deepStrictEqual(composer.inputs, [report]);

		terminal.clearWrites();
		tui.stop();
		for (const mode of [1000, 1002, 1003, 1006]) {
			assert.ok(terminal.getWrites().includes(`\x1b[?${mode}l`));
		}
	});
});
