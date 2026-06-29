/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "fs";
import { dirname, join, relative, sep } from "path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getBinDir,
	getDefaultExtensionsDir,
	getDefaultSkillsDir,
	getPackageDir,
	syncBundledThemesFromPackage,
} from "./config.js";
import { migrateKeybindingsConfig } from "./core/keybindings.js";
import { defaultModelPerProvider } from "./core/model-resolver.js";

/**
 * Providers you authenticate with via `/login` (OAuth). The default `models.json`
 * seed curates `/model` down to the default model of each, instead of the full catalog.
 */
const LOGIN_PROVIDERS = [
	"anthropic",
	"openai-codex",
	"google-gemini-cli",
	"google-antigravity",
	"github-copilot",
] as const;

const MIGRATION_GUIDE_URL =
	"https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL = "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	// Migrate oauth.json
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(readFileSync(oauthPath, "utf-8"));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(content);
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/badlogic/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Copy bundled default extensions to the user's global extensions directory.
 * Always overwrites to keep extensions in sync with the installed version.
 * Copies the tree recursively (e.g. lib/, YAML) but skips paths that must not land in ~/.free-code/agent/extensions:
 * the nested `browser/` package (often contains node_modules), any node_modules/.git, and junk files.
 */
function syncDefaultExtensions(): void {
	const sourceDir = getDefaultExtensionsDir();
	if (!existsSync(sourceDir)) return;

	const targetDir = join(getAgentDir(), "extensions");
	mkdirSync(targetDir, { recursive: true });

	// Ensure there's a package.json with `type: module` next to the .ts extensions so Node can
	// load them as ESM without the "Cannot determine intended module format" error when the
	// target dir has no parent package.json to inherit from.
	const pkgPath = join(targetDir, "package.json");
	if (!existsSync(pkgPath)) {
		try {
			writeFileSync(
				pkgPath,
				`${JSON.stringify({ name: "free-code-default-extensions", private: true, type: "module" }, null, 2)}\n`,
			);
		} catch {
			// best effort
		}
	}

	const shouldCopyPath = (srcAbsolute: string): boolean => {
		const rel = relative(sourceDir, srcAbsolute);
		if (!rel || rel === ".") return true;
		const segments = rel.split(sep);
		if (segments[0] === "browser") return false;
		if (segments.includes("node_modules")) return false;
		if (segments.includes(".git")) return false;
		if (segments.some((s) => s === ".DS_Store")) return false;
		return true;
	};

	try {
		cpSync(sourceDir, targetDir, {
			recursive: true,
			force: true,
			filter: (src) => shouldCopyPath(src),
		});
	} catch {
		// Skip if the tree can't be copied (permissions, partial FS, etc.)
	}

	// The browser extension is loaded as a bundled, always-on extension.
	// If a previous version created a symlink under ~/.free-code/agent/extensions, remove it so it
	// doesn't show up in `free-code config`.
	unlinkBundledBrowserExtension(sourceDir, targetDir);
}

/**
 * Copy bundled default skills to the user's global skills directory.
 * Always overwrites to keep skills in sync with the installed version (same policy as
 * `syncDefaultExtensions`). Copies the tree recursively but skips node_modules/.git/.DS_Store.
 * User-authored skills with other names are left untouched (cpSync does not prune the target).
 */
function syncDefaultSkills(): void {
	const sourceDir = getDefaultSkillsDir();
	if (!existsSync(sourceDir)) return;

	const targetDir = join(getAgentDir(), "skills");
	mkdirSync(targetDir, { recursive: true });

	const shouldCopyPath = (srcAbsolute: string): boolean => {
		const rel = relative(sourceDir, srcAbsolute);
		if (!rel || rel === ".") return true;
		const segments = rel.split(sep);
		if (segments.includes("node_modules")) return false;
		if (segments.includes(".git")) return false;
		if (segments.some((s) => s === ".DS_Store")) return false;
		return true;
	};

	try {
		cpSync(sourceDir, targetDir, {
			recursive: true,
			force: true,
			filter: (src) => shouldCopyPath(src),
		});
	} catch {
		// Skip if the tree can't be copied (permissions, partial FS, etc.)
	}
}

