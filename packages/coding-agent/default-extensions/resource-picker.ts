/**
 * Interactive resource picker for free-code.
 *
 * Registers `/pick-tools`, `/pick-skill`, and `/pick-agent` to choose optional MCP tool groups,
 * `<skill>` blocks, and discovered agents. Session-wide defaults come from `/profile` at startup
 * (bundled `profile-manager`); this extension keeps the host `ResourceDisplayFilter` in sync when
 * those pickers run.
 *
 * Usage:
 *   free-code -e extensions/resource-picker.ts
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ExtensionAPI, ExtensionContext, ResourceDisplayFilter, ToolInfo } from "@free/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@free/pi-tui";

/* Token estimates are inlined so this file can be copied alone to ~/.free-code/agent/extensions/ (no ./lib/). ~4 chars ≈ 1 token. */

interface ParsedSkillBlock {
	name: string;
	description: string;
	fullBlock: string;
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

function estimateToolGroupTokens(tools: ToolInfo[]): number {
	let sum = 0;
	for (const t of tools) {
		sum += estimateCharsAsTokens(serializeToolDefinition(t).length);
	}
	return sum;
}

function parseSkillBlocks(systemPrompt: string): ParsedSkillBlock[] {
	const results: ParsedSkillBlock[] = [];
	const blockRe = /<skill>([\s\S]*?)<\/skill>/g;
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(systemPrompt)) !== null) {
		const inner = m[1];
		const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/);
		const descMatch = inner.match(/<description>([\s\S]*?)<\/description>/);
		const name = nameMatch?.[1]?.trim() ?? "";
		if (!name) continue;
		const description = descMatch?.[1]?.trim() ?? "";
		results.push({ name, description, fullBlock: m[0] });
	}
	return results;
}

function estimateSkillBlockTokens(fullSkillXml: string): number {
	return estimateCharsAsTokens(fullSkillXml.length);
}

function formatTokenEstimate(tokens: number): string {
	if (tokens >= 10_000) return `~${(tokens / 1000).toFixed(1)}k`;
	if (tokens >= 1000) return `~${(tokens / 1000).toFixed(1)}k`;
	return `~${tokens}`;
}

interface AgentDef {
	name: string;
	description: string;
	body: string;
	path: string;
}

function parseAgentFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { fields: {}, body: raw };
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { fields, body: match[2] };
}

function discoverAgentsFromDir(dir: string, agents: AgentDef[]): void {
	if (!existsSync(dir)) return;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const mdPath = join(dir, entry.name);
			const raw = readFileSync(mdPath, "utf-8");
			const { fields, body } = parseAgentFrontmatter(raw);
			const baseName = entry.name.replace(/\.md$/, "");
			agents.push({
				name: fields.name || baseName,
				description: fields.description || "",
				body: body.trim(),
				path: mdPath,
			});
		}
	} catch {}
}

