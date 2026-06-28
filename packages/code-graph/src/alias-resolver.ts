import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AliasEntry } from "./types.js";

function readJsonSafe(filePath: string): unknown {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return undefined;
	}
}

function entriesFromPaths(paths: Record<string, string[]>, _rootDir: string): AliasEntry[] {
	const entries: AliasEntry[] = [];
	for (const [pattern, targets] of Object.entries(paths)) {
		const target = targets[0];
		if (!target) continue;
		// "@/*": ["./src/*"]  →  prefix "@/", replacement "src/"
		const prefix = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
		const replacement = target.replace(/^\.\//, "").replace(/\/\*$/, "");
		entries.push({ prefix, replacement });
	}
	return entries;
}

function extractBabelAliases(config: unknown, _rootDir: string): AliasEntry[] {
	if (!config || typeof config !== "object") return [];
	const obj = config as Record<string, unknown>;

	const plugins = (obj.plugins as unknown[]) ?? [];
	for (const plugin of plugins) {
		if (!Array.isArray(plugin)) continue;
		const [name, options] = plugin as [unknown, unknown];
		if (name !== "module-resolver") continue;
		if (!options || typeof options !== "object") continue;

		const alias = (options as Record<string, unknown>).alias;
		if (!alias || typeof alias !== "object") continue;

		const entries: AliasEntry[] = [];
		for (const [pattern, target] of Object.entries(alias as Record<string, string>)) {
			// Regex pattern: "^@/(.*)" → "./src/$1"
			// Extract literal prefix by taking text before first special regex char
			const prefixMatch = pattern.match(/^\^?([^()*+?[\]\\^$|]+)/);
			const prefix = prefixMatch ? prefixMatch[1] : pattern;

			// Extract replacement base by removing capture group references ($1, etc.)
			const replacement = (target as string)
				.replace(/^\.\//, "")
				.replace(/\\\d+|\$\d+/g, "")
				.replace(/\/$/, "");

			if (prefix && replacement) entries.push({ prefix, replacement });
		}
		return entries;
	}
	return [];
}

export function loadAliases(rootDir: string): AliasEntry[] {
	const all: AliasEntry[] = [];

	// Source 1 & 3: tsconfig.json, tsconfig.*.json, jsconfig.json
	const tsconfigCandidates = ["tsconfig.json", "jsconfig.json"];
	for (const pattern of ["tsconfig.*.json"]) {
		// handled below via explicit check — kept separate for clarity
		void pattern;
	}

	for (const name of tsconfigCandidates) {
		const filePath = join(rootDir, name);
		const config = readJsonSafe(filePath) as Record<string, unknown> | undefined;
		const paths = (config?.compilerOptions as Record<string, unknown> | undefined)?.paths;
		if (paths && typeof paths === "object") {
			all.push(...entriesFromPaths(paths as Record<string, string[]>, rootDir));
		}
	}

	// Source 2: .babelrc and babel.config.json
	for (const name of [".babelrc", "babel.config.json"]) {
		const filePath = join(rootDir, name);
		if (existsSync(filePath)) {
			all.push(...extractBabelAliases(readJsonSafe(filePath), rootDir));
		}
	}

	// Deduplicate by prefix (first wins)
	const seen = new Set<string>();
	return all.filter((e) => {
		if (seen.has(e.prefix)) return false;
		seen.add(e.prefix);
		return true;
	});
}

const NODE_BUILTINS = new Set([
	"node:fs",
	"node:path",
	"node:os",
	"node:crypto",
	"node:util",
	"node:stream",
	"node:http",
	"node:https",
	"node:url",
	"node:events",
	"node:child_process",
	"node:buffer",
	"node:process",
	"node:module",
	"node:net",
	"node:tls",
]);

function isExternalModule(raw: string): boolean {
	if (raw.startsWith(".") || raw.startsWith("/")) return false;
	if (raw.startsWith("node:")) return true;
	if (NODE_BUILTINS.has(raw)) return true;
	// bare package name (no path separator until after first segment)
	const firstSlash = raw.indexOf("/");
	const firstSegment = firstSlash === -1 ? raw : raw.slice(0, firstSlash);
	// scoped packages start with @
	if (raw.startsWith("@") && firstSlash !== -1) {
		const secondSlash = raw.indexOf("/", firstSlash + 1);
		const scopedName = secondSlash === -1 ? raw : raw.slice(0, secondSlash);
		return !scopedName.includes("."); // @company/pkg → external
	}
	return !firstSegment.includes("."); // react, lodash → external
}

export function resolveImportPath(raw: string, aliases: AliasEntry[], rootDir: string): string {
	if (raw.startsWith(".") || raw.startsWith("/")) return raw;
	if (isExternalModule(raw)) return raw;

	// Sort by prefix length descending so more specific aliases win
	const sorted = [...aliases].sort((a, b) => b.prefix.length - a.prefix.length);

	for (const { prefix, replacement } of sorted) {
		if (raw === prefix || raw.startsWith(`${prefix}/`) || raw.startsWith(prefix)) {
			const rest = raw.slice(prefix.length).replace(/^\//, "");
			const resolved = rest ? `${replacement}/${rest}` : replacement;
			return resolve(rootDir, resolved);
		}
	}

	return raw;
}
