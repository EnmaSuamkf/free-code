/**
 * /mcp command — control which MCP servers start automatically.
 *
 * Subcommands:
 *   /mcp list            show every configured server with its enabled/disabled state
 *   /mcp enable <name>   mark a server to start on the next session
 *   /mcp disable <name>  stop a server from starting automatically
 *
 * Activation state lives in ~/.free-code/agent/mcp-status.json (see ./lib/mcp-status.ts).
 * Newly configured servers default to disabled, so adding a server to mcp.json by hand
 * does not auto-start it. Changes take effect after /reload or a new session.
 */
import type { ExtensionAPI } from "@free/pi-coding-agent";
import { getReconciledMcpStatus, setMcpServerStatus } from "./lib/mcp-status.ts";

const USAGE = "Usage: /mcp list | /mcp enable <name> | /mcp disable <name>";
const SUBCOMMANDS = new Set(["list", "enable", "disable"]);

export default function mcpCommandExtension(pi: ExtensionAPI) {
	pi.registerCommand("mcp", {
		description: "Manage MCP servers: /mcp list | /mcp enable <name> | /mcp disable <name>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstWhitespace = trimmed.search(/\s/);
			const subcommand = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
			const name = firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace + 1).trim();

			if (!SUBCOMMANDS.has(subcommand)) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}

			const { names, status } = getReconciledMcpStatus(ctx.cwd);

			if (subcommand === "list") {
				if (names.length === 0) {
					ctx.ui.notify(
						"No MCP servers configured. Add them to ~/.free-code/agent/mcp.json or run /mcp-import.",
						"info",
					);
					return;
				}
				const lines = names
					.slice()
					.sort()
					.map((n) => `  ${status[n] === "enabled" ? "[on] " : "[off]"} ${n}`);
				ctx.ui.notify(
					`MCP servers:\n${lines.join("\n")}\n\nEnabled servers start automatically. Run /reload (or start a new session) to apply changes.`,
					"info",
				);
				return;
			}

			// enable / disable
			if (!name) {
				ctx.ui.notify(`Usage: /mcp ${subcommand} <name>`, "warning");
				return;
			}
			if (!names.includes(name)) {
				const known = names.length > 0 ? names.join(", ") : "(none configured)";
				ctx.ui.notify(`Unknown MCP server "${name}". Configured servers: ${known}`, "warning");
				return;
			}

			const target = subcommand === "enable" ? "enabled" : "disabled";
			if (status[name] === target) {
				ctx.ui.notify(`MCP "${name}" is already ${target}.`, "info");
				return;
			}

			setMcpServerStatus(name, target);
			ctx.ui.notify(`MCP "${name}" ${target}. Run /reload (or start a new session) to apply.`, "info");
		},
	});
}
