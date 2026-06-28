/**
 * MCP Import Extension
 *
 * Imports MCP server configuration from Claude, Cursor, VS Code, or IntelliJ
 * into ~/.free-code/agent/mcp.json, and extracts any env vars declared in the
 * imported servers into ~/.free-code/agent/.env.
 *
 * Usage: /mcp-import
 */

import type { ExtensionAPI } from "@free/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(p: string): string {
	return p.replace(/^~/, homedir());
}

interface IdeConfig {
	label: string;
	paths: string[];
	key: string;
}

const IDE_CONFIGS: IdeConfig[] = [
	{
		label: "Claude (Claude Code / Desktop)",
		paths: ["~/.claude/mcp.json", "~/.claude/settings.json"],
		key: "mcpServers",
	},
	{
		label: "Cursor",
		paths: ["~/.cursor/mcp.json"],
		key: "mcpServers",
	},
	{
		label: "VS Code",
		paths: [
			"~/Library/Application Support/Code/User/mcp.json",
			"~/Library/Application Support/Code/User/settings.json",
		],
		key: "mcpServers",
	},
	{
		label: "IntelliJ",
		paths: ["~/.config/github-copilot/intellij/mcp.json"],
		key: "mcpServers",
	},
];

const FREE_CODE_AGENT_DIR = expandHome("~/.free-code/agent");
const FREE_CODE_MCP_PATH = join(FREE_CODE_AGENT_DIR, "mcp.json");
const FREE_CODE_ENV_PATH = join(FREE_CODE_AGENT_DIR, ".env");

type McpServers = Record<string, unknown>;

function readMcpServers(paths: string[], key: string): McpServers | null {
	for (const p of paths) {
		const resolved = expandHome(p);
		if (!existsSync(resolved)) continue;
		try {
			const raw = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
			// VS Code stores MCPs nested: { "mcp": { "servers": {...} } }
			const nested = (raw as Record<string, Record<string, unknown>>)?.mcp?.servers;
			if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
				return nested as McpServers;
			}
			const servers = raw[key];
			if (servers && typeof servers === "object" && Object.keys(servers as object).length > 0) {
				return servers as McpServers;
			}
		} catch {
			// try next path
		}
	}
	return null;
}

function readFreeCodeMcpServers(): McpServers {
	if (!existsSync(FREE_CODE_MCP_PATH)) return {};
	try {
		const raw = JSON.parse(readFileSync(FREE_CODE_MCP_PATH, "utf8")) as Record<string, unknown>;
		return (raw.mcpServers as McpServers) ?? {};
	} catch {
		return {};
	}
}

function writeFreeCodeMcpServers(servers: McpServers): void {
	mkdirSync(FREE_CODE_AGENT_DIR, { recursive: true });
	writeFileSync(FREE_CODE_MCP_PATH, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf8");
}

function readFreeCodeEnv(): Record<string, string> {
	if (!existsSync(FREE_CODE_ENV_PATH)) return {};
	const result: Record<string, string> = {};
	for (const line of readFileSync(FREE_CODE_ENV_PATH, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return result;
}

function writeFreeCodeEnv(env: Record<string, string>): void {
	mkdirSync(FREE_CODE_AGENT_DIR, { recursive: true });
	const content = Object.entries(env)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
	writeFileSync(FREE_CODE_ENV_PATH, content + "\n", "utf8");
}

function extractEnvVars(servers: McpServers): Record<string, string> {
	const env: Record<string, string> = {};
	for (const server of Object.values(servers)) {
		const s = server as Record<string, unknown>;
		if (s?.env && typeof s.env === "object") {
			for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
				if (typeof v === "string") env[k] = v;
			}
		}
	}
	return env;
}

export default function mcpImportExtension(pi: ExtensionAPI) {
	pi.registerCommand("mcp-import", {
		description: "Import MCP server configuration from Claude, Cursor, VS Code, or IntelliJ",
		handler: async (_, ctx) => {
			// 1. Ask which IDE to import from
			const chosen = await ctx.ui.select(
				"Import MCP servers from:",
				IDE_CONFIGS.map((c) => c.label),
			);
			if (!chosen) return;

			const ide = IDE_CONFIGS.find((c) => c.label === chosen)!;

			// 2. Read source servers
			const importedServers = readMcpServers(ide.paths, ide.key);
			if (!importedServers || Object.keys(importedServers).length === 0) {
				ctx.ui.notify(
					`No MCP servers found for ${chosen}.\nChecked:\n  ${ide.paths.join("\n  ")}`,
					"warning",
				);
				return;
			}

			const names = Object.keys(importedServers);
				const existing = readFreeCodeMcpServers();
			const overwriting = names.filter((n) => n in existing);

			// 3. Confirm
			const overwriteNote =
				overwriting.length > 0 ? `\n\nWill overwrite existing:\n  ${overwriting.join("\n  ")}` : "";

			const confirmed = await ctx.ui.confirm(
				`Import from ${chosen}`,
				`${names.length} server(s) found:\n  ${names.join("\n  ")}${overwriteNote}\n\nMerge into ~/.free-code/agent/mcp.json?`,
			);
			if (!confirmed) return;

			// 4. Merge mcp.json
				writeFreeCodeMcpServers({ ...existing, ...importedServers });

			// 5. Extract and merge env vars
			const importedEnv = extractEnvVars(importedServers);
			let envNote = "";
			if (Object.keys(importedEnv).length > 0) {
					writeFreeCodeEnv({ ...readFreeCodeEnv(), ...importedEnv });
				envNote = ` + ${Object.keys(importedEnv).length} env var(s) → .env`;
			}

			ctx.ui.notify(
				`Imported ${names.length} MCP server(s)${envNote}. Run /reload to activate.`,
				"info",
			);
		},
	});
}
