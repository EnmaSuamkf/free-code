import type { AgentMessage } from "@free/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage, UserMessage } from "@free/pi-ai";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { APP_NAME } from "../config.js";
import type {
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
} from "./messages.js";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionInfoEntry,
	SessionMessageEntry,
	SessionTreeNode,
	ThinkingLevelChangeEntry,
} from "./session-manager.js";
import { SessionManager } from "./session-manager.js";

function longestBacktickRun(s: string): number {
	let max = 0;
	let cur = 0;
	for (const ch of s) {
		if (ch === "`") {
			cur++;
			max = Math.max(max, cur);
		} else {
			cur = 0;
		}
	}
	return max;
}

/** Safe fenced code block: fence length beats any run of backticks inside `body`. */
export function fencedBlock(lang: string, body: string): string {
	const inner = longestBacktickRun(body);
	const fence = "`".repeat(Math.max(3, inner + 1));
	return `${fence}${lang}\n${body.replace(/\n+$/u, "")}\n${fence}`;
}

function formatUserContent(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "image") {
			parts.push(`\n[_image attachment: ${block.mimeType}, ${block.data.length} base64 chars_]\n`);
		}
	}
	return parts.join("");
}

function formatAssistantContent(msg: AssistantMessage): string {
	const sections: string[] = [];
	const content = msg.content;
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (block.type === "text") {
			sections.push((block as TextContent).text);
		} else if (block.type === "thinking") {
			const parts: string[] = [];
			const t = block.thinking?.trim();
			if (t) {
				parts.push(`### Thinking\n\n${t}`);
			}
			if (block.redacted) {
				parts.push("_Thinking redacted by provider._");
			}
			if (parts.length > 0) {
				sections.push(parts.join("\n\n"));
			}
		} else if (block.type === "toolCall") {
			const tc = block as ToolCall;
			const argsJson = JSON.stringify(tc.arguments ?? {}, null, 2);
			sections.push(`### Tool call: \`${tc.name}\` (\`${tc.id}\`)\n\n${fencedBlock("json", argsJson)}`);
		}
	}
	return sections.join("\n\n");
}

function formatToolResultMessage(msg: ToolResultMessage): string {
	const header = `### Tool result: \`${msg.toolName}\` (\`${msg.toolCallId}\`)${msg.isError ? " **error**" : ""}`;
	const textParts: string[] = [];
	for (const c of msg.content) {
		if (c.type === "text") textParts.push(c.text);
		else if (c.type === "image") {
			textParts.push(`[_image ${c.mimeType}, ${c.data.length} base64 chars_]`);
		}
	}
	let body = textParts.join("\n\n");
	if (msg.details !== undefined && msg.details !== null) {
		try {
			body += `\n\n#### Details\n\n${fencedBlock("json", JSON.stringify(msg.details, null, 2))}`;
		} catch {
			body += `\n\n#### Details\n\n${String(msg.details)}`;
		}
	}
	return `${header}\n\n${body}`;
}

/** Format non-core AgentMessage roles (bashExecution, custom, …). */
function formatExtendedAgentMessage(msg: AgentMessage): string {
	const r = (msg as { role: string }).role;
	switch (r) {
		case "bashExecution": {
			const m = msg as BashExecutionMessage;
			const lines = [
				`command: ${fencedBlock("bash", m.command)}`,
				m.exitCode !== undefined ? `exit: ${m.exitCode}` : "",
				m.cancelled ? "cancelled: yes" : "",
				m.truncated ? "truncated: yes" : "",
				m.fullOutputPath ? `full output: ${m.fullOutputPath}` : "",
				`output:\n\n${fencedBlock("text", m.output)}`,
			];
			return lines.filter(Boolean).join("\n\n");
		}
		case "custom": {
			const m = msg as CustomMessage;
			const content =
				typeof m.content === "string"
					? m.content
					: m.content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("");
			const meta = [`customType: ${m.customType}`, m.display === false ? "display: hidden" : ""]
				.filter(Boolean)
				.join("\n");
			return [`### Custom (${m.customType})`, meta, content].filter(Boolean).join("\n\n");
		}
		case "branchSummary": {
			const m = msg as BranchSummaryMessage;
			return `### Branch summary (from ${m.fromId})\n\n${m.summary}`;
		}
		case "compactionSummary": {
			const m = msg as CompactionSummaryMessage;
			return `### Compaction summary (~${m.tokensBefore} tokens before)\n\n${m.summary}`;
		}
		default:
			return fencedBlock("json", JSON.stringify(msg, null, 2));
	}
}

function formatSessionMessageEntry(entry: SessionMessageEntry): string {
	const msg = entry.message;
	const ts = entry.timestamp ? `\n_${entry.timestamp}_\n` : "";

	switch (msg.role) {
		case "user": {
			const u = msg as UserMessage;
			const body = formatUserContent(u.content);
			return `## User${ts}\n\n${body}`;
		}
		case "assistant": {
			const a = msg as AssistantMessage;
			const meta = `model: ${a.model} · provider: ${a.api}/${a.provider} · stop: ${a.stopReason}`;
			const usage = `tokens in/out/total: ${a.usage.input}/${a.usage.output}/${a.usage.totalTokens}`;
			const err = a.errorMessage ? `\n_error: ${a.errorMessage}_` : "";
			const body = formatAssistantContent(a);
			return `## Assistant\n\n_${meta}_\n_${usage}_${err}\n\n${body}`;
		}
		case "toolResult":
			return `## Tool result${ts}\n\n${formatToolResultMessage(msg as ToolResultMessage)}`;
		default:
			return `## Message (${msg.role})${ts}\n\n${formatExtendedAgentMessage(msg)}`;
	}
}

