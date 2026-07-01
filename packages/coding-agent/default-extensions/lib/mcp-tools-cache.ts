/**
 * On-disk cache of each MCP server's tool list, keyed by a hash of its config.
 *
 * Written by `mcp-client.ts` after a live `listTools()` call, so the next session can
 * register tools synchronously without waiting on every server to reconnect. Read by
 * `mcp-command.ts` so `/mcp list` can show which tools each server exposes without
 * needing a live connection.
 */
import type { Client } from "@modelcontextprotocol/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./mcp-status.ts";

export type ToolList = Awaited<ReturnType<Client["listTools"]>>["tools"];

export interface CachedEntry {
	hash: string;
	tools: ToolList;
}

export interface ToolsCacheFile {
	version: number;
	entries: Record<string, CachedEntry>;
}

const TOOLS_CACHE_FILE = "mcp-tools-cache.json";
export const TOOLS_CACHE_VERSION = 1;

export function getToolsCachePath(): string {
	return join(homedir(), CONFIG_DIR, "agent", TOOLS_CACHE_FILE);
}

export function loadToolsCache(): ToolsCacheFile {
	const cachePath = getToolsCachePath();
	if (!existsSync(cachePath)) return { version: TOOLS_CACHE_VERSION, entries: {} };
	try {
		const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as ToolsCacheFile;
		if (raw.version !== TOOLS_CACHE_VERSION || !raw.entries) {
			return { version: TOOLS_CACHE_VERSION, entries: {} };
		}
		return raw;
	} catch {
		return { version: TOOLS_CACHE_VERSION, entries: {} };
	}
}

export function saveToolsCache(cache: ToolsCacheFile): void {
	const cachePath = getToolsCachePath();
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, JSON.stringify(cache, null, 2));
	} catch {
		// best effort; cache is an optimization only
	}
}

const DESCRIPTION_MAX_LEN = 100;

/** Collapse a (possibly multi-line) tool description to a single trimmed, truncated line. */
export function summarizeToolDescription(description: string | undefined): string {
	if (!description) return "";
	const firstLine = description
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return "";
	if (firstLine.length <= DESCRIPTION_MAX_LEN) return firstLine;
	return `${firstLine.slice(0, DESCRIPTION_MAX_LEN - 1).trimEnd()}…`;
}
