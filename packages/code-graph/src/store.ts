import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EdgeInfo, FileInfo, SymbolInfo, SymbolKind } from "./types.js";

export class CodeGraphStore {
	private files: FileInfo[] = [];
	private filesById = new Map<number, FileInfo>();
	private filesByPath = new Map<string, FileInfo>();

	private symbols: SymbolInfo[] = [];
	private symbolsById = new Map<number, SymbolInfo>();
	private symbolsByFile = new Map<number, SymbolInfo[]>();

	private edges: EdgeInfo[] = [];
	private edgesByToName = new Map<string, EdgeInfo[]>();
	private edgesByFromId = new Map<number, EdgeInfo[]>();

	private nextFileId = 1;
	private nextSymbolId = 1;

	load(graphDir: string): void {
		try {
			this.files = JSON.parse(readFileSync(join(graphDir, "files.json"), "utf-8")) as FileInfo[];
			this.symbols = JSON.parse(readFileSync(join(graphDir, "symbols.json"), "utf-8")) as SymbolInfo[];
			this.edges = JSON.parse(readFileSync(join(graphDir, "edges.json"), "utf-8")) as EdgeInfo[];
		} catch {
			this.files = [];
			this.symbols = [];
			this.edges = [];
		}
		this.rebuildIndexes();
	}

	save(graphDir: string): void {
		mkdirSync(graphDir, { recursive: true });
		const meta = { version: 1, savedAt: Date.now() };
		writeFileSync(join(graphDir, "meta.json"), JSON.stringify(meta));
		writeFileSync(join(graphDir, "files.json"), JSON.stringify(this.files));
		writeFileSync(join(graphDir, "symbols.json"), JSON.stringify(this.symbols));
		writeFileSync(join(graphDir, "edges.json"), JSON.stringify(this.edges));
	}

	private rebuildIndexes(): void {
		this.filesById.clear();
		this.filesByPath.clear();
		this.symbolsById.clear();
		this.symbolsByFile.clear();
		this.edgesByToName.clear();
		this.edgesByFromId.clear();
		this.nextFileId = 1;
		this.nextSymbolId = 1;

		for (const f of this.files) {
			this.filesById.set(f.id, f);
			this.filesByPath.set(f.path, f);
			if (f.id >= this.nextFileId) this.nextFileId = f.id + 1;
		}

		for (const s of this.symbols) {
			this.symbolsById.set(s.id, s);
			if (!this.symbolsByFile.has(s.fileId)) this.symbolsByFile.set(s.fileId, []);
			this.symbolsByFile.get(s.fileId)!.push(s);
			if (s.id >= this.nextSymbolId) this.nextSymbolId = s.id + 1;
		}

		for (const e of this.edges) {
			const key = e.toName.toLowerCase();
			if (!this.edgesByToName.has(key)) this.edgesByToName.set(key, []);
			this.edgesByToName.get(key)!.push(e);

			if (e.fromId !== undefined) {
				if (!this.edgesByFromId.has(e.fromId)) this.edgesByFromId.set(e.fromId, []);
				this.edgesByFromId.get(e.fromId)!.push(e);
			}
		}
	}

	upsertFile(path: string, hash: string, mtime: number): number {
		const existing = this.filesByPath.get(path);
		if (existing) {
			existing.hash = hash;
			existing.mtime = mtime;
			return existing.id;
		}
		const id = this.nextFileId++;
		const file: FileInfo = { id, path, hash, mtime };
		this.files.push(file);
		this.filesById.set(id, file);
		this.filesByPath.set(path, file);
		return id;
	}

	deleteFileData(fileId: number): void {
		const fileSymbolIds = new Set((this.symbolsByFile.get(fileId) ?? []).map((s) => s.id));

		this.symbols = this.symbols.filter((s) => s.fileId !== fileId);
		this.edges = this.edges.filter((e) => e.fileId !== fileId && !fileSymbolIds.has(e.fromId ?? -1));
		this.rebuildIndexes();
	}

	insertSymbol(sym: Omit<SymbolInfo, "id">): number {
		const id = this.nextSymbolId++;
		const symbol: SymbolInfo = { ...sym, id };
		this.symbols.push(symbol);

		this.symbolsById.set(id, symbol);
		if (!this.symbolsByFile.has(symbol.fileId)) this.symbolsByFile.set(symbol.fileId, []);
		this.symbolsByFile.get(symbol.fileId)!.push(symbol);

		return id;
	}

	insertEdge(edge: EdgeInfo): void {
		this.edges.push(edge);

		const key = edge.toName.toLowerCase();
		if (!this.edgesByToName.has(key)) this.edgesByToName.set(key, []);
		this.edgesByToName.get(key)!.push(edge);

		if (edge.fromId !== undefined) {
			if (!this.edgesByFromId.has(edge.fromId)) this.edgesByFromId.set(edge.fromId, []);
			this.edgesByFromId.get(edge.fromId)!.push(edge);
		}
	}

	getFileHash(path: string): { hash: string; mtime: number } | undefined {
		const f = this.filesByPath.get(path);
		return f ? { hash: f.hash, mtime: f.mtime } : undefined;
	}

	getFileById(id: number): FileInfo | undefined {
		return this.filesById.get(id);
	}

	getSymbolById(id: number): SymbolInfo | undefined {
		return this.symbolsById.get(id);
	}

	getSymbolsByFile(fileId: number): SymbolInfo[] {
		return this.symbolsByFile.get(fileId) ?? [];
	}

	getEdgesByFromId(fromId: number): EdgeInfo[] {
		return (this.edgesByFromId.get(fromId) ?? []).filter((e) => e.kind === "CALLS");
	}

	getCallerEdges(name: string): Array<{ caller: SymbolInfo | undefined; edge: EdgeInfo }> {
		const key = name.toLowerCase();
		const edges = this.edgesByToName.get(key) ?? [];
		return edges
			.filter((e) => e.kind === "CALLS")
			.map((e) => ({
				caller: e.fromId !== undefined ? this.symbolsById.get(e.fromId) : undefined,
				edge: e,
			}));
	}

	searchSymbols(query: string, kind?: SymbolKind, limit = 50): SymbolInfo[] {
		const lower = query.toLowerCase();
		const results: SymbolInfo[] = [];
		for (const sym of this.symbols) {
			if (
				(sym.name.toLowerCase().includes(lower) || sym.qualifiedName.toLowerCase().includes(lower)) &&
				(!kind || sym.kind === kind)
			) {
				results.push(sym);
				if (results.length >= limit) break;
			}
		}
		return results;
	}

	getStats(): { files: number; symbols: number; edges: number } {
		return { files: this.files.length, symbols: this.symbols.length, edges: this.edges.length };
	}

	clear(): void {
		this.files = [];
		this.symbols = [];
		this.edges = [];
		this.rebuildIndexes();
	}
}
