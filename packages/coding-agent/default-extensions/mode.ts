/**
 * /mode command:
 * - /mode plan  -> read-only plan workflow
 * - /mode agent -> restore normal agent workflow
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@free/pi-agent-core";
import type { AssistantMessage, TextContent } from "@free/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@free/pi-coding-agent";
import {
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "./mode-utils.js";

const SUBCOMMANDS = ["plan", "agent"] as const;
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const DEFAULT_AGENT_TOOLS = ["read", "bash", "edit", "write"];

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function parseSubcommand(args: string): { sub: string; rest: string } {
	const text = args.trim();
	if (!text) return { sub: "", rest: "" };
	const match = /^(\S+)\s*(.*)$/s.exec(text);
	if (!match) return { sub: "", rest: "" };
	return { sub: match[1], rest: match[2] };
}

function buildPlanMarkdown(assistantPlan: string, items: TodoItem[]): string {
	const lines = [
		"# Implementation Plan",
		"",
		`Generated: ${new Date().toISOString()}`,
		"",
		"## Agent Plan Output",
		"",
		assistantPlan.trim().length > 0 ? assistantPlan.trim() : "_No plan output was captured._",
		"",
		"## Parsed Steps",
		"",
	];
	if (items.length === 0) {
		lines.push("_No numbered steps were parsed from the output._");
	} else {
		for (const item of items) {
			lines.push(`${item.step}. ${item.text}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

function makePlanFileName(): string {
	const now = new Date();
	const yyyy = String(now.getFullYear());
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	const hh = String(now.getHours()).padStart(2, "0");
	const mi = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `plan-${yyyy}${mm}${dd}-${hh}${mi}${ss}.md`;
}

async function hasCodeGraphFolder(cwd: string): Promise<boolean> {
	try {
		const candidate = join(cwd, ".code-graph");
		const info = await stat(candidate);
		return info.isDirectory();
	} catch {
		return false;
	}
}

function validateCodeGraphResearch(markdown: string, requireCodeGraph: boolean): string | null {
	if (!requireCodeGraph) {
		return null;
	}
	if (!/(^|\n)\s*(##\s*)?CodeGraph Research\s*($|\n)/i.test(markdown)) {
		return "Missing required section '## CodeGraph Research'.";
	}
	if (!/codeGraph-context|code_context/i.test(markdown)) {
		return "Missing required evidence for codeGraph-context.";
	}
	if (!/codeGraph-callers|code_callers/i.test(markdown)) {
		return "Missing required evidence for codeGraph-callers.";
	}
	if (/\b(fallido|failed|blocked|bloqueado|not available|no ejecutado)\b/i.test(markdown)) {
		return "CodeGraph research indicates failure/blocked execution. Run the mandatory codeGraph sequence successfully before planning.";
	}
	return null;
}

export default function modeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlan: string[] = [];
	let lastPlanFilePath: string | null = null;
	let lastPlanMarkdown = "";
	let requireCodeGraphResearch = false;

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((item) => item.completed).length;
			ctx.ui.setStatus("mode", `plan ${completed}/${todoItems.length}`);
		} else if (planModeEnabled) {
			ctx.ui.setStatus("mode", "plan");
		} else {
			ctx.ui.setStatus("mode", undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) =>
				item.completed ? `[x] ${item.text}` : `[ ] ${item.text}`,
			);
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function restoreAgentTools(): string[] {
		return toolsBeforePlan.length > 0 ? toolsBeforePlan : DEFAULT_AGENT_TOOLS;
	}

	async function enterPlanMode(ctx: ExtensionContext): Promise<void> {
		if (planModeEnabled) {
			ctx.ui.notify("Plan mode is already active.", "info");
			return;
		}
		requireCodeGraphResearch = await hasCodeGraphFolder(ctx.cwd);
		toolsBeforePlan = pi.getActiveTools();
		planModeEnabled = true;
		executionMode = false;
		todoItems = [];
		lastPlanFilePath = null;
		lastPlanMarkdown = "";
		pi.setActiveTools(PLAN_MODE_TOOLS);
		updateStatus(ctx);
		ctx.ui.notify("Mode set to plan.", "info");
	}

	function enterAgentMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
		executionMode = false;
		todoItems = [];
		requireCodeGraphResearch = false;
		pi.setActiveTools(restoreAgentTools());
		updateStatus(ctx);
		ctx.ui.notify("Mode set to agent.", "info");
	}

	function persistState(): void {
		pi.appendEntry("mode-state", {
			planModeEnabled,
			executionMode,
			todoItems,
			toolsBeforePlan,
			lastPlanFilePath,
			lastPlanMarkdown,
			requireCodeGraphResearch,
		});
	}

	async function persistPlanFile(cwd: string): Promise<string> {
		const planDir = join(cwd, "plan");
		await mkdir(planDir, { recursive: true });
		const filePath = lastPlanFilePath ?? join(planDir, makePlanFileName());
		const markdown = buildPlanMarkdown(lastPlanMarkdown, todoItems);
		await writeFile(filePath, markdown, "utf-8");
		lastPlanFilePath = filePath;
		return filePath;
	}

	pi.registerCommand("mode", {
		description: "Set mode: /mode plan | /mode agent",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trimStart();
			const parts = p.split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				return SUBCOMMANDS.map((s) => ({ value: `${s} `, label: s }));
			}
			if (parts.length === 1) {
				const filtered = SUBCOMMANDS.filter((s) => s.startsWith(parts[0]));
				return filtered.map((s) => ({ value: `${s} `, label: s }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const { sub } = parseSubcommand(args);
			if (!sub) {
				ctx.ui.notify("Usage: /mode plan | /mode agent", "info");
				return;
			}
			if (sub === "plan") {
				await enterPlanMode(ctx);
				persistState();
				return;
			}
			if (sub === "agent") {
				enterAgentMode(ctx);
				persistState();
				return;
			}
			ctx.ui.notify("Unknown subcommand. Use: plan, agent", "warning");
		},
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;
		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode blocked bash command.\nUse /mode agent first.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled) return;
		return {
			messages: event.messages.filter((message) => {
				const msg = message as AgentMessage & { customType?: string };
				if (msg.customType === "mode-plan-context") return false;
				if (msg.role !== "user") return true;
				if (typeof msg.content === "string") {
					return !msg.content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(msg.content)) {
					return !msg.content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			const codeGraphInstructions = requireCodeGraphResearch
				? `Before analyzing code or writing any plan, run this mandatory research sequence:
1. Execute /codeGraph-context for relevant symbols/files.
2. Execute /codeGraph-callers for impact/call sites.
3. Only then write the plan.
Do not run /codeGraph-index automatically in plan mode. Use it only if the user explicitly asks.`
				: `CodeGraph is optional for this run because \`.code-graph\` does not exist in the repo root.
Do not force codeGraph commands; continue with normal read-only analysis.`;
			return {
				message: {
					customType: "mode-plan-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode (read-only).

Restrictions:
- Allowed tools: read, bash, grep, find, ls, questionnaire
- Disallowed tools: edit, write
- Bash is restricted to an allowlist of read-only commands

${codeGraphInstructions}

If codeGraph commands fail, explicitly state the failure and continue with best-effort fallback analysis.

Respond in Markdown with this exact structure. Use the literal headings exactly (including leading ##):

## Goal
One concise paragraph.

## CodeGraph Research
- codeGraph-context: symbols/paths reviewed
- codeGraph-callers: impacted callers found

## Files To Modify
- \`path/to/file.ext\` - why this file changes

## Implementation Steps
1. First step
2. Second step
...

## Validation
- checks/tests to run

## Risks
- potential regressions and mitigations`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((item) => !item.completed);
			const todoList = remaining.map((item) => `${item.step}. ${item.text}`).join("\n");
			return {
				message: {
					customType: "mode-plan-execution-context",
					content: `[EXECUTING PLAN]
Remaining steps:
${todoList}

Execute in order and mark completions with [DONE:n].`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((item) => item.completed)) {
				pi.sendMessage(
					{
						customType: "mode-plan-complete",
						content: "Plan complete.",
						display: true,
					},
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				pi.setActiveTools(restoreAgentTools());
				updateStatus(ctx);
				persistState();
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			lastPlanMarkdown = getTextContent(lastAssistant);
			const extracted = extractTodoItems(lastPlanMarkdown);
			todoItems = extracted;
			const planPath = await persistPlanFile(ctx.cwd);
			pi.sendMessage(
				{
					customType: "mode-plan-file",
					content: `Saved plan to ${planPath}`,
					display: true,
				},
				{ triggerTurn: false },
			);
			if (extracted.length === 0) {
				pi.sendMessage(
					{
						customType: "mode-plan-no-steps",
						content:
							"Plan saved, but no numbered steps were parsed. Use the requested format with an 'Implementation Steps' numbered list.",
						display: true,
					},
					{ triggerTurn: false },
				);
			}
		}

		const codeGraphIssue = validateCodeGraphResearch(lastPlanMarkdown, requireCodeGraphResearch);
		if (codeGraphIssue) {
			pi.sendMessage(
				{
					customType: "mode-plan-codegraph-required",
					content: `Plan rejected: ${codeGraphIssue}`,
					display: true,
				},
				{ triggerTurn: false },
			);
			pi.sendUserMessage(
				"Regenerate the plan. Run /codeGraph-context, then /codeGraph-callers. Do not run /codeGraph-index automatically. Report successful outputs in '## CodeGraph Research'.",
			);
			persistState();
			return;
		}

		if (todoItems.length > 0) {
			const todoText = todoItems.map((item) => `${item.step}. [ ] ${item.text}`).join("\n");
			pi.sendMessage(
				{
					customType: "mode-plan-todos",
					content: `Plan steps:\n\n${todoText}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode - next action", [
			todoItems.length > 0 ? "Execute the plan" : "Execute",
			"Stay in plan mode",
			"Refine plan",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			pi.setActiveTools(restoreAgentTools());
			updateStatus(ctx);
			const execMessage =
				todoItems.length > 0
					? `Execute the plan. Start with: ${todoItems[0].text}`
					: "Execute the plan you just created.";
			pi.sendMessage(
				{
					customType: "mode-plan-execute",
					content: execMessage,
					display: true,
				},
				{ triggerTurn: true },
			);
		} else if (choice === "Refine plan") {
			const refinement = await ctx.ui.editor("Refine the plan", "");
			if (refinement?.trim()) {
				pi.sendUserMessage(refinement.trim());
			}
		}

		persistState();
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const modeEntry = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "mode-state")
			.pop() as
			| {
					data?: {
						planModeEnabled?: boolean;
						executionMode?: boolean;
						todoItems?: TodoItem[];
						toolsBeforePlan?: string[];
						lastPlanFilePath?: string | null;
						lastPlanMarkdown?: string;
						requireCodeGraphResearch?: boolean;
					};
			  }
			| undefined;

		if (modeEntry?.data) {
			planModeEnabled = modeEntry.data.planModeEnabled === true;
			executionMode = modeEntry.data.executionMode === true;
			todoItems = Array.isArray(modeEntry.data.todoItems) ? modeEntry.data.todoItems : [];
			toolsBeforePlan = Array.isArray(modeEntry.data.toolsBeforePlan) ? modeEntry.data.toolsBeforePlan : [];
			lastPlanFilePath =
				typeof modeEntry.data.lastPlanFilePath === "string" ? modeEntry.data.lastPlanFilePath : null;
			lastPlanMarkdown =
				typeof modeEntry.data.lastPlanMarkdown === "string" ? modeEntry.data.lastPlanMarkdown : "";
			requireCodeGraphResearch = modeEntry.data.requireCodeGraphResearch === true;
		}

		if (!planModeEnabled) {
			requireCodeGraphResearch = false;
		} else {
			requireCodeGraphResearch = await hasCodeGraphFolder(ctx.cwd);
		}

		if (executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { customType?: string };
				if (entry.customType === "mode-plan-execute") {
					executeIndex = i;
					break;
				}
			}
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		} else if (executionMode) {
			pi.setActiveTools(restoreAgentTools());
		}

		updateStatus(ctx);
	});
}
