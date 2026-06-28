import type { ExtensionAPI, ExtensionContext } from "@free/pi-coding-agent";
import { getBundledDamageControlRulesPath, isToolCallEventType } from "@free/pi-coding-agent";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

interface Rule {
	pattern: string;
	reason: string;
	ask?: boolean;
}

interface Rules {
	bashToolPatterns: Rule[];
	zeroAccessPaths: string[];
	readOnlyPaths: string[];
	noDeletePaths: string[];
}

const BUILTIN_TOOL_NAMES = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);
const SUBAGENT_MCP_AUTH_ENV = "FREE_CODE_SUBAGENT_MCP_AUTH";

/** Sample rules from the installed coding-agent package (same path the CLI uses; works for copies under agent/extensions). */
function resolvePackageBundledRulesPath(): string | undefined {
	const candidate = getBundledDamageControlRulesPath();
	return fs.existsSync(candidate) ? candidate : undefined;
}

/** MCP tools are registered by default-extensions/mcp-client.ts; match by extension source path. */
function isRegisteredMcpTool(pi: ExtensionAPI, toolName: string): boolean {
	if (BUILTIN_TOOL_NAMES.has(toolName)) return false;
	const info = pi.getAllTools().find((t) => t.name === toolName);
	if (!info) return false;
	const normalized = info.sourceInfo.path.replace(/\\/g, "/");
	return normalized.includes("mcp-client");
}

