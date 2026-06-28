import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { CONFIG_DIR_NAME } from "../config.js";
import type { ResourceDisplayFilter } from "./extensions/types.js";

function estimateCharsAsTokens(charCount: number): number {
	return Math.max(0, Math.ceil(charCount / 4));
}

function parseAgentFrontmatter(raw: string): { fields: Record<string, string> } {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!match) return { fields: {} };
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { fields };
}

interface AgentDef {
	name: string;
	description: string;
	path: string;
}

function discoverAgentsFromDir(dir: string, agents: AgentDef[]): void {
	if (!existsSync(dir)) return;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const mdPath = join(dir, entry.name);
			const raw = readFileSync(mdPath, "utf-8");
			const { fields } = parseAgentFrontmatter(raw);
			const baseName = entry.name.replace(/\.md$/, "");
			agents.push({
				name: fields.name || baseName,
				description: fields.description || "",
				path: mdPath,
			});
		}
	} catch {}
}

/** Discover agents from .free-code/agents/ (project-local then global), matching /pick-agent CLI behavior. */
function discoverAgents(): AgentDef[] {
	const agents: AgentDef[] = [];
	discoverAgentsFromDir(join(process.cwd(), CONFIG_DIR_NAME, "agents"), agents);
	discoverAgentsFromDir(join(homedir(), CONFIG_DIR_NAME, "agents"), agents);
	return agents;
}

export interface AgentPickerSnapshotRow {
	name: string;
	description: string;
	tokensEstimated: number;
	enabled: boolean;
}

/**
 * Build agent picker rows from .free-code/agents/ flat .md files, matching /pick-agent CLI behavior.
 */
export function getAgentPickerSnapshot(
	_agentsFiles: Array<{ path: string; content: string }>,
	filter: ResourceDisplayFilter | undefined,
): AgentPickerSnapshotRow[] {
	const agents = discoverAgents();
	if (agents.length === 0) return [];

	const activeNames = filter?.activeDiscoveredAgents
		? new Set(filter.activeDiscoveredAgents.map((a) => a.name))
		: null;

	return agents.map((a) => {
		const tokensEstimated = estimateCharsAsTokens(a.name.length + a.description.length + a.path.length + 80);
		const enabled = activeNames === null ? true : activeNames.has(a.name);
		return { name: a.name, description: a.description, tokensEstimated, enabled };
	});
}