function discoverAgents(): AgentDef[] {
	const agents: AgentDef[] = [];
	// Project-local agents first
	const projectDir = join(process.cwd(), ".free-code", "agents");
	discoverAgentsFromDir(projectDir, agents);
	// Global agents
	const globalDir = join(homedir(), ".free-code", "agents");
	discoverAgentsFromDir(globalDir, agents);
	return agents;
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatAgentCatalog(agents: AgentDef[], disabled: Set<string>): string {
	const active = agents.filter((a) => !disabled.has(a.name));
	if (active.length === 0) return "";
	const lines = [
		"\n\nThe following agents provide specialized personas for specific tasks.",
		"Use the read tool to load an agent's file when the task matches its description.",
		"When adopting an agent persona, follow its instructions for the duration of that task.",
		"",
		"<available_agents>",
	];
	for (const a of active) {
		lines.push("  <agent>");
		lines.push(`    <name>${escapeXml(a.name)}</name>`);
		lines.push(`    <description>${escapeXml(a.description)}</description>`);
		lines.push(`    <location>${escapeXml(a.path)}</location>`);
		lines.push("  </agent>");
	}
	lines.push("</available_agents>");
	return lines.join("\n");
}

const BUILTIN_TOOLS = new Set([
	"read", "bash", "edit", "write", "grep", "find", "ls",
	"code_index", "code_symbols", "code_callers", "code_context",
]);
const MCP_SOURCE_PATH = "mcp-client.ts";

/**
 * Extensions whose tool groups should not appear in the picker UI.
 * Their tools remain always-active so they can't be accidentally disabled.
 */
const ALWAYS_ACTIVE_EXTENSION_ENTRY_NAMES = new Set(["index", "questionnaire", "subagent-widget"]);

function getExtensionEntryName(sourcePath: string | undefined): string | undefined {
	if (!sourcePath) return undefined;
	return sourcePath.split("/").pop()?.replace(/\.ts$/, "");
}

interface CheckboxItem {
	label: string;
	enabled: boolean;
	key: string;
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

function groupToolsBySource(tools: ToolInfo[]): Map<string, ToolInfo[]> {
	const grouped = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		if (BUILTIN_TOOLS.has(tool.name)) continue;
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

function createCheckboxComponent(
	title: string,
	items: CheckboxItem[],
	done: (items: CheckboxItem[]) => void,
	options?: { startOnDone?: boolean },
): Component & { dispose?(): void } {
	const totalRows = items.length + 1;
	// Default to "Done" so users can accept the current selection immediately.
	let cursor = options?.startOnDone === false ? 0 : items.length;
	let cachedLines: string[] | undefined;

	return {
		handleInput(data: string) {
			if (matchesKey(data, Key.up)) {
				cursor = (cursor - 1 + totalRows) % totalRows;
			} else if (matchesKey(data, Key.down)) {
				cursor = (cursor + 1) % totalRows;
			} else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
				if (cursor < items.length) {
					items[cursor].enabled = !items[cursor].enabled;
				} else {
					done(items);
					return;
				}
			} else if (matchesKey(data, Key.escape)) {
				done(items);
				return;
			} else if (data === "a" || data === "A") {
				const allOn = items.every((i) => i.enabled);
				for (const item of items) item.enabled = !allOn;
			}
			cachedLines = undefined;
		},

		render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			lines.push("");
			lines.push(truncateToWidth(` ${title}`, width));
			lines.push("");

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				const check = item.enabled ? "\x1b[32m[x]\x1b[0m" : "\x1b[31m[ ]\x1b[0m";
				const arrow = i === cursor ? "\x1b[1m>\x1b[0m" : " ";
				const label = i === cursor ? `\x1b[1m${item.label}\x1b[0m` : item.label;
				lines.push(truncateToWidth(` ${arrow} ${check} ${label}`, width));
			}

			const doneArrow = cursor === items.length ? "\x1b[1m>\x1b[0m" : " ";
			const doneLabel = cursor === items.length ? "\x1b[1m-- Done --\x1b[0m" : "-- Done --";
			lines.push(truncateToWidth(` ${doneArrow}     ${doneLabel}`, width));

			lines.push("");
			lines.push(
				truncateToWidth(
					" \x1b[2m\u2191\u2193 navigate  space/enter toggle  a toggle all  enter on Done \u2014 tok est. \u2248 chars\u00f74 on tool defs / skill XML\x1b[0m",
					width,
				),
			);
			lines.push("");

			cachedLines = lines;
			return lines;
		},

		invalidate() {
			cachedLines = undefined;
		},
	};
}

interface ToolGroupDisplayState {
	hiddenExtensionPaths: Set<string>;
	activeMcpServers: string[];
}