function formatCompactionEntry(entry: CompactionEntry): string {
	const details =
		entry.details !== undefined ? `\n\n${fencedBlock("json", JSON.stringify(entry.details, null, 2))}` : "";
	return `## Compaction\n\nReduced context (~${entry.tokensBefore} tokens before). Kept from entry \`${entry.firstKeptEntryId}\`.\n\n${entry.summary}${details}`;
}

function formatBranchSummaryEntry(entry: BranchSummaryEntry): string {
	const details =
		entry.details !== undefined ? `\n\n${fencedBlock("json", JSON.stringify(entry.details, null, 2))}` : "";
	return `## Branch summary\n\nFrom \`${entry.fromId}\`:\n\n${entry.summary}${details}`;
}

function formatThinkingLevelEntry(entry: ThinkingLevelChangeEntry): string {
	return `## Thinking level\n\nSet to **${entry.thinkingLevel}**.`;
}

function formatModelChangeEntry(entry: ModelChangeEntry): string {
	return `## Model change\n\n**${entry.provider}** / \`${entry.modelId}\``;
}

function formatCustomEntry(entry: CustomEntry): string {
	return `## Custom entry (${entry.customType})\n\n${fencedBlock("json", JSON.stringify(entry.data ?? null, null, 2))}`;
}

function formatCustomMessageEntry(entry: CustomMessageEntry): string {
	const content =
		typeof entry.content === "string"
			? entry.content
			: Array.isArray(entry.content)
				? entry.content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("")
				: "";
	const display = entry.display ? "visible" : "hidden";
	return `## Custom message (${entry.customType}) _${display}_\n\n${content}`;
}

function formatLabelEntry(entry: LabelEntry): string {
	return `## Label\n\nTarget \`${entry.targetId}\`: **${entry.label ?? "(cleared)"}**`;
}

function formatSessionInfoEntry(entry: SessionInfoEntry): string {
	return `## Session name\n\n${entry.name ?? "(unnamed)"}`;
}

function formatSessionEntry(entry: SessionEntry): string {
	switch (entry.type) {
		case "message":
			return formatSessionMessageEntry(entry);
		case "compaction":
			return formatCompactionEntry(entry);
		case "branch_summary":
			return formatBranchSummaryEntry(entry);
		case "thinking_level_change":
			return formatThinkingLevelEntry(entry);
		case "model_change":
			return formatModelChangeEntry(entry);
		case "custom":
			return formatCustomEntry(entry);
		case "custom_message":
			return formatCustomMessageEntry(entry);
		case "label":
			return formatLabelEntry(entry);
		case "session_info":
			return formatSessionInfoEntry(entry);
		default:
			return `## (${(entry as SessionEntry).type})\n\n${fencedBlock("json", JSON.stringify(entry, null, 2))}`;
	}
}

function collectLabelsFromTree(nodes: SessionTreeNode[], map: Map<string, string>): void {
	for (const n of nodes) {
		if (n.label && n.entry?.id) {
			map.set(n.entry.id, n.label);
		}
		collectLabelsFromTree(n.children, map);
	}
}

export interface ExportMarkdownOptions {
	outputPath?: string;
}

/**
 * Export the current conversation branch to a Markdown file.
 * Includes user/assistant text, thinking blocks, tool calls and results, compaction, model changes, etc.
 */
export function exportSessionToMarkdown(sm: SessionManager, options?: ExportMarkdownOptions | string): string {
	const opts: ExportMarkdownOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to Markdown");
	}
	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	const header = sm.getHeader();
	const branch = sm.getBranch();
	const labelByEntryId = new Map<string, string>();
	collectLabelsFromTree(sm.getTree(), labelByEntryId);

	const lines: string[] = [];
	lines.push(`# ${APP_NAME} session export`);
	lines.push("");
	if (header) {
		lines.push(`- **Session id:** ${header.id}`);
		lines.push(`- **Started:** ${header.timestamp}`);
		lines.push(`- **Working directory:** ${header.cwd}`);
		if (header.parentSession) lines.push(`- **Parent session:** ${header.parentSession}`);
		lines.push("");
	}
	lines.push(`_Exported ${new Date().toISOString()}. Conversation path from root to current leaf._`);
	lines.push("");

	for (const entry of branch) {
		const label = labelByEntryId.get(entry.id);
		if (label) {
			lines.push(`> Bookmark: **${label}**`);
			lines.push("");
		}
		lines.push(formatSessionEntry(entry));
		lines.push("");
		lines.push("---");
		lines.push("");
	}

	const text = `${lines.join("\n").trimEnd()}\n`;

	let outputPath = opts.outputPath;
	if (!outputPath) {
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${APP_NAME}-session-${sessionBasename}.md`;
	}
	outputPath = resolve(outputPath);
	const dir = dirname(outputPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(outputPath, text, "utf8");
	return outputPath;
}

/**
 * Export an on-disk session file to Markdown (no AgentState).
 */
export function exportMarkdownFromSessionFile(inputPath: string, options?: ExportMarkdownOptions | string): string {
	const opts: ExportMarkdownOptions = typeof options === "string" ? { outputPath: options } : options || {};

	if (!existsSync(inputPath)) {
		throw new Error(`File not found: ${inputPath}`);
	}

	const sm = SessionManager.open(inputPath);

	let outputPath = opts.outputPath;
	if (!outputPath) {
		const base = basename(inputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${base}.md`;
	}

	return exportSessionToMarkdown(sm, { ...opts, outputPath });
}
