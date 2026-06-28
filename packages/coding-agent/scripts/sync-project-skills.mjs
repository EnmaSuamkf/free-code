import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const repoRoot = join(packageDir, "..", "..");
const projectSkillsDir = join(repoRoot, ".free-code", "skills");
const packageSkillsDir = join(packageDir, "skills");

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

if (existsSync(projectSkillsDir)) {
	mkdirSync(packageSkillsDir, { recursive: true });
	for (const entry of readdirSync(projectSkillsDir, { withFileTypes: true })) {
		const source = join(projectSkillsDir, entry.name);
		const target = join(packageSkillsDir, entry.name);
		rmSync(target, { recursive: true, force: true });
		cpSync(source, target, {
			recursive: true,
			force: true,
			filter: (src) => shouldCopyPath(source, src),
		});
	}
}
