/**
 * Copy default-extensions/ and skills/ into dist/ for the packaged CLI.
 * Skips .git, node_modules, and .DS_Store so local clones/symlinks under
 * default-extensions/browser do not break the build (EACCES on pack files, etc.).
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const DEST_ROOT = process.env.COPY_BUNDLED_DEST ?? "dist";
const DIRS = ["default-extensions", "skills"];

function shouldCopyPath(sourceDir, srcAbsolute) {
	const rel = relative(sourceDir, srcAbsolute);
	if (!rel || rel === ".") return true;
	const segments = rel.split(sep);
	if (segments.includes(".git")) return false;
	if (segments.includes("node_modules")) return false;
	if (segments.some((s) => s === ".DS_Store")) return false;
	return true;
}

const cwd = process.cwd();
mkdirSync(join(cwd, DEST_ROOT), { recursive: true });

for (const name of DIRS) {
	const sourceDir = join(cwd, name);
	if (!existsSync(sourceDir)) continue;
	const destDir = join(cwd, DEST_ROOT, name);
	cpSync(sourceDir, destDir, {
		recursive: true,
		force: true,
		filter: (src) => shouldCopyPath(sourceDir, src),
	});
}
