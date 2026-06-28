#!/usr/bin/env node
/**
 * Reset the MCP tools cache used by default-extensions/mcp-client.ts.
 *
 * The cache lives at ~/.free-code/agent/mcp-tools-cache.json and lets free-code
 * register MCP tools from disk at startup instead of waiting for every server
 * to connect and respond to listTools. Deleting it forces a full reconnect +
 * listTools on the next run, which is useful after upgrading a server, editing
 * mcp.json, or when something looks stale.
 */
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cachePath = join(homedir(), ".free-code", "agent", "mcp-tools-cache.json");

if (!existsSync(cachePath)) {
	console.log(`MCP cache already clean: ${cachePath} (nothing to do)`);
	process.exit(0);
}

try {
	rmSync(cachePath, { force: true });
	console.log(`Removed MCP cache: ${cachePath}`);
	console.log("Next `free-code` run will reconnect all MCP servers and rebuild the cache.");
} catch (err) {
	console.error(`Failed to remove ${cachePath}: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
