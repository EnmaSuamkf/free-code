import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
		return "yarn";
	}
	if (isBunRuntime) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
		return "npm";
	}

	return "unknown";
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	switch (method) {
		case "bun-binary":
			return `Download from: https://github.com/badlogic/pi-mono/releases/latest`;
		case "pnpm":
			return `Run: pnpm install -g ${packageName}`;
		case "yarn":
			return `Run: yarn global add ${packageName}`;
		case "bun":
			return `Run: bun install -g ${packageName}`;
		case "npm":
			return `Run: npm install -g ${packageName}`;
		default:
			return `Run: npm install -g ${packageName}`;
	}
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Directory where built-in theme JSON files ship with the package/binary (read-only source for seeding).
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getPackageBundledThemesSourceDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "theme");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Directory where built-in themes are loaded from after sync (~/.<config>/agent/themes/bundled).
 * Files are copied from {@link getPackageBundledThemesSourceDir} on first theme load (and refreshed on each process run).
 */
export function getThemesDir(): string {
	return join(getAgentDir(), "themes", "bundled");
}

/**
 * Copy shipped theme JSON files into the agent themes/bundled directory so paths and edits stay under ~/.free-code (or CONFIG_DIR).
 * Overwrites existing files so upgrades pick up theme updates. Safe to call repeatedly.
 */
export function syncBundledThemesFromPackage(): void {
	const source = getPackageBundledThemesSourceDir();
	const dest = join(getAgentDir(), "themes", "bundled");
	if (!existsSync(source)) {
		return;
	}
	mkdirSync(dest, { recursive: true });
	let files: string[];
	try {
		files = readdirSync(source);
	} catch {
		return;
	}
	for (const file of files) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const srcPath = join(source, file);
		const dstPath = join(dest, file);
		try {
			copyFileSync(srcPath, dstPath);
		} catch {
			// Best effort per file
		}
	}
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/**
 * Get path to bundled default extensions directory (shipped with package).
 * - For Bun binary: default-extensions/ next to executable
 * - For Node.js: default-extensions/ in the package root
 */
export function getDefaultExtensionsDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "default-extensions");
	}
	return join(getPackageDir(), "default-extensions");
}

/**
 * Get path to bundled default skills directory (shipped with package).
 * - For Bun binary: skills/ next to executable
 * - For Node.js: skills/ in the package root
 */
export function getDefaultSkillsDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "skills");
	}
	return join(getPackageDir(), "skills");
}

/** Shipped sample rules for the damage-control extension (always next to bundled default-extensions). */
export function getBundledDamageControlRulesPath(): string {
	return join(getDefaultExtensionsDir(), "damage-control-rules.yaml");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));

export const APP_NAME: string = pkg.piConfig?.name || "pi";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
export const VERSION: string = pkg.version;

/** Uppercase app name with non-alphanumerics → `_`, for env var prefixes (e.g. `free-code` → `FREE_CODE`). */
export function appNameToEnvPrefix(name: string): string {
	const upper = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	const trimmed = upper.replace(/^_+|_+$/g, "");
	return trimmed.length > 0 ? trimmed : "PI";
}

// e.g., PI_CODING_AGENT_DIR or FREE_CODE_CODING_AGENT_DIR
export const ENV_AGENT_PREFIX = appNameToEnvPrefix(APP_NAME);
export const ENV_AGENT_DIR = `${ENV_AGENT_PREFIX}_CODING_AGENT_DIR`;

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (e.g. ~/.free-code/agent/)
// =============================================================================

/** Get the agent config directory (e.g., ~/.free-code/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR] ?? process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		// Expand tilde to home directory
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

let agentEnvLoaded = false;

/**
 * Load `<agentDir>/.env` into `process.env`, filling only variables that are not
 * already set (shell/exported values always win). This lets users keep provider
 * credentials (e.g. `FIREWORKS_API_KEY`) in one place and reference them by name in
 * `models.json`, so `/model` availability checks and requests both resolve them.
 *
 * Idempotent: runs once per process. Best-effort — a missing or malformed file is ignored.
 */
export function loadAgentEnvFile(): void {
	if (agentEnvLoaded) return;
	agentEnvLoaded = true;

	const envPath = join(getAgentDir(), ".env");
	if (!existsSync(envPath)) return;

	let content: string;
	try {
		content = readFileSync(envPath, "utf-8");
	} catch {
		return;
	}

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (!key || key in process.env) continue; // never override an existing value
		let value = line.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

/**
 * Optional monorepo root for resolving relative CLI paths (`-e`, `--skill`, `--prompt`, `--theme`).
 * When a path does not exist relative to the process cwd, it is tried against this directory.
 * Example: `export FREE_CODE_ROOT=~/work/free-code` then `free-code -e extensions/pure-focus.ts` works from any cwd.
 */
export function getCliResourceFallbackRoot(): string | undefined {
	const key = `${ENV_AGENT_PREFIX}_ROOT`;
	const raw = process.env[key];
	if (!raw || raw.length === 0) {
		return undefined;
	}
	if (raw === "~") return homedir();
	if (raw.startsWith("~/")) return homedir() + raw.slice(1);
	return raw;
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to user profiles (tools/skills/agents/theme presets). */
export function getProfilesPath(): string {
	return join(getAgentDir(), "profiles.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