function unlinkBundledBrowserExtension(sourceDir: string, targetDir: string): void {
	const browserSource = join(sourceDir, "browser");
	const browserTarget = join(targetDir, "browser");
	if (!existsSync(browserSource)) return;
	if (!lstatIfExists(browserTarget)) return;

	try {
		const stat = lstatSync(browserTarget);
		if (!stat.isSymbolicLink()) return;
		const currentTarget = readlinkSync(browserTarget);
		if (currentTarget !== browserSource) return;
		rmSync(browserTarget, { recursive: true, force: true });
	} catch {
		// best effort
	}
}

function lstatIfExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create settings.json with sensible defaults if it doesn't exist yet.
 */
function initDefaultSettings(): void {
	const settingsPath = join(getAgentDir(), "settings.json");
	if (existsSync(settingsPath)) return;

	const defaults = {
		defaultThinkingLevel: "low",
	};

	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(defaults, null, 2));
}

/**
 * Seed a starter `models.json` (only if absent — never overwrites the user's file).
 *
 * Fresh installs otherwise show the full factory catalog of every authenticated
 * provider in `/model`. Instead we seed an `only` whitelist with the default model
 * of each login-capable (OAuth) provider, giving a clean list out of the box. Users
 * edit `only` to curate and add custom providers/models under `providers`
 * (see docs/models.md).
 */
function initDefaultModelsJson(): void {
	const modelsPath = join(getAgentDir(), "models.json");
	if (existsSync(modelsPath)) return;

	const only = LOGIN_PROVIDERS.map((provider) => {
		const modelId = defaultModelPerProvider[provider];
		return modelId ? `${provider}/${modelId}` : undefined;
	}).filter((entry): entry is string => entry !== undefined);

	const defaults = { only, providers: {} };

	mkdirSync(dirname(modelsPath), { recursive: true });
	writeFileSync(modelsPath, `${JSON.stringify(defaults, null, 2)}\n`);
}

/**
 * Resolve the source AGENTS.md that should be seeded into ~/.free-code/agent/.
 *
 * Lookup order:
 * 1. `FREE_CODE_AGENTS_MD_SOURCE` env var (absolute path). Escape hatch for
 *    tests and custom deployments.
 * 2. `<package>/AGENTS.md` — generic rules committed with the package (not the
 *    monorepo root AGENTS.md, which is maintainer-only).
 *
 * Returns `undefined` if none is found so the caller can skip creation rather
 * than seed a stale fallback.
 */
function resolveGlobalAgentsMdSource(): string | undefined {
	const envOverride = process.env.FREE_CODE_AGENTS_MD_SOURCE;
	if (envOverride && existsSync(envOverride)) return envOverride;

	const bundled = join(getPackageDir(), "AGENTS.md");
	if (existsSync(bundled)) return bundled;

	return undefined;
}

/**
 * Resolve the source FREE_CODE.md that should be seeded into ~/.free-code/agent/.
 *
 * Lookup order:
 * 1. `FREE_CODE_MD_SOURCE` env var (absolute path). Escape hatch for
 *    tests and custom deployments.
 * 2. `<package>/FREE_CODE.md` — copy bundled with the installed package (see
 *    `prepack` in packages/coding-agent/package.json).
 * 3. `<package>/../../FREE_CODE.md` — monorepo root during tsx dev, where the
 *    package is at `packages/coding-agent/` and the FREE_CODE.md lives two levels
 *    up.
 * 4. Legacy `EDO.md` paths, for users and packages from before the FreeCode rename.
 *
 * Returns `undefined` if none is found so the caller can skip creation rather
 * than seed a stale fallback.
 */
