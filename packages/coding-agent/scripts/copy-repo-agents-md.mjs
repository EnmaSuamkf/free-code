/**
 * Copy the monorepo root FREE_CODE.md into the coding-agent package root so it
 * ships with `npm install -g ./packages/coding-agent` and `npm pack`.
 *
 * Generic agent rules live in `packages/coding-agent/AGENTS.md` (committed here,
 * not copied from the monorepo root). `src/migrations.ts` seeds that file into
 * `~/.free-code/agent/AGENTS.md` on first startup.
 *
 * Runs during `build` (for local installs) and `prepack` (for tarballs/publish).
 * Failing silently when the source is absent is intentional: consumers who
 * install from an npm tarball already have these files in the package root.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const packageDir = process.cwd();
const monorepoRoot = resolve(packageDir, "..", "..");

const filesToCopy = [
	{ source: "FREE_CODE.md", dest: "FREE_CODE.md" },
	{ source: "EDO.md", dest: "FREE_CODE.md" },
];

for (const { source, dest } of filesToCopy) {
	const sourcePath = resolve(monorepoRoot, source);
	const destPath = join(packageDir, dest);

	if (!existsSync(sourcePath)) {
		continue;
	}
	if (source === "EDO.md" && existsSync(destPath)) {
		continue;
	}

	try {
		copyFileSync(sourcePath, destPath);
	} catch (err) {
		console.warn(
			`copy-repo-agents-md: failed to copy ${source}: ${err instanceof Error ? err.message : err}`,
		);
	}
}
