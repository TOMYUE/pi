/**
 * Hidden Thinking Label Extension
 *
 * Demonstrates `ctx.ui.setHiddenThinkingLabel()` for customizing the label shown
 * when thinking blocks are hidden.
 *
 * Usage:
 *   pi --extension examples/extensions/hidden-thinking-label.ts
 *
 * Test:
 *   1. Load this extension
 *   2. Hide thinking blocks with Ctrl+T
 *   3. Ask for something that produces reasoning output
 *   4. The collapsed thinking block label will show the custom text
 *
 * Commands:
 *   /thinking-label <text>   Set a custom hidden thinking label
 *   /thinking-label          Reset to the default label
 */

import type { ExtensionAPI, ExtensionContext, HiddenThinkingLabels } from "@earendil-works/pi-coding-agent";

const CUSTOM_LABELS: HiddenThinkingLabels = { active: "Pondering...", complete: "Pondered" };
const BUILT_IN_LABELS: HiddenThinkingLabels = { active: "Thinking...", complete: "Thought" };

export default function (pi: ExtensionAPI) {
	let labels: string | HiddenThinkingLabels = CUSTOM_LABELS;

	const applyLabel = (ctx: ExtensionContext) => {
		ctx.ui.setHiddenThinkingLabel(labels);
	};

	pi.on("session_start", async (_event, ctx) => {
		applyLabel(ctx);
	});

	pi.registerCommand("thinking-label", {
		description: "Set the hidden thinking label. Use without args to reset.",
		handler: async (args, ctx) => {
			const nextLabel = args.trim();

			if (!nextLabel) {
				labels = BUILT_IN_LABELS;
				ctx.ui.setHiddenThinkingLabel();
				ctx.ui.notify("Hidden thinking labels reset to: Thinking... / Thought");
				return;
			}

			labels = nextLabel;
			ctx.ui.setHiddenThinkingLabel(labels);
			ctx.ui.notify(`Hidden thinking label set to: ${labels}`);
		},
	});
}
