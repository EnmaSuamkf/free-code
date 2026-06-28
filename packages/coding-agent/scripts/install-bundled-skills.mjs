import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const sourceSkillsDir = join(packageDir, "skills");
const sourceMcpsDir = join(packageDir, "mcps");
const targetSkillsDir = join(homedir(), ".free-code", "skills");
const targetAgentDir = join(homedir(), ".free-code", "agent");

/** Template copied to `~/.free-code/agent/.env` when that file does not exist yet. */
const MCP_EXAMPLE_ENV = "example.env";

function isGlobalInstall() {
	const explicit = process.env.FREE_CODE_INSTALL_BUNDLED_SKILLS;
	if (explicit === "1" || explicit === "true") return true;
	if (explicit === "0" || explicit === "false") return false;
	return process.env.npm_config_global === "true" || process.env.npm_config_location === "global";
}

function shouldCopyPath(sourceDir, srcAbsolute) {
	const rel = relative(sourceDir, srcAbsolute);
	if (!rel || rel === ".") return true;
	const segments = rel.split(sep);
	if (segments.includes(".git")) return false;
	if (segments.includes("node_modules")) return false;
	if (segments.includes(".env")) return false;
	if (segments.some((s) => s === ".DS_Store")) return false;
	return true;
}

if (isGlobalInstall() && existsSync(sourceSkillsDir)) {
	mkdirSync(targetSkillsDir, { recursive: true });
	let skillsCopied = 0;
	for (const entry of readdirSync(sourceSkillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const source = join(sourceSkillsDir, entry.name);
		const target = join(targetSkillsDir, entry.name);
		if (existsSync(target)) {
			console.log(`Skipped bundled skill path (already exists): ${target}`);
			continue;
		}
		cpSync(source, target, {
			recursive: true,
			force: true,
			filter: (src) => shouldCopyPath(source, src),
		});
		skillsCopied++;
	}
	if (skillsCopied > 0) {
		console.log(`Installed bundled free-code skills to ${targetSkillsDir}`);
	}
}

if (isGlobalInstall() && existsSync(sourceMcpsDir)) {
	mkdirSync(targetAgentDir, { recursive: true });
	let mcpsCopied = 0;

	const exampleEnvSrc = join(sourceMcpsDir, MCP_EXAMPLE_ENV);
	const agentDotEnv = join(targetAgentDir, ".env");
	if (existsSync(exampleEnvSrc) && !existsSync(agentDotEnv)) {
		cpSync(exampleEnvSrc, agentDotEnv);
		mcpsCopied++;
		console.log(`Installed ${MCP_EXAMPLE_ENV} as ${agentDotEnv}`);
	}

	for (const entry of readdirSync(sourceMcpsDir, { withFileTypes: true })) {
		if (entry.name === MCP_EXAMPLE_ENV) continue;
		const source = join(sourceMcpsDir, entry.name);
		const target = join(targetAgentDir, entry.name);
		if (existsSync(target)) {
			console.log(`Skipped bundled MCP path (already exists): ${target}`);
			continue;
		}
		cpSync(source, target, {
			recursive: true,
			force: true,
			filter: (src) => shouldCopyPath(sourceMcpsDir, src),
		});
		mcpsCopied++;
	}
	if (mcpsCopied > 0) {
		console.log(`Installed bundled MCP files from mcps/ to ${targetAgentDir}`);
	}
}
