import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ignore from "ignore";
import ts from "typescript";
import { loadAliases } from "./alias-resolver.js";
import { type ExtractionResult, extractFromSource } from "./extractor.js";
import { extractFromJava } from "./java-extractor.js";
import { extractFromPython } from "./python-extractor.js";
import type { CodeGraphStore } from "./store.js";
import type { AliasEntry, IndexStats } from "./types.js";

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".java"]);

export class CodeGraphIndexer {
	constructor(
		private readonly rootDir: string,
		private readonly store: CodeGraphStore,
	) {}

	async indexProject(options?: { force?: boolean }): Promise<IndexStats> {
		const startMs = Date.now();
		const aliases = loadAliases(this.rootDir);
		const ig = this.buildIgnore();
		const files = this.walkFiles(ig);

		let filesIndexed = 0;
		let filesSkipped = 0;

		for (const filePath of files) {
			const content = readFileSync(filePath, "utf-8");
			const hash = createHash("sha1").update(content).digest("hex");

			if (!options?.force) {
				const existing = this.store.getFileHash(filePath);
				if (existing?.hash === hash) {
					filesSkipped++;
					continue;
				}
			}

			const mtime = statSync(filePath).mtimeMs;
			this.indexFile(filePath, aliases, content, hash, mtime);
			filesIndexed++;
		}

		const graphDir = join(this.rootDir, ".code-graph");
		this.store.save(graphDir);

		const stats = this.store.getStats();
		return {
			filesIndexed,
			filesSkipped,
			symbolsTotal: stats.symbols,
			edgesTotal: stats.edges,
			durationMs: Date.now() - startMs,
		};
	}

	indexFile(filePath: string, aliases: AliasEntry[], content?: string, hash?: string, mtime?: number): void {
		const src = content ?? readFileSync(filePath, "utf-8");
		const h = hash ?? createHash("sha1").update(src).digest("hex");
		const mt = mtime ?? statSync(filePath).mtimeMs;

		const { symbols, edges } = this.extract(filePath, src, aliases);

		const fileId = this.store.upsertFile(filePath, h, mt);
		this.store.deleteFileData(fileId);

		// Build a local name→id map for resolving CALLS fromScope within this file
		const scopeToId = new Map<string, number>();
		for (const sym of symbols) {
			const id = this.store.insertSymbol({
				fileId,
				filePath,
				kind: sym.kind,
				name: sym.name,
				qualifiedName: sym.qualifiedName,
				startLine: sym.startLine,
				endLine: sym.endLine,
				startCol: sym.startCol,
			});
			scopeToId.set(sym.qualifiedName, id);
			// Also index by simple name so scope "foo" resolves even without qualifier
			if (!scopeToId.has(sym.name)) scopeToId.set(sym.name, id);
		}

		for (const edge of edges) {
			const fromId = edge.fromScope ? (scopeToId.get(edge.fromScope) ?? undefined) : undefined;
			this.store.insertEdge({ fromId, toName: edge.toName, kind: edge.kind, fileId });
		}
	}

	private extract(filePath: string, src: string, aliases: AliasEntry[]): ExtractionResult {
		const ext = extname(filePath).toLowerCase();
		if (ext === ".py") return extractFromPython(src);
		if (ext === ".java") return extractFromJava(src);
		const source = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, /* setParentNodes */ true);
		return extractFromSource(source, aliases, this.rootDir);
	}

	private buildIgnore() {
		const ig = ignore();
		try {
			const gitignore = readFileSync(join(this.rootDir, ".gitignore"), "utf-8");
			ig.add(gitignore);
		} catch {
			// no .gitignore
		}
		ig.add(["node_modules", ".git", "dist", "build", ".code-graph", "*.d.ts", "*.min.js"]);
		return ig;
	}

	private walkFiles(ig: ReturnType<typeof ignore>): string[] {
		const results: string[] = [];

		const walk = (dir: string) => {
			try {
				const entries = readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					// Skip symlinks to avoid infinite loops (pnpm, etc.)
					if (entry.isSymbolicLink()) continue;

					const fullPath = join(dir, entry.name);
					const relPath = relative(this.rootDir, fullPath);

					if (ig.ignores(relPath)) continue;

					if (entry.isDirectory()) {
						walk(fullPath);
					} else if (entry.isFile() && SUPPORTED_EXTS.has(extname(entry.name))) {
						results.push(fullPath);
					}
				}
			} catch {
				return;
			}
		};

		walk(this.rootDir);
		return results;
	}
}
