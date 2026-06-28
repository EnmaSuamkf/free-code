export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "variable" | "enum";
export type EdgeKind = "CALLS" | "IMPORTS";

export interface AliasEntry {
	prefix: string;
	replacement: string;
}

export interface FileInfo {
	id: number;
	path: string;
	hash: string;
	mtime: number;
}

export interface SymbolInfo {
	id: number;
	fileId: number;
	filePath: string;
	kind: SymbolKind;
	name: string;
	qualifiedName: string;
	startLine: number;
	endLine: number;
	startCol: number;
}

export interface EdgeInfo {
	fromId?: number;
	toName: string;
	kind: EdgeKind;
	fileId: number;
}

export interface IndexStats {
	filesIndexed: number;
	filesSkipped: number;
	symbolsTotal: number;
	edgesTotal: number;
	durationMs: number;
}
