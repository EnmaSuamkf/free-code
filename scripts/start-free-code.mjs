#!/usr/bin/env node
/**
 * Dev launcher: optionally install global `agent-browser`, ensure the local browser extension
 * has its npm dependencies, then run free-code from sources. The CLI migration creates the
 * symlink in ~/.free-code/agent/extensions/browser on startup.
 *
 * Env:
 * - FREE_CODE_START_SKIP_GLOBAL_AGENT_BROWSER=1 — skip `npm install -g agent-browser`
 * - FREE_CODE_START_SKIP_BROWSER_EXTENSION=1    — skip `npm install` inside the browser extension
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "free-code-test.sh");
const extraArgs = process.argv.slice(2);
const browserExtensionSource = join(root, "packages", "coding-agent", "default-extensions", "browser");

function run(description, command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.status !== 0) {
		console.error(`[start] ${description} failed (exit ${result.status ?? "?"})`);
		process.exit(result.status ?? 1);
	}
}

if (process.env.FREE_CODE_START_SKIP_GLOBAL_AGENT_BROWSER !== "1") {
	run("global install of agent-browser", "npm", ["install", "-g", "agent-browser"], { cwd: root });
}

if (process.env.FREE_CODE_START_SKIP_BROWSER_EXTENSION !== "1" && existsSync(browserExtensionSource)) {
	const nodeModules = join(browserExtensionSource, "node_modules");
	if (!existsSync(nodeModules)) {
		run(
			"npm install inside default-extensions/browser",
			"npm",
			["install"],
			{ cwd: browserExtensionSource },
		);
	}
}

const result = spawnSync("bash", [launcher, ...extraArgs], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
