/**
 * Direct Bash — Run shell commands without agent interpretation.
 *
 * Usage:
 *   /sh ls -la
 *   /sh cd /tmp && pwd
 *   /sh git status
 *   /sh cd           (go to home directory)
 *   /sh reset        (return to project root)
 *
 * Maintains a persistent working directory across invocations.
 * Output is displayed inline but NOT sent to the LLM.
 *
 * When the tracked directory differs from the project root,
 * the agent's built-in tools (bash, read, edit, write, grep, find, ls)
 * are redirected to operate from the tracked directory.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@free/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	isToolCallEventType,
	truncateTail,
} from "@free/pi-coding-agent";
import { Text } from "@free/pi-tui";

const CWD_SENTINEL = "___DIRECT_BASH_CWD_SENTINEL_d7f3a___";

interface BashOutputDetails {
	command: string;
	cwd: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	truncated: boolean;
}

function shellEscape(dir: string): string {
	return `'${dir.replace(/'/g, "'\\''")}'`;
}

export default function (pi: ExtensionAPI) {
	let currentDir: string | undefined;
	let projectDir: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		currentDir = ctx.cwd;
		projectDir = ctx.cwd;
		if (ctx.hasUI) {
			ctx.ui.setStatus("direct-bash", undefined);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!currentDir || !projectDir || currentDir === projectDir) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\nThe user's shell working directory is: ${currentDir}\nAll relative paths and bash commands will execute from this directory, not ${ctx.cwd}.`,
		};
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (!currentDir || !projectDir || currentDir === projectDir) return;

		if (isToolCallEventType("bash", event)) {
			event.input.command = `cd ${shellEscape(currentDir)} && ${event.input.command}`;
		}

		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("edit", event) ||
			isToolCallEventType("write", event)
		) {
			if (!isAbsolute(event.input.path)) {
				event.input.path = resolve(currentDir, event.input.path);
			}
		}

		if (
			isToolCallEventType("grep", event) ||
			isToolCallEventType("find", event) ||
			isToolCallEventType("ls", event)
		) {
			const p = event.input.path;
			if (p && !isAbsolute(p)) {
				event.input.path = resolve(currentDir, p);
			} else if (!p) {
				event.input.path = currentDir;
			}
		}
	});

	function syncStatus(ctx: { hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void } }): void {
		if (!ctx.hasUI) return;
		if (currentDir && projectDir && currentDir !== projectDir) {
			ctx.ui.setStatus("direct-bash", `shell: ${currentDir}`);
		} else {
			ctx.ui.setStatus("direct-bash", undefined);
		}
		pi.events.emit("direct-bash:cwd", currentDir);
	}

	pi.registerMessageRenderer<BashOutputDetails>("direct-bash", (message, _options, theme) => {
		const details = message.details;
		if (!details) return new Text("", 0, 0);

		const exitColor = details.exitCode === 0 ? "success" : "error";
		const exitLabel = details.exitCode === 0 ? "ok" : `exit ${details.exitCode}`;

		let header = theme.fg("dim", `${details.cwd} `);
		header += theme.fg("toolTitle", theme.bold("$ "));
		header += theme.fg("accent", details.command);
		header += `  ${theme.fg(exitColor, `[${exitLabel}]`)}`;
		if (details.truncated) {
			header += `  ${theme.fg("warning", "[truncated]")}`;
		}

		let body = "";
		if (details.stdout) {
			body += details.stdout;
		}
		if (details.stderr) {
			if (body) body += "\n";
			body += theme.fg("warning", details.stderr);
		}
		if (!body) {
			body = theme.fg("dim", "(no output)");
		}

		return new Text(`${header}\n${body}`, 0, 0);
	});

	pi.registerCommand("sh", {
		description: "Run a shell command directly (not sent to the agent): /sh <command>  |  /sh reset",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("Usage: /sh <command>  |  /sh reset", "warning");
				return;
			}

			if (!currentDir) currentDir = ctx.cwd;
			if (!projectDir) projectDir = ctx.cwd;

			if (command === "reset") {
				currentDir = projectDir;
				syncStatus(ctx);
				ctx.ui.notify(`Shell directory reset to ${projectDir}`, "info");
				return;
			}

			const cwdBefore = currentDir;

			const wrappedCommand = [command, "__dbe=$?", `echo "${CWD_SENTINEL}"`, "pwd", "exit $__dbe"].join("\n");

			const result = await pi.exec("bash", ["-c", wrappedCommand], {
				cwd: currentDir,
				timeout: 30_000,
			});

			let stdout = result.stdout;
			const stderr = result.stderr;

			const sentinelIdx = stdout.lastIndexOf(CWD_SENTINEL);
			if (sentinelIdx !== -1) {
				const afterSentinel = stdout.slice(sentinelIdx + CWD_SENTINEL.length).trim();
				const newCwd = afterSentinel.split("\n")[0]?.trim();
				if (newCwd && existsSync(newCwd)) {
					currentDir = newCwd;
				}
				stdout = stdout.slice(0, sentinelIdx).trimEnd();
			}

			syncStatus(ctx);

			let truncated = false;
			const truncation = truncateTail(stdout, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			if (truncation.truncated) {
				stdout = truncation.content;
				stdout += `\n[truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
				truncated = true;
			}

			pi.sendMessage(
				{
					customType: "direct-bash",
					content: `$ ${command}\n${stdout}${stderr ? `\n${stderr}` : ""}`,
					display: true,
					details: {
						command,
						cwd: cwdBefore,
						stdout,
						stderr,
						exitCode: result.code,
						truncated,
					} satisfies BashOutputDetails,
				},
				{ triggerTurn: false },
			);
		},
	});
}
