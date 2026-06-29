import { Type } from "@free/pi-ai";
import { type AgentToolResult, type ExtensionAPI } from "@free/pi-coding-agent";
import { Client, StdioClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { CONFIG_DIR, loadMcpConfig, type McpServerConfig, reconcileMcpStatus } from "./lib/mcp-status.ts";

const execFileAsync = promisify(execFile);
const MCP_LABEL_KEY = "free-code-pid";

// PIDs of child processes spawned by this session — used for synchronous exit cleanup.
const trackedPids = new Set<number>();

let cleanupHandlersRegistered = false;

function registerCleanupHandlers(getServers: () => ConnectedServer[]): void {
	if (cleanupHandlersRegistered) return;
	cleanupHandlersRegistered = true;

	// Synchronous exit handler: kill child processes before the event loop dies.
	process.on("exit", () => {
		for (const pid of trackedPids) {
			try { process.kill(pid, "SIGKILL"); } catch {}
		}
	});

	// Graceful signal handlers: close MCP clients cleanly, then exit.
	const handleSignal = () => {
		const servers = getServers();
		const close = Promise.allSettled(servers.map((s) => s.client.close()));
		close.finally(() => process.exit(0));
		// Force exit if cleanup hangs beyond 5 s.
		setTimeout(() => process.exit(1), 5000).unref();
	};

	process.once("SIGINT", handleSignal);
	process.once("SIGTERM", handleSignal);
	process.once("SIGHUP", handleSignal);
}

async function killOrphanedContainers(notify: (msg: string, level: "info" | "warning") => void): Promise<void> {
	try {
		const { stdout: idsRaw } = await execFileAsync("docker", [
			"ps", "-q", "--filter", `label=${MCP_LABEL_KEY}`,
		]);
		const ids = idsRaw.trim().split("\n").filter(Boolean);
		if (ids.length === 0) return;

		const { stdout: inspectRaw } = await execFileAsync("docker", [
			"inspect", "--format", `{{.Id}} {{index .Config.Labels "${MCP_LABEL_KEY}"}}`,
			...ids,
		]);

		const orphanIds: string[] = [];
		for (const line of inspectRaw.trim().split("\n")) {
			const spaceIdx = line.indexOf(" ");
			if (spaceIdx === -1) continue;
			const id = line.slice(0, spaceIdx);
			const pidStr = line.slice(spaceIdx + 1).trim();
			const pid = parseInt(pidStr, 10);
			if (isNaN(pid) || pid === process.pid) continue;
			try {
				process.kill(pid, 0); // throws if PID is dead
			} catch {
				orphanIds.push(id.slice(0, 12));
			}
		}

		if (orphanIds.length === 0) return;
		await execFileAsync("docker", ["kill", ...orphanIds]);
		notify(`MCP: cleaned up ${orphanIds.length} orphaned container(s) from a previous session`, "info");
	} catch {
		// Best effort — docker may not be available or containers already gone.
	}
}

interface ConnectedServer {
	name: string;
	client: Client;
	transport: StdioClientTransport | StreamableHTTPClientTransport;
}

type ToolList = Awaited<ReturnType<Client["listTools"]>>["tools"];

interface CachedEntry {
	hash: string;
	tools: ToolList;
}

interface ToolsCacheFile {
	version: number;
	entries: Record<string, CachedEntry>;
}

const TOOLS_CACHE_FILE = "mcp-tools-cache.json";
const TOOLS_CACHE_VERSION = 1;

function getToolsCachePath(): string {
	return join(homedir(), CONFIG_DIR, "agent", TOOLS_CACHE_FILE);
}

/** Directory used as cwd for stdio MCP subprocesses so `./.env` resolves next to global `mcp.json`. */
function getMcpStdioCwd(): string {
	return join(homedir(), CONFIG_DIR, "agent");
}

/**
 * Expands `~/`, `~`, `$HOME/...`, `${HOME}/...` so MCP args work without an absolute path and without a shell.
 */
function expandMcpPathLikeString(value: string): string {
	const home = homedir();
	let s = value.replaceAll("${HOME}", home);
	if (s.startsWith("~/")) {
		return join(home, s.slice(2));
	}
	if (s === "~") {
		return home;
	}
	if (s.startsWith("$HOME")) {
		const rest = s.slice("$HOME".length).replace(/^[\\/]+/, "");
		return rest.length > 0 ? join(home, rest) : home;
	}
	if (process.platform === "win32" && s.startsWith("%USERPROFILE%")) {
		const rest = s.slice("%USERPROFILE%".length).replace(/^[\\/]+/, "");
		return rest.length > 0 ? join(home, rest) : home;
	}
	return s;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function hashServerConfig(config: McpServerConfig): string {
	const normalized = {
		command: config.command,
		args: config.args,
		env: config.env,
		url: config.url,
		type: config.type,
	};
	return createHash("sha1").update(stableStringify(normalized)).digest("hex");
}

function loadToolsCache(): ToolsCacheFile {
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

function saveToolsCache(cache: ToolsCacheFile): void {
	const cachePath = getToolsCachePath();
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, JSON.stringify(cache, null, 2));
	} catch {
		// best effort; cache is an optimization only
	}
}

type NotifyFn = (msg: string, level: "info" | "warning") => void;

/** Parse a simple KEY=VALUE `.env` file (skips blanks/comments, strips surrounding quotes). */
function parseEnvFile(path: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!existsSync(path)) return result;
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return result;
	}
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (!key) continue;
		let value = line.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