export default function (pi: ExtensionAPI) {
	let rules: Rules = {
		bashToolPatterns: [],
		zeroAccessPaths: [],
		readOnlyPaths: [],
		noDeletePaths: [],
	};

	/** When false, YAML rules and MCP prompts are skipped (session-local; reset on new session). */
	let damageControlEnabled = true;

	/** Session-wide MCP policy set on first MCP tool_call after session_start. */
	let mcpSessionAuth: "unset" | "allowed" | "denied" =
		process.env[SUBAGENT_MCP_AUTH_ENV] === "allowed" ? "allowed" : "unset";

	function ruleCount(): number {
		return (
			rules.bashToolPatterns.length +
			rules.zeroAccessPaths.length +
			rules.readOnlyPaths.length +
			rules.noDeletePaths.length
		);
	}

	function syncDamageControlStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const n = ruleCount();
		if (!damageControlEnabled) {
			ctx.ui.setStatus("damage-control", `🛡️ Damage-Control: off (${n} rules loaded, not enforced)`);
		} else {
			ctx.ui.setStatus("damage-control", `🛡️ Damage-Control Active: ${n} Rules`);
		}
	}

	pi.registerCommand("damage-control", {
		description: "Toggle firewall: /damage-control [on|off|toggle|status]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const first = args.trim().toLowerCase().split(/\s+/)[0] ?? "";

			if (first === "on" || first === "enable") {
				damageControlEnabled = true;
				syncDamageControlStatus(ctx);
				ctx.ui.notify("Damage-Control: enforcement on.", "info");
				return;
			}
			if (first === "off" || first === "disable") {
				damageControlEnabled = false;
				syncDamageControlStatus(ctx);
				ctx.ui.notify("Damage-Control: enforcement off (rules still loaded).", "info");
				return;
			}
			if (first === "status") {
				ctx.ui.notify(
					`Damage-Control: ${damageControlEnabled ? "on" : "off"} — ${ruleCount()} rules loaded`,
					"info",
				);
				return;
			}
			if (first === "toggle" || first === "") {
				damageControlEnabled = !damageControlEnabled;
				syncDamageControlStatus(ctx);
				ctx.ui.notify(`Damage-Control: ${damageControlEnabled ? "on" : "off"}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /damage-control [on | off | toggle | status] (no args = toggle)", "warning");
		},
	});

	function resolvePath(p: string, cwd: string): string {
		if (p.startsWith("~")) {
			p = path.join(os.homedir(), p.slice(1));
		}
		return path.resolve(cwd, p);
	}

	function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
		// Simple glob-to-regex or substring match
		// Expand tilde in pattern if present
		const resolvedPattern = pattern.startsWith("~") ? path.join(os.homedir(), pattern.slice(1)) : pattern;

		// If pattern ends with /, it's a directory match
		if (resolvedPattern.endsWith("/")) {
			const absolutePattern = path.isAbsolute(resolvedPattern)
				? resolvedPattern
				: path.resolve(cwd, resolvedPattern);
			return targetPath.startsWith(absolutePattern);
		}

		// Handle basic wildcards *
		const regexPattern = resolvedPattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars
			.replace(/\*/g, ".*"); // convert * to .*

		const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);

		// Match against absolute path and relative-to-cwd path
		const relativePath = path.relative(cwd, targetPath);

		return (
			regex.test(targetPath) ||
			regex.test(relativePath) ||
			targetPath.includes(resolvedPattern) ||
			relativePath.includes(resolvedPattern)
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		mcpSessionAuth = process.env[SUBAGENT_MCP_AUTH_ENV] === "allowed" ? "allowed" : "unset";
		damageControlEnabled = true;
		applyExtensionDefaults(import.meta.url, ctx);
		const extensionDir = path.dirname(fileURLToPath(import.meta.url));
		const localRulesPath = path.join(extensionDir, "damage-control-rules.yaml");
		const packagedFallback = resolvePackageBundledRulesPath();
		const rulesPath = fs.existsSync(localRulesPath) ? localRulesPath : packagedFallback;
		const rulesSource: "extension" | "package" | "none" = rulesPath
			? rulesPath === localRulesPath
				? "extension"
				: "package"
			: "none";
		try {
			if (rulesPath) {
				const content = fs.readFileSync(rulesPath, "utf8");
				const loaded = yamlParse(content) as Partial<Rules>;
				rules = {
					bashToolPatterns: loaded.bashToolPatterns || [],
					zeroAccessPaths: loaded.zeroAccessPaths || [],
					readOnlyPaths: loaded.readOnlyPaths || [],
					noDeletePaths: loaded.noDeletePaths || [],
				};
				const origin =
					rulesSource === "extension"
						? "next to extension"
						: "default sample from @free/pi-coding-agent (add damage-control-rules.yaml next to your extension to override)";
				ctx.ui.notify(
					`🛡️ Damage-Control: Loaded ${rules.bashToolPatterns.length + rules.zeroAccessPaths.length + rules.readOnlyPaths.length + rules.noDeletePaths.length} rules (${origin}).`,
				);
			} else {
				ctx.ui.notify(
					`🛡️ Damage-Control: No rules file at ${localRulesPath} and could not load bundled sample from the coding-agent package.`,
					"warning",
				);
			}
		} catch (err) {
			ctx.ui.notify(`🛡️ Damage-Control: Failed to load rules: ${err instanceof Error ? err.message : String(err)}`);
		}

		syncDamageControlStatus(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!damageControlEnabled) {
			return { block: false };
		}

		let violationReason: string | null = null;
		let shouldAsk = false;

		// 1. Check Zero Access Paths for all tools that use path or glob
		const checkPaths = (pathsToCheck: string[]) => {
			for (const p of pathsToCheck) {
				const resolved = resolvePath(p, ctx.cwd);
				for (const zap of rules.zeroAccessPaths) {
					if (isPathMatch(resolved, zap, ctx.cwd)) {
						return `Access to zero-access path restricted: ${zap}`;
					}
				}
			}
			return null;
		};

		// Extract paths from tool input
		const inputPaths: string[] = [];
		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("write", event) ||
			isToolCallEventType("edit", event)
		) {
			inputPaths.push(event.input.path);
		} else if (
			isToolCallEventType("grep", event) ||
			isToolCallEventType("find", event) ||
			isToolCallEventType("ls", event)
		) {
			inputPaths.push(event.input.path || ".");
		}

		if (isToolCallEventType("grep", event) && event.input.glob) {
			// Check glob field as well
			for (const zap of rules.zeroAccessPaths) {
				if (event.input.glob.includes(zap) || isPathMatch(event.input.glob, zap, ctx.cwd)) {
					violationReason = `Glob matches zero-access path: ${zap}`;
					break;
				}
			}
		}

		if (!violationReason) {
			violationReason = checkPaths(inputPaths);
		}

		// 2. Tool-specific logic
		if (!violationReason) {
			if (isToolCallEventType("bash", event)) {
				const command = event.input.command;

				// Check bashToolPatterns
				for (const rule of rules.bashToolPatterns) {
					const regex = new RegExp(rule.pattern);
					if (regex.test(command)) {
						violationReason = rule.reason;
						shouldAsk = !!rule.ask;
						break;
					}
				}

				// Check if bash command interacts with restricted paths
				if (!violationReason) {
					for (const zap of rules.zeroAccessPaths) {
						if (command.includes(zap)) {
							violationReason = `Bash command references zero-access path: ${zap}`;
							break;
						}
					}
				}

				if (!violationReason) {
					// Pure read-only commands never modify anything even if they reference a read-only path.
					const READ_ONLY_COMMANDS = /^\s*(ls|cat|head|tail|grep|find|rg|wc|echo|stat|file|diff|less|more|sort|uniq|cut|awk|xargs\s+(?:ls|cat|head|tail|grep|find|rg|wc|echo|stat))\b/;
					const isReadOnlyCommand = READ_ONLY_COMMANDS.test(command);
					if (!isReadOnlyCommand) {
						for (const rop of rules.readOnlyPaths) {
							// Heuristic: check if command might modify a read-only path.
							// Redirects (>), mutations (rm, mv, sed -i, tee, cp to), etc.
							if (
								command.includes(rop) &&
								(/>/.test(command) ||
									command.includes("rm") ||
									command.includes("mv") ||
									command.includes("sed") ||
									command.includes("tee") ||
									command.includes("cp") ||
									command.includes("write") ||
									command.includes("truncate"))
							) {
								violationReason = `Bash command may modify read-only path: ${rop}`;
								break;
							}
						}
					}
				}

				if (!violationReason) {
					for (const ndp of rules.noDeletePaths) {
						if (command.includes(ndp) && (command.includes("rm") || command.includes("mv"))) {
							violationReason = `Bash command attempts to delete/move protected path: ${ndp}`;
							break;
						}
					}
				}
			} else if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				// Check Read-Only paths
				for (const p of inputPaths) {
					const resolved = resolvePath(p, ctx.cwd);
					for (const rop of rules.readOnlyPaths) {
						if (isPathMatch(resolved, rop, ctx.cwd)) {
							violationReason = `Modification of read-only path restricted: ${rop}`;
							break;
						}
					}
				}
			}
		}

		if (violationReason) {
			if (shouldAsk) {
				const confirmed = await ctx.ui.confirm(
					"🛡️ Damage-Control Confirmation",
					`Dangerous command detected: ${violationReason}\n\nCommand: ${isToolCallEventType("bash", event) ? event.input.command : JSON.stringify(event.input)}\n\nDo you want to proceed?`,
					{ timeout: 30000 },
				);

				if (!confirmed) {
					ctx.ui.setStatus("damage-control", `⚠️ Last Violation Blocked: ${violationReason.slice(0, 30)}...`);
					pi.appendEntry("damage-control-log", {
						tool: event.toolName,
						input: event.input,
						rule: violationReason,
						action: "blocked_by_user",
					});
					ctx.abort();
					return {
						block: true,
						reason: `🛑 BLOCKED by Damage-Control: ${violationReason} (User denied)\n\nDO NOT attempt to work around this restriction. DO NOT retry with alternative commands, paths, or approaches that achieve the same result. Report this block to the user exactly as stated and ask how they would like to proceed.`,
					};
				} else {
					pi.appendEntry("damage-control-log", {
						tool: event.toolName,
						input: event.input,
						rule: violationReason,
						action: "confirmed_by_user",
					});
					return { block: false };
				}
			} else {
				ctx.ui.notify(`🛑 Damage-Control: Blocked ${event.toolName} due to ${violationReason}`);
				ctx.ui.setStatus("damage-control", `⚠️ Last Violation: ${violationReason.slice(0, 30)}...`);
				pi.appendEntry("damage-control-log", {
					tool: event.toolName,
					input: event.input,
					rule: violationReason,
					action: "blocked",
				});
				ctx.abort();
				return {
					block: true,
					reason: `🛑 BLOCKED by Damage-Control: ${violationReason}\n\nDO NOT attempt to work around this restriction. DO NOT retry with alternative commands, paths, or approaches that achieve the same result. Report this block to the user exactly as stated and ask how they would like to proceed.`,
				};
			}
		}

		// 3. MCP tools: one interactive authorization for the whole session (mcp-client extension).
		if (!violationReason && isRegisteredMcpTool(pi, event.toolName)) {
			if (mcpSessionAuth === "allowed") {
				return { block: false };
			}
			if (mcpSessionAuth === "denied") {
				ctx.ui.notify(`Damage-Control: MCP tools are blocked for this session`, "warning");
				ctx.ui.setStatus("damage-control", "MCP blocked (session)");
				pi.appendEntry("damage-control-log", {
					tool: event.toolName,
					input: event.input,
					rule: "mcp_session_denied",
					action: "blocked",
				});
				ctx.abort();
				return {
					block: true,
					reason:
						"BLOCKED by Damage-Control: MCP tools were declined for this session. Start a new session or reload extensions if you need MCP access.",
				};
			}

			// ctx.ui.confirm() works in every mode via the extension UI layer:
			//  - interactive TUI (hasUI = true) → native TUI dialog
			//  - RPC mode (hasUI = false) → extension_ui_request / extension_ui_response over stdio
			//    (embedding hosts such as the VS Code plugin show their own modal)
			//  - print / noOp mode (hasUI = false) → returns false immediately (denied)
			// We therefore call confirm unconditionally. Modes with no real UI end up with a clean "denied",
			// modes with a host (TUI or RPC) get a proper authorization prompt, matching the CLI experience.
			const confirmed = await ctx.ui.confirm(
				"MCP authorization",
				`Allow MCP tools for the rest of this session?\n\nRequested tool: ${event.toolName}\n\nIf you confirm, further MCP tool calls will not prompt again until this session ends.`,
				{ timeout: 120_000 },
			);

			if (confirmed) {
				mcpSessionAuth = "allowed";
				ctx.ui.notify("Damage-Control: MCP tools authorized for this session", "info");
				pi.appendEntry("damage-control-log", {
					tool: event.toolName,
					input: event.input,
					rule: "mcp_session_allowed",
					action: "confirmed_by_user",
				});
				return { block: false };
			}

			mcpSessionAuth = "denied";
			ctx.ui.notify(`Damage-Control: MCP tools declined for this session`, "warning");
			ctx.ui.setStatus("damage-control", "MCP declined (session)");
			pi.appendEntry("damage-control-log", {
				tool: event.toolName,
				input: event.input,
				rule: "mcp_session_declined",
				action: "blocked_by_user",
			});
			ctx.abort();
			return {
				block: true,
				reason:
					"BLOCKED by Damage-Control: MCP tools were not authorized for this session. Tell the user they can start a new session if they want to allow MCP later.",
			};
		}

		return { block: false };
	});
}
