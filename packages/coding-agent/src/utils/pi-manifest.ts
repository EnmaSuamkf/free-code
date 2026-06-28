import { APP_NAME } from "../config.js";

/** Resource manifest in extension `package.json` under the app key (legacy: `pi`). */
export type PiManifest = {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
	agents?: string[];
};

/**
 * Read the Pi resource manifest from a parsed package.json object.
 * Prefers `pkg[APP_NAME]` and falls back to `pkg.pi` for compatibility.
 */
export function getPiManifestFromPackageJson(pkg: unknown): PiManifest | null {
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
		return null;
	}
	const record = pkg as Record<string, unknown>;
	const primary = record[APP_NAME];
	const legacy = record.pi;
	const raw =
		primary && typeof primary === "object" && primary !== null && !Array.isArray(primary)
			? primary
			: legacy && typeof legacy === "object" && legacy !== null && !Array.isArray(legacy)
				? legacy
				: null;
	return raw as PiManifest | null;
}