/**
 * Load MCP env vars from the global (`~/.free-code/agent/.env`) and project-local
 * (`<cwd>/.free-code/.env`) env files, with local overriding global. These are injected
 * into stdio MCP subprocesses so Docker/`-e VAR` servers get their credentials without
 * listing each var in mcp.json.
 */
function loadMcpDotEnv(cwd: string): Record<string, string> {
	const globalEnv = parseEnvFile(join(homedir(), CONFIG_DIR, "agent", ".env"));
	const localEnv = parseEnvFile(join(cwd, CONFIG_DIR, ".env"));
	return { ...globalEnv, ...localEnv };
}

/**
 * Forward an MCP subprocess's stderr to the UI. OAuth-based servers (e.g. `mcp-remote`)
 * print their login URL here while `connect()` waits; without this it stays invisible.
 * Only authentication-looking URL lines are surfaced, so normal log chatter isn't noisy.
 */
function attachStderrListener(name: string, transport: StdioClientTransport, notify: NotifyFn): void {
	const stream = transport.stderr;
	if (!stream) return;
	const seenUrls = new Set<string>();
	let buffer = "";
	stream.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const text = line.trim();
			if (!text) continue;
			const urlMatch = text.match(/https?:\/\/\S+/);
			if (urlMatch && /auth|authoriz|login|sign|visit|oauth|verif|token|code/i.test(text)) {
				const url = urlMatch[0];
				if (seenUrls.has(url)) continue;
				seenUrls.add(url);
				notify(
					`MCP "${name}" needs authentication. Open this URL to sign in:\n${url}\nAfter signing in, run /reload to finish connecting.`,
					"warning",
				);
			}
		}
	});
}

async function connectStdio(
	name: string,
	config: McpServerConfig,
	dotEnv: Record<string, string>,
	notify: NotifyFn,
): Promise<ConnectedServer> {
	const resolvedCommand = expandMcpPathLikeString(config.command!);
	let resolvedArgs = config.args?.map(expandMcpPathLikeString);

	// Inject a PID label into docker run args so orphaned containers can be
	// detected and killed on the next session start.
	if (resolvedCommand === "docker" || resolvedCommand.endsWith("/docker")) {
		const runIdx = resolvedArgs?.indexOf("run") ?? -1;
		if (runIdx !== -1 && resolvedArgs) {
			resolvedArgs = [
				...resolvedArgs.slice(0, runIdx + 1),
				"--label", `${MCP_LABEL_KEY}=${process.pid}`,
				...resolvedArgs.slice(runIdx + 1),
			];
		}
	}

	// Inject env: process env + .env files + explicit config.env (config wins). Only
	// override the SDK's default minimal env when we actually have extra vars to add.
	const extraEnv = { ...dotEnv, ...(config.env ?? {}) };
	const env =
		Object.keys(extraEnv).length > 0
			? ({ ...process.env, ...extraEnv } as Record<string, string>)
			: undefined;

	const transport = new StdioClientTransport({
		command: resolvedCommand,
		args: resolvedArgs,
		env,
		stderr: "pipe",
		cwd: getMcpStdioCwd(),
	});
	attachStderrListener(name, transport, notify);
	const client = new Client({ name: `free-code:${name}`, version: "1.0.0" });
	await client.connect(transport);

	// Track the child PID for synchronous exit cleanup.
	const pid = transport.pid;
	if (pid != null) trackedPids.add(pid);

	return { name, client, transport };
}

async function connectHttp(name: string, config: McpServerConfig): Promise<ConnectedServer> {
	const transport = new StreamableHTTPClientTransport(new URL(config.url!));
	const client = new Client({ name: `free-code:${name}`, version: "1.0.0" });
	await client.connect(transport);
	return { name, client, transport };
}

