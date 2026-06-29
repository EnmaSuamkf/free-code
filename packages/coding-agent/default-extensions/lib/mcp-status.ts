/**
 * Shared MCP enable/disable state for the default extensions.
 *
 * Activation state lives in `~/.free-code/agent/mcp-status.json`, kept separate from
 * `mcp.json` so the user can edit server definitions by hand without touching which
 * ones start. Shape: `{ "servers": { "<name>": "enabled" | "disabled" } }`.
 *
 * Reconciliation: any server present in `mcp.json` but missing from the status file is
 * added as `"disabled"` so nothing auto-starts until the user opts in via
 * `/mcp enable <name>`. Servers removed from `mcp.json` are pruned from the status.
 *
 * Used by both `mcp-client.ts` (filters which servers connect on session start) and
 * `mcp-command.ts` (the `/mcp` command that toggles state).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_DIR = ".free-code";
const MCP_CONFIG_FILE = "mcp.json";
const MCP_STATUS_FILE = "mcp-status.json";

export type McpServerStatus = "enabled" | "disabled";

export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	type?: string;
}

export interface McpConfig {
	mcpServers: Record<string, McpServerConfig>;
}

interface McpStatusFile {
	servers: Record<string, McpServerStatus>;
}

function globalConfigPath(): string {
	return join(homedir(), CONFIG_DIR, "agent", MCP_CONFIG_FILE);
}

function localConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR, MCP_CONFIG_FILE);
}

function statusPath(): string {
	return join(homedir(), CONFIG_DIR, "agent", MCP_STATUS_FILE);
}

function readConfigFile(path: string): Record<string, McpServerConfig> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as McpConfig;
		return raw.mcpServers ?? {};
	} catch {
		// Ignore malformed config
		return {};
	}
}

/** Load merged MCP server definitions (global config overlaid by project-local config). */
export function loadMcpConfig(cwd: string): McpConfig {
	return {
		mcpServers: {
			...readConfigFile(globalConfigPath()),
			...readConfigFile(localConfigPath(cwd)),
		},
	};
}

function loadStatusFile(): McpStatusFile {
	const path = statusPath();
	if (!existsSync(path)) return { servers: {} };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as McpStatusFile;
		const servers = raw?.servers;
		if (!servers || typeof servers !== "object") return { servers: {} };
		const cleaned: Record<string, McpServerStatus> = {};
		for (const [name, value] of Object.entries(servers)) {
			if (value === "enabled" || value === "disabled") cleaned[name] = value;
		}
		return { servers: cleaned };
	} catch {
		return { servers: {} };
	}
}

function saveStatusFile(file: McpStatusFile): void {
	const path = statusPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
	} catch {
		// Best effort; reconciliation re-runs on the next session.
	}
}

/**
 * Reconcile the status file against the given configured server names: add missing
 * servers as `"disabled"`, prune servers that are no longer configured. Persists only
 * when something changed. Returns the reconciled status map.
 */
export function reconcileMcpStatus(serverNames: string[]): Record<string, McpServerStatus> {
	const current = loadStatusFile().servers;
	const next: Record<string, McpServerStatus> = {};
	let changed = false;

	for (const name of serverNames) {
		if (current[name] === "enabled" || current[name] === "disabled") {
			next[name] = current[name];
		} else {
			next[name] = "disabled";
			changed = true;
		}
	}

	if (!changed) {
		// Detect pruned entries (present in status, no longer configured).
		for (const name of Object.keys(current)) {
			if (!(name in next)) {
				changed = true;
				break;
			}
		}
	}

	if (changed) saveStatusFile({ servers: next });
	return next;
}

/** Load merged config and reconcile its status in one step. */
export function getReconciledMcpStatus(cwd: string): {
	names: string[];
	status: Record<string, McpServerStatus>;
} {
	const names = Object.keys(loadMcpConfig(cwd).mcpServers);
	return { names, status: reconcileMcpStatus(names) };
}

/** Set a single server's status, preserving the other entries. */
export function setMcpServerStatus(name: string, status: McpServerStatus): void {
	const file = loadStatusFile();
	file.servers[name] = status;
	saveStatusFile(file);
}
