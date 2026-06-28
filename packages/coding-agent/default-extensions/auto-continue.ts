/**
 * Auto-Continue Extension
 *
 * Detects when the LLM stops due to max output tokens (stopReason === "length")
 * and automatically:
 * 1. Compacts the conversation if context usage is high (>70%)
 * 2. Sends a "continue" message to resume the conversation
 *
 * This prevents the agent from silently stopping mid-response.
 */

import type { AssistantMessage } from "@free/pi-ai";
import type { ExtensionAPI } from "@free/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let consecutiveContinues = 0;
	const MAX_CONTINUES = 8;
	const COMPACT_THRESHOLD = 70; // compact if context > 70%

	pi.on("agent_end", async (event, ctx) => {
		// Find the last assistant message
		const messages = event.messages;
		let lastAssistant: AssistantMessage | undefined;

		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "assistant") {
				lastAssistant = messages[i] as AssistantMessage;
				break;
			}
		}

		if (!lastAssistant) return;

		// Only act on "length" (max output tokens reached)
		if (lastAssistant.stopReason !== "length") {
			consecutiveContinues = 0;
			return;
		}

		consecutiveContinues++;

		// Safety limit
		if (consecutiveContinues > MAX_CONTINUES) {
			consecutiveContinues = 0;
			ctx.ui.notify(
				`Auto-continue limit (${MAX_CONTINUES}) reached. The task may be too large for a single conversation. Try breaking it into smaller parts.`,
				"warning",
			);
			return;
		}

		// Check context usage — if high, compact first
		const usage = ctx.getContextUsage();
		if (usage?.percent && usage.percent > COMPACT_THRESHOLD) {
			ctx.ui.notify(
				`Context at ${Math.round(usage.percent)}%. Compacting before continuing... (${consecutiveContinues}/${MAX_CONTINUES})`,
				"info",
			);

			// Compact and then continue after it finishes
			ctx.compact({
				customInstructions:
					"The agent was interrupted mid-task due to output token limits. Preserve all task progress, current state, and next steps clearly.",
				onComplete: () => {
					// After compaction, send the continue message
					setTimeout(() => {
						pi.sendUserMessage(
							"The conversation was compacted to free up space. Continue the task from where you left off. Do not repeat completed work.",
						);
					}, 300);
				},
			});
		} else {
			// Context is fine, just continue
			const pct = usage?.percent ? ` (context: ${Math.round(usage.percent)}%)` : "";
			ctx.ui.notify(
				`Response truncated. Auto-continuing...${pct} (${consecutiveContinues}/${MAX_CONTINUES})`,
				"info",
			);

			await new Promise((resolve) => setTimeout(resolve, 300));
			pi.sendUserMessage("Continue from where you left off. Do not repeat what you already said.");
		}
	});
}