function resolveGlobalFreeCodeMdSource(): string | undefined {
	const envOverride = process.env.FREE_CODE_MD_SOURCE ?? process.env.FREE_CODE_EDO_MD_SOURCE;
	if (envOverride && existsSync(envOverride)) return envOverride;

	const packageDir = getPackageDir();

	const bundled = join(packageDir, "FREE_CODE.md");
	if (existsSync(bundled)) return bundled;

	const monorepoRoot = join(packageDir, "..", "..", "FREE_CODE.md");
	if (existsSync(monorepoRoot)) return monorepoRoot;

	const legacyBundled = join(packageDir, "EDO.md");
	if (existsSync(legacyBundled)) return legacyBundled;

	const legacyMonorepoRoot = join(packageDir, "..", "..", "EDO.md");
	if (existsSync(legacyMonorepoRoot)) return legacyMonorepoRoot;

	return undefined;
}

/**
 * Create ~/.free-code/agent/AGENTS.md by copying the repo/package AGENTS.md if
 * it doesn't exist yet.
 *
 * The resource loader looks for AGENTS.md (and CLAUDE.md) in the agent dir and
 * in every ancestor of the cwd; whatever is found is injected into the system
 * prompt as project context. Copying the package's generic AGENTS.md into the
 * global agent dir means the same editing, retry, and workflow rules apply in
 * every session — even those whose cwd is outside this repo.
 */
function initDefaultAgentsMd(): void {
	const agentsMdPath = join(getAgentDir(), "AGENTS.md");
	if (existsSync(agentsMdPath)) return;
	// Don't overwrite a user's CLAUDE.md either; resource-loader uses whichever
	// is present in the directory, so creating AGENTS.md alongside a CLAUDE.md
	// would silently shadow it.
	const claudeMdPath = join(getAgentDir(), "CLAUDE.md");
	if (existsSync(claudeMdPath)) return;

	const sourcePath = resolveGlobalAgentsMdSource();
	if (!sourcePath) return;

	try {
		const content = readFileSync(sourcePath, "utf-8");
		mkdirSync(dirname(agentsMdPath), { recursive: true });
		writeFileSync(agentsMdPath, content);
	} catch {
		// Best effort: a missing AGENTS.md is fine, resource-loader tolerates it.
	}
}

/**
 * Create ~/.free-code/agent/FREE_CODE.md by copying the repo/package FREE_CODE.md if
 * it doesn't exist yet.
 *
 * The resource loader looks for FREE_CODE.md (highest priority), EDO.md (legacy),
 * CLAUDE.md, and AGENT.md in the agent dir and in every ancestor of the cwd; whatever is found is injected
 * into the system prompt as project context. Copying the repo's FREE_CODE.md into the
 * global agent dir means the same rules apply in every session — even those whose
 * cwd is outside this repo.
 */
function initDefaultFreeCodeMd(): void {
	const freeCodeMdPath = join(getAgentDir(), "FREE_CODE.md");
	if (existsSync(freeCodeMdPath)) return;

	const legacyEdoMdPath = join(getAgentDir(), "EDO.md");
	if (existsSync(legacyEdoMdPath)) {
		try {
			renameSync(legacyEdoMdPath, freeCodeMdPath);
			return;
		} catch {
			// If rename fails, fall through and try to seed the canonical file.
		}
	}

	const sourcePath = resolveGlobalFreeCodeMdSource();
	if (!sourcePath) return;

	try {
		const content = readFileSync(sourcePath, "utf-8");
		mkdirSync(dirname(freeCodeMdPath), { recursive: true });
		writeFileSync(freeCodeMdPath, content);
	} catch {
		// Best effort: a missing FREE_CODE.md is fine, resource-loader tolerates it.
	}
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string = process.cwd()): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	syncBundledThemesFromPackage();
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	syncDefaultExtensions();
	syncDefaultSkills();
	initDefaultSettings();
	initDefaultModelsJson();
	initDefaultFreeCodeMd();
	initDefaultAgentsMd();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