function connectServer(
	name: string,
	config: McpServerConfig,
	dotEnv: Record<string, string>,
	notify: NotifyFn,
): Promise<ConnectedServer> {
	if (config.command) return connectStdio(name, config, dotEnv, notify);
	if (config.url) return connectHttp(name, config);
	return Promise.reject(new Error("no command or url specified"));
}

interface RegisterToolDeps {
	pi: ExtensionAPI;
	serverName: string;
	tool: ToolList[number];
	toolName: string;
	getClient: () => Promise<Client>;
}

function registerMcpTool({ pi, serverName, tool, toolName, getClient }: RegisterToolDeps): void {
	const schema = tool.inputSchema ?? { type: "object" as const };

	pi.registerTool({
		name: toolName,
		label: tool.annotations?.title ?? tool.name,
		description: `[${serverName}] ${tool.description ?? "MCP tool"}`,
		parameters: Type.Unsafe<Record<string, unknown>>(schema),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<undefined>> {
			const client = await getClient();
			const result = await client.callTool({
				name: tool.name,
				arguments: params,
			});

			if (result.isError) {
				const errorText = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				return {
					content: [{ type: "text", text: errorText || "MCP tool returned an error" }],
					details: undefined,
					isError: true,
				};
			}

			const textParts = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text);

			const text = textParts.length > 0 ? textParts.join("\n") : "Tool returned no text output.";
			return {
				content: [{ type: "text", text }],
				details: undefined,
			};
		},
	});
}

function computeDuplicates(entries: Array<{ tools: ToolList }>): { all: Set<string>; duplicates: Set<string> } {
	const all = new Set<string>();
	const duplicates = new Set<string>();
	for (const { tools } of entries) {
		for (const tool of tools) {
			if (all.has(tool.name)) duplicates.add(tool.name);
			all.add(tool.name);
		}
	}
	return { all, duplicates };
}

