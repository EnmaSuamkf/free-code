import type { ToolInfo } from "./extensions/types.js";

/**
 * Tool names that belong to the built-in / core tool set (not MCP/extension groups).
 * Matches default-extensions/resource-picker.ts BUILTIN_TOOLS.
 */
export const BUILTIN_TOOL_NAMES = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"code_index",
	"code_symbols",
	"code_callers",
	"code_context",
]);

const MCP_SOURCE_PATH = "mcp-client.ts";

const ALWAYS_ACTIVE_EXTENSION_ENTRY_NAMES = new Set(["index", "questionnaire", "subagent-widget", "profile-manager"]);

function getExtensionEntryName(sourcePath: string | undefined): string | undefined {
	if (!sourcePath) return undefined;
	return sourcePath.split("/").pop()?.replace(/\.ts$/, "");
}

function getMcpServerName(tool: ToolInfo): string | undefined {
	const desc = tool.description ?? "";
	const bracketMatch = desc.match(/^\[([^\]]+)\]/);
	if (bracketMatch) return bracketMatch[1];
	const fromMatch = desc.match(/MCP tool from (\S+)/);
	if (fromMatch) return fromMatch[1];
	if (tool.name.includes(":")) return tool.name.split(":")[0];
	return undefined;
}

/**
 * Group optional (non-builtin) tools by MCP server or extension entry, for pick-tools UI.
 */
export function groupOptionalToolsBySource(tools: ToolInfo[]): Map<string, ToolInfo[]> {
	const grouped = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		if (BUILTIN_TOOL_NAMES.has(tool.name)) continue;
		const sourcePath = tool.sourceInfo?.path;
		const isMcp = sourcePath?.endsWith(MCP_SOURCE_PATH);
		let groupKey: string;
		if (isMcp) {
			const server = getMcpServerName(tool);
			groupKey = server ? `MCP: ${server}` : "MCP: unknown";
		} else {
			const name = getExtensionEntryName(sourcePath) ?? sourcePath ?? "unknown";
			if (ALWAYS_ACTIVE_EXTENSION_ENTRY_NAMES.has(name)) continue;
			groupKey = `Extension: ${name}`;
		}
		if (!grouped.has(groupKey)) grouped.set(groupKey, []);
		grouped.get(groupKey)!.push(tool);
	}
	return grouped;
}

function estimateCharsAsTokens(charCount: number): number {
	return Math.max(0, Math.ceil(charCount / 4));
}

function serializeToolDefinition(tool: ToolInfo): string {
	let params = "";
	if (tool.parameters !== undefined) {
		try {
			params = JSON.stringify(tool.parameters);
		} catch {
			params = String(tool.parameters);
		}
	}
	return `${tool.name}\n${tool.description ?? ""}\n${params}`;
}

function estimateToolGroupTokens(groupTools: ToolInfo[]): number {
	let sum = 0;
	for (const t of groupTools) {
		sum += estimateCharsAsTokens(serializeToolDefinition(t).length);
	}
	return sum;
}

/**
 * Optional extension entry tools that must always stay in the active set (e.g. index / package roots).
 */
export function getAlwaysOnToolNames(tools: ToolInfo[]): string[] {
	return tools
		.filter((t) => {
			if (BUILTIN_TOOL_NAMES.has(t.name)) return false;
			const sourcePath = t.sourceInfo?.path;
			if (!sourcePath || sourcePath.endsWith(MCP_SOURCE_PATH)) return false;
			const extName = getExtensionEntryName(sourcePath);
			return extName !== undefined && ALWAYS_ACTIVE_EXTENSION_ENTRY_NAMES.has(extName);
		})
		.map((t) => t.name);
}

export interface ToolPickerGroupSnapshot {
	key: string;
	toolNames: string[];
	toolCount: number;
	tokensEstimated: number;
	enabled: boolean;
}

/**
 * Build pick-tools snapshot for RPC / TUI: optional groups, always-on, and active builtins.
 */
export function getToolPickerState(
	tools: ToolInfo[],
	activeToolNames: string[],
): {
	groups: ToolPickerGroupSnapshot[];
	alwaysOnToolNames: string[];
	builtinActive: string[];
} {
	const active = new Set(activeToolNames);
	const grouped = groupOptionalToolsBySource(tools);
	const groups: ToolPickerGroupSnapshot[] = [];
	for (const [key, groupTools] of grouped) {
		groups.push({
			key,
			toolNames: groupTools.map((t) => t.name),
			toolCount: groupTools.length,
			tokensEstimated: estimateToolGroupTokens(groupTools),
			enabled: groupTools.some((t) => active.has(t.name)),
		});
	}
	const alwaysOnToolNames = getAlwaysOnToolNames(tools);
	const builtinActive = activeToolNames.filter((n) => BUILTIN_TOOL_NAMES.has(n));
	return { groups, alwaysOnToolNames, builtinActive };
}

/**
 * Apply enabled optional groups; keeps builtins and always-on tools active (resource-picker behavior).
 */
export function applyToolPickerSelection(
	tools: ToolInfo[],
	currentActive: string[],
	enabledGroupKeys: Set<string>,
): string[] {
	const grouped = groupOptionalToolsBySource(tools);
	const builtinActive = currentActive.filter((n) => BUILTIN_TOOL_NAMES.has(n));
	const alwaysOn = getAlwaysOnToolNames(tools);
	const newActive = new Set<string>([...builtinActive, ...alwaysOn]);
	for (const [group, groupTools] of grouped) {
		if (enabledGroupKeys.has(group)) {
			for (const t of groupTools) newActive.add(t.name);
		}
	}
	return [...newActive];
}

/**
 * `~1.2k` style estimate for a tool group.
 */
export function formatTokenEstimate(tokens: number): string {
	if (tokens >= 10_000) return `~${(tokens / 1000).toFixed(1)}k`;
	if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k`;
	return `~${tokens}`;
}

/**
 * Derive MCP + extension visibility from the active tool name list (same rules as
 * `default-extensions/resource-picker.ts` `computeToolGroupDisplayState`).
 */
export function computeToolGroupFilterState(
	tools: ToolInfo[],
	activeToolNames: string[],
): { hiddenExtensionPaths: Set<string>; activeMcpServers: string[] } {
	const activeSet = new Set(activeToolNames);
	const extensionToolCounts = new Map<string, { total: number; active: number }>();
	const mcpServerActive = new Map<string, boolean>();

	for (const tool of tools) {
		if (BUILTIN_TOOL_NAMES.has(tool.name)) continue;
		const sourcePath = tool.sourceInfo?.path;
		const isMcp = sourcePath?.endsWith(MCP_SOURCE_PATH);

		if (isMcp) {
			const server = getMcpServerName(tool);
			if (server && !mcpServerActive.has(server)) {
				mcpServerActive.set(server, false);
			}
			if (server && activeSet.has(tool.name)) {
				mcpServerActive.set(server, true);
			}
		} else if (sourcePath) {
			const counts = extensionToolCounts.get(sourcePath) ?? { total: 0, active: 0 };
			counts.total++;
			if (activeSet.has(tool.name)) counts.active++;
			extensionToolCounts.set(sourcePath, counts);
		}
	}

	const hiddenExtensionPaths = new Set<string>();
	for (const [path, counts] of extensionToolCounts) {
		if (counts.active === 0) hiddenExtensionPaths.add(path);
	}

	const activeMcpServers: string[] = [];
	for (const [server, active] of mcpServerActive) {
		if (active) activeMcpServers.push(server);
	}

	return { hiddenExtensionPaths, activeMcpServers };
}
