import type { ExtensionAPI } from "@free/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SKIP_DIRS = new Set([
	"node_modules", ".git", "dist", "dist-chrome", "dist-firefox",
	".code-graph", ".next", ".nuxt", "build", "out", "coverage",
	".cache", "__pycache__",
]);

const INDEXED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function findNewerFiles(dir: string, since: number, limit: number): string[] {
	const results: string[] = [];
	function walk(current: string) {
		if (results.length >= limit) return;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (results.length >= limit) return;
			if (entry.isSymbolicLink()) continue;
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
			} else if (entry.isFile() && INDEXED_EXTS.has(extname(entry.name))) {
				try {
					const mtime = statSync(fullPath).mtimeMs;
					if (mtime > since + 1500) results.push(fullPath);
				} catch {
					// ignore unreadable files
				}
			}
		}
	}
	walk(dir);
	return results;
}

export default function (pi: ExtensionAPI) {
	let startupHandled = false;

	pi.on("session_resources_ready", async (event, ctx) => {
		if (event.reason === "reload") startupHandled = false;
		if (startupHandled) return;
		if (event.reason !== "startup") return;
		startupHandled = true;

		const metaPath = join(ctx.cwd, ".code-graph", "meta.json");
		if (!existsSync(metaPath)) return;

		let savedAt: number;
		try {
			const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { savedAt?: number };
			if (typeof meta.savedAt !== "number") return;
			savedAt = meta.savedAt;
		} catch {
			return;
		}

		const newerFiles = findNewerFiles(ctx.cwd, savedAt, 50);
		if (newerFiles.length === 0) return;

		const count = newerFiles.length;
		const suffix = count >= 50 ? "+" : "";
		const warning =
			`Code graph index is stale: ${count}${suffix} file(s) modified since last index. ` +
			`Re-indexing in background…`;

		ctx.ui.notify(warning, "warning");
		ctx.ui.setStatus("code-graph-index", "⟳ Indexing…");

		pi.sendMessage(
			{
				customType: "code-graph-stale",
				content: `⚠️ ${warning}`,
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);

		const ui = ctx.ui;
		const cwd = ctx.cwd;

		(async () => {
			try {
				const cg = await import("@free/code-graph");
				const store = new cg.CodeGraphStore();
				const graphDir = join(cwd, ".code-graph");
				store.load(graphDir);
				const indexer = new cg.CodeGraphIndexer(cwd, store);
				const stats = await indexer.indexProject({ force: false });

				ui.setStatus("code-graph-index", undefined);
				ui.notify(
					`Code graph updated: ${stats.filesIndexed} file(s) re-indexed in ${stats.durationMs}ms`,
					"info",
				);
			} catch (err) {
				ui.setStatus("code-graph-index", undefined);
				const msg = err instanceof Error ? err.message : String(err);
				ui.notify(`Code graph background indexing failed: ${msg}`, "error");
			}
		})();
	});
}