export default function (pi: ExtensionAPI) {
	const connectedServers: ConnectedServer[] = [];
	let backgroundWork: Promise<void> | undefined;

	registerCleanupHandlers(() => connectedServers);

	pi.on("session_start", async (_event, ctx) => {
		await killOrphanedContainers((msg, level) => ctx.ui.notify(msg, level));

		const config = loadMcpConfig(ctx.cwd);
		const allEntries = Object.entries(config.mcpServers);
		if (allEntries.length === 0) return;

		// Only start servers the user has enabled. Newly configured servers default to
		// disabled via reconciliation, so adding one to mcp.json never auto-starts it.
		const status = reconcileMcpStatus(allEntries.map(([name]) => name));
		const entries = allEntries.filter(([name]) => status[name] === "enabled");
		if (entries.length === 0) {
			ctx.ui.notify(
				`MCP: ${allEntries.length} server(s) configured but none enabled. Enable with /mcp enable <name>.`,
				"info",
			);
			return;
		}

		const cache = loadToolsCache();
		const configHashes = new Map<string, string>();
		for (const [name, cfg] of entries) {
			configHashes.set(name, hashServerConfig(cfg));
		}

		// Cache is valid only when every configured server has a matching entry.
		// If any is missing or the hash changed, we fall back to the slow path so
		// the first run with a new server still produces a correct tool list.
		const allCached = entries.every(([name]) => {
			const entry = cache.entries[name];
			return entry && entry.hash === configHashes.get(name) && Array.isArray(entry.tools) && entry.tools.length > 0;
		});

		// Kick off connections in parallel up-front so the eager path gets clients
		// warming up while we register from cache, and the slow path awaits them.
		const dotEnv = loadMcpDotEnv(ctx.cwd);
		const notify: NotifyFn = (msg, level) => ctx.ui.notify(msg, level);
		const clientPromises = new Map<string, Promise<ConnectedServer>>();
		for (const [name, serverConfig] of entries) {
			clientPromises.set(name, connectServer(name, serverConfig, dotEnv, notify));
		}

		const getClientFor = (name: string): Promise<Client> => {
			const promise = clientPromises.get(name);
			if (!promise) return Promise.reject(new Error(`MCP server "${name}" not configured`));
			return promise.then((server) => server.client);
		};

		const awaitAllConnections = async (): Promise<ConnectedServer[]> => {
			const connectResults = await Promise.allSettled(entries.map(([name]) => clientPromises.get(name)!));
			const connected: ConnectedServer[] = [];
			connectResults.forEach((result, index) => {
				const [name] = entries[index];
				if (result.status === "fulfilled") {
					connected.push(result.value);
				} else {
					const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
					ctx.ui.notify(`MCP "${name}": failed to connect - ${msg}`, "warning");
				}
			});
			return connected;
		};

		const listToolsAll = async (
			connected: ConnectedServer[],
		): Promise<Array<{ server: ConnectedServer; tools: ToolList }>> => {
			const listResults = await Promise.allSettled(connected.map((server) => server.client.listTools()));
			const live: Array<{ server: ConnectedServer; tools: ToolList }> = [];
			listResults.forEach((result, index) => {
				const server = connected[index];
				if (result.status === "fulfilled") {
					live.push({ server, tools: result.value.tools });
				} else {
					const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
					ctx.ui.notify(`MCP "${server.name}": failed to list tools - ${msg}`, "warning");
				}
			});
			return live;
		};

		const persistCache = (liveServerTools: Array<{ server: ConnectedServer; tools: ToolList }>): void => {
			const nextCache: ToolsCacheFile = { version: TOOLS_CACHE_VERSION, entries: { ...cache.entries } };
			for (const { server, tools } of liveServerTools) {
				const hash = configHashes.get(server.name);
				if (!hash) continue;
				nextCache.entries[server.name] = { hash, tools };
			}
			for (const cachedName of Object.keys(nextCache.entries)) {
				if (!configHashes.has(cachedName)) delete nextCache.entries[cachedName];
			}
			saveToolsCache(nextCache);
		};

		if (allCached) {
			// Eager path: register from cache synchronously so the tool-group
			// picker (and any other resources_ready consumer) sees MCP tools
			// immediately. Connections continue warming up in the background; any
			// tool invocation before a client is ready waits on its connect promise.
			const cachedEntries = entries.map(([name]) => ({ name, tools: cache.entries[name].tools }));
			const { all: allToolNames, duplicates } = computeDuplicates(cachedEntries);

			for (const { name, tools } of cachedEntries) {
				for (const tool of tools) {
					const toolName = duplicates.has(tool.name) ? `${name}:${tool.name}` : tool.name;
					registerMcpTool({
						pi,
						serverName: name,
						tool,
						toolName,
						getClient: () => getClientFor(name),
					});
				}
			}

			ctx.ui.notify(
				`MCP: ${entries.length} server(s) registered from cache, ${allToolNames.size} tool(s) available`,
				"info",
			);

			// Refresh the cache out-of-band so the next startup stays fast even if
			// server tool sets change. We don't block session_start on this.
			backgroundWork = (async () => {
				const connected = await awaitAllConnections();
				if (connected.length === 0) return;
				const liveServerTools = await listToolsAll(connected);
				persistCache(liveServerTools);
				connectedServers.push(...connected);

				let changed = false;
				for (const { server, tools } of liveServerTools) {
					const cachedTools = cache.entries[server.name]?.tools ?? [];
					if (cachedTools.length !== tools.length) {
						changed = true;
						break;
					}
					const cachedNames = new Set(cachedTools.map((t) => t.name));
					if (tools.some((t) => !cachedNames.has(t.name))) {
						changed = true;
						break;
					}
				}
				if (changed) {
					ctx.ui.notify(
						"MCP: tool list changed since last run; cache refreshed, restart to pick up changes",
						"info",
					);
				}
			})().catch((e) => {
				const msg = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`MCP: cache refresh failed - ${msg}`, "warning");
			});
			return;
		}

		// Slow path: no usable cache. Block session_start until connections are
		// established and tools are registered, so downstream `session_resources_ready`
		// consumers (e.g. the tool-group picker) wait for MCP servers to be ready.
		const connected = await awaitAllConnections();
		if (connected.length === 0) return;

		const liveServerTools = await listToolsAll(connected);
		persistCache(liveServerTools);

		const { all: allToolNames, duplicates } = computeDuplicates(liveServerTools);
		for (const { server, tools } of liveServerTools) {
			try {
				for (const tool of tools) {
					const toolName = duplicates.has(tool.name) ? `${server.name}:${tool.name}` : tool.name;
					registerMcpTool({
						pi,
						serverName: server.name,
						tool,
						toolName,
						getClient: () => Promise.resolve(server.client),
					});
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				ctx.ui.notify(`MCP "${server.name}": failed to register tools - ${msg}`, "warning");
			}
		}

		connectedServers.push(...connected);
		ctx.ui.notify(
			`MCP: ${liveServerTools.length} server(s) connected, ${allToolNames.size} tool(s) available`,
			"info",
		);
	});

	pi.on("session_shutdown", async () => {
		if (backgroundWork) {
			try {
				await backgroundWork;
			} catch {
				// Already surfaced via notify
			}
			backgroundWork = undefined;
		}
		for (const server of connectedServers) {
			const pid = server.transport instanceof StdioClientTransport ? server.transport.pid : null;
			try {
				await server.client.close();
			} catch {
				// Best effort cleanup
			}
			if (pid != null) trackedPids.delete(pid);
		}
		connectedServers.length = 0;
	});
}