function computeToolGroupDisplayState(allTools: ToolInfo[], activeToolNames: string[]): ToolGroupDisplayState {
	const activeSet = new Set(activeToolNames);
	const extensionToolCounts = new Map<string, { total: number; active: number }>();
	const mcpServerActive = new Map<string, boolean>();

	for (const tool of allTools) {
		if (BUILTIN_TOOLS.has(tool.name)) continue;
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

/** Runtime `pi` may predate ResourceDisplayFilter (stale dist, or extension newer than CLI). */
type OptionalResourceFilterPi = {
	getResourceDisplayFilter?: () => ResourceDisplayFilter | undefined;
	setResourceDisplayFilter?: (filter: ResourceDisplayFilter) => void;
};

export default function (pi: ExtensionAPI) {
	const disabledSkillNames = new Set<string>();
	const disabledAgentNames = new Set<string>();
	let allDiscoveredAgents: AgentDef[] = [];

	/** Newer resource-picker sources may run against an older `pi` (stale dist, or `-e` vs global CLI). */
	function getHostResourceDisplayFilter(): ResourceDisplayFilter | undefined {
		const { getResourceDisplayFilter: getFn } = pi as unknown as OptionalResourceFilterPi;
		return typeof getFn === "function" ? getFn() : undefined;
	}

	function applyResourceDisplayFilter(filter: ResourceDisplayFilter): void {
		const { setResourceDisplayFilter: setFn } = pi as unknown as OptionalResourceFilterPi;
		if (typeof setFn === "function") setFn(filter);
	}

	function mergeHiddenSkillNames(): Set<string> {
		const merged = new Set(disabledSkillNames);
		const host = getHostResourceDisplayFilter()?.hiddenSkillNames;
		if (host) {
			for (const n of host) merged.add(n);
		}
		return merged;
	}

	/** Align local picker state with the host filter (e.g. after `/profile use`). */
	function syncLocalFromHost(): void {
		const host = getHostResourceDisplayFilter();
		if (host?.hiddenSkillNames) {
			disabledSkillNames.clear();
			for (const n of host.hiddenSkillNames) {
				disabledSkillNames.add(n);
			}
		} else if (host && host.hiddenSkillNames !== undefined && host.hiddenSkillNames.size === 0) {
			disabledSkillNames.clear();
		}
		if (host?.activeDiscoveredAgents !== undefined) {
			disabledAgentNames.clear();
			const active = new Set(host.activeDiscoveredAgents.map((a) => a.name));
			for (const a of allDiscoveredAgents) {
				if (!active.has(a.name)) disabledAgentNames.add(a.name);
			}
		}
	}

	function syncResourceDisplayFilter(): void {
		const toolState = computeToolGroupDisplayState(pi.getAllTools(), pi.getActiveTools());
		applyResourceDisplayFilter({
			hiddenSkillNames: new Set(disabledSkillNames),
			hiddenExtensionPaths: toolState.hiddenExtensionPaths,
			activeMcpServers: toolState.activeMcpServers,
			activeDiscoveredAgents: allDiscoveredAgents
				.filter((a) => !disabledAgentNames.has(a.name))
				.map((a) => ({ name: a.name, path: a.path })),
		});
	}

	async function pickToolGroups(ui: ExtensionContext["ui"], options?: { startEmpty?: boolean }): Promise<void> {
		const tools = pi.getAllTools();
		const grouped = groupToolsBySource(tools);
		if (grouped.size === 0) return;

		const activeTools = pi.getActiveTools();
		const items: CheckboxItem[] = [...grouped.entries()].map(([group, groupTools]) => {
			const tok = estimateToolGroupTokens(groupTools);
			const est = formatTokenEstimate(tok);
			return {
				label: `${group} (${groupTools.length} tools, ${est} tok est.)`,
				enabled: options?.startEmpty ? false : groupTools.some((t) => activeTools.includes(t.name)),
				key: group,
			};
		});

		const result = await ui.custom<CheckboxItem[]>(
			(_tui, _theme, _kb, done) =>
				createCheckboxComponent("Select tool groups", items, done, { startOnDone: options?.startEmpty }),
		);

		if (!Array.isArray(result)) return;
		const enabledGroups = new Set(result.filter((i) => i.enabled).map((i) => i.key));
		const builtinActive = activeTools.filter((n) => BUILTIN_TOOLS.has(n));
		const alwaysActive = tools
			.filter((t) => {
				if (BUILTIN_TOOLS.has(t.name)) return false;
				const sourcePath = t.sourceInfo?.path;
				if (!sourcePath) return false;
				if (sourcePath.endsWith(MCP_SOURCE_PATH)) return false;
				const extName = getExtensionEntryName(sourcePath);
				return extName !== undefined && ALWAYS_ACTIVE_EXTENSION_ENTRY_NAMES.has(extName);
			})
			.map((t) => t.name);

		const newActive = new Set<string>([...builtinActive, ...alwaysActive]);

		for (const [group, groupTools] of grouped) {
			if (enabledGroups.has(group)) {
				for (const t of groupTools) newActive.add(t.name);
			}
		}
		pi.setActiveTools([...newActive]);
		syncResourceDisplayFilter();
	}

	function stripSkillsFromPrompt(systemPrompt: string): string {
		const merged = mergeHiddenSkillNames();
		if (merged.size === 0) return systemPrompt;
		let result = systemPrompt;
		for (const name of merged) {
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(`\\s*<skill>\\s*<name>${escaped}</name>[\\s\\S]*?</skill>`, "g");
			result = result.replace(pattern, "");
		}
		return result;
	}

	async function pickSkills(
		ui: ExtensionContext["ui"],
		systemPrompt: string,
		options?: { startEmpty?: boolean },
	): Promise<void> {
		const skills = parseSkillBlocks(systemPrompt);
		if (skills.length === 0) return;

		const hiddenEffective = mergeHiddenSkillNames();
		const items: CheckboxItem[] = skills.map((s) => {
			const tok = estimateSkillBlockTokens(s.fullBlock);
			const est = formatTokenEstimate(tok);
			const desc = s.description.trim();
			const label = desc
				? `${s.name} (${est} tok est.) \u2014 ${desc}`
				: `${s.name} (${est} tok est.)`;
			return {
				label,
				enabled: options?.startEmpty ? false : !hiddenEffective.has(s.name),
				key: s.name,
			};
		});

		const result = await ui.custom<CheckboxItem[]>(
			(_tui, _theme, _kb, done) =>
				createCheckboxComponent("Select skills", items, done, { startOnDone: options?.startEmpty }),
		);

		if (!Array.isArray(result)) return;
		disabledSkillNames.clear();
		for (const item of result) {
			if (!item.enabled) disabledSkillNames.add(item.key);
		}
		syncResourceDisplayFilter();
	}

	async function pickAgents(
		ui: ExtensionContext["ui"],
		agents: AgentDef[],
		options?: { startEmpty?: boolean },
	): Promise<void> {
		const items: CheckboxItem[] = agents.map((a) => {
			const catalogTok = estimateCharsAsTokens(a.name.length + a.description.length + a.path.length + 80);
			const est = formatTokenEstimate(catalogTok);
			const desc =
				a.description.length > 80 ? `${a.description.slice(0, 77)}...` : a.description;
			const label = desc
				? `${a.name} (${est} tok est.) \u2014 ${desc}`
				: `${a.name} (${est} tok est.)`;
			return {
				label,
				enabled: options?.startEmpty ? false : !disabledAgentNames.has(a.name),
				key: a.name,
			};
		});

		const result = await ui.custom<CheckboxItem[]>(
			(_tui, _theme, _kb, done) =>
				createCheckboxComponent("Select agents", items, done, { startOnDone: options?.startEmpty }),
		);

		if (!Array.isArray(result)) return;
		disabledAgentNames.clear();
		for (const item of result) {
			if (!item.enabled) disabledAgentNames.add(item.key);
		}
		syncResourceDisplayFilter();
	}

	pi.registerCommand("pick-tools", {
		description: "Enable/disable MCP tool groups to save tokens",
		handler: async (_args, ctx) => {
			await pickToolGroups(ctx.ui);
		},
	});

	pi.registerCommand("pick-agent", {
		description: "Enable/disable agent personas in the catalog",
		handler: async (_args, ctx) => {
			const agents = discoverAgents();
			if (agents.length === 0) {
				ctx.ui.notify("No agents found in .free-code/agents/ or ~/.free-code/agents/", "warning");
				return;
			}
			allDiscoveredAgents = agents;
			await pickAgents(ctx.ui, agents);
			const activeCount = agents.filter((a) => !disabledAgentNames.has(a.name)).length;
			ctx.ui.notify(`${activeCount}/${agents.length} agents active in catalog`, "info");
		},
	});

	pi.registerCommand("pick-skill", {
		description: "Enable/disable skills in the system prompt to save tokens",
		handler: async (_args, ctx) => {
			const systemPrompt = ctx.getSystemPrompt();
			const skills = parseSkillBlocks(systemPrompt);
			if (skills.length === 0) {
				ctx.ui.notify("No skills found in the current system prompt", "warning");
				return;
			}
			await pickSkills(ctx.ui, systemPrompt);
			const merged = mergeHiddenSkillNames();
			const activeCount = skills.filter((s) => !merged.has(s.name)).length;
			ctx.ui.notify(`${activeCount}/${skills.length} skills active`, "info");
		},
	});

	pi.on("session_resources_ready", async (_event, _ctx) => {
		allDiscoveredAgents = discoverAgents();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		allDiscoveredAgents = discoverAgents();
		syncLocalFromHost();
		let prompt = stripSkillsFromPrompt(event.systemPrompt);
		const catalog = formatAgentCatalog(allDiscoveredAgents, disabledAgentNames);
		if (catalog) prompt = prompt + catalog;
		return { systemPrompt: prompt };
	});
}
