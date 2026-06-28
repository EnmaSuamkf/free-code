/**
 * Minimal — Footer: thinking level + project + model/context/tokens + extension status line(s)
 *
 * Line 1: Thinking level: off
 * Line 2: ~/path/to/project (branch)
 * Line 3: model + [####------] pct%  (left) ·  tokIn in · tokOut out · $cost  (right)
 * Line 4 (optional): statuses from ctx.ui.setStatus() (e.g. damage-control), same as built-in footer
 *
 * Matches the model / consumption bar / token in-out layout from examples/extensions/tool-counter.ts
 */

import type { AssistantMessage } from "@free/pi-ai";
import type { ExtensionAPI } from "@free/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@free/pi-tui";
import { homedir } from "node:os";

function sanitizeExtensionStatusLine(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function shortenPath(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

export default function (pi: ExtensionAPI) {
	let shellCwd: string | undefined;

	pi.events.on("direct-bash:cwd", (cwd: string | undefined) => {
		shellCwd = cwd;
	});

	pi.on("session_start", async (_event, ctx) => {
		shellCwd = undefined;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			const unsubCwd = pi.events.on("direct-bash:cwd", () => tui.requestRender());

			return {
				dispose() {
					unsubBranch();
					unsubCwd();
				},
				invalidate() {},
				render(width: number): string[] {
					const thinkingLevel = pi.getThinkingLevel();
					const line0 = truncateToWidth(theme.fg("dim", ` Thinking level: ${thinkingLevel}`), width);

					const branch = footerData.getGitBranch();
					const effectiveCwd = shellCwd && shellCwd !== ctx.cwd ? shellCwd : ctx.cwd;
					const projectPath = shortenPath(effectiveCwd);
					const pathPart = branch ? `${projectPath} (${branch})` : projectPath;
					const line1 = truncateToWidth(theme.fg("dim", ` ${pathPart}`), width);

					let tokIn = 0;
					let tokOut = 0;
					let cost = 0;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							tokIn += m.usage.input + m.usage.cacheWrite;
							tokOut += m.usage.output;
							cost += m.usage.cost.total;
						}
					}

					const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

					const usage = ctx.getContextUsage();
					const pctRaw = usage?.percent;
					const pct = pctRaw !== null && pctRaw !== undefined ? pctRaw : 0;
					const filled = Math.round(pct / 10) || 1;
					const model = ctx.model?.id || "no-model";

					const l2Left =
						theme.fg("dim", ` ${model} `) +
						theme.fg("warning", "[") +
						theme.fg("success", "#".repeat(filled)) +
						theme.fg("dim", "-".repeat(10 - filled)) +
						theme.fg("warning", "]") +
						theme.fg("dim", " ") +
						theme.fg("accent", `${Math.round(pct)}%`);

					const l2Right =
						theme.fg("success", `${fmt(tokIn)}`) +
						theme.fg("dim", " in ") +
						theme.fg("accent", `${fmt(tokOut)}`) +
						theme.fg("dim", " out ") +
						theme.fg("warning", `$${cost.toFixed(4)}`) +
						theme.fg("dim", " ");

					const pad = " ".repeat(Math.max(1, width - visibleWidth(l2Left) - visibleWidth(l2Right)));
					const line2 = truncateToWidth(l2Left + pad + l2Right, width, "");

					const lines = [line0, line1, line2];
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeExtensionStatusLine(text))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
	});
}
