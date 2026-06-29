import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { CodeGraphStore } from "./store.js";
import type { SymbolInfo, SymbolKind } from "./types.js";

function relPath(filePath: string, rootDir?: string): string {
	return rootDir ? relative(rootDir, filePath) : filePath;
}

/** Markdown code-fence language for a source file. */
function fenceLang(filePath: string): string {
	if (filePath.endsWith(".py")) return "python";
	if (filePath.endsWith(".java")) return "java";
	if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
	return "javascript";
}

export function querySymbols(store: CodeGraphStore, query: string, kind?: SymbolKind, limit = 50): string {
	const results = store.searchSymbols(query, kind, limit);
	if (results.length === 0) return `No symbols found matching "${query}"${kind ? ` (kind: ${kind})` : ""}.`;

	const rows = results.map((s) => `| \`${s.qualifiedName}\` | ${s.kind} | ${s.filePath}:${s.startLine} |`);
	return [
		`**${results.length} symbol(s) matching "${query}":**\n`,
		"| Symbol | Kind | Location |",
		"|--------|------|----------|",
		...rows,
	].join("\n");
}

export function queryCallers(store: CodeGraphStore, name: string, limit = 50): string {
	const callerEdges = store.getCallerEdges(name).slice(0, limit);
	if (callerEdges.length === 0) {
		return `No callers found for \`${name}\`. Note: results are text-based — if the function was recently indexed under a different name, try re-indexing.`;
	}

	const lines = callerEdges.map(({ caller, edge }) => {
		if (caller) {
			return `- \`${caller.qualifiedName}\` (${caller.kind}) — ${caller.filePath}:${caller.startLine}`;
		}
		const fileInfo = store.getFileById(edge.fileId);
		return `- (module top-level) — ${fileInfo?.path ?? "unknown"}`;
	});

	return [
		`**Callers of \`${name}\`** (text-based match — may include false positives for common names like \`save\`, \`init\`, \`render\`):\n`,
		...lines,
	].join("\n");
}

export function queryContext(store: CodeGraphStore, name: string, file?: string, rootDir?: string): string {
	let results = store.searchSymbols(name, undefined, 10);

	if (file) {
		const filtered = results.filter((s) => s.filePath.includes(file));
		if (filtered.length > 0) results = filtered;
	}

	if (results.length === 0) return `No symbol found matching "${name}".`;

	if (results.length > 3) {
		const list = results
			.slice(0, 5)
			.map((s) => `- \`${s.qualifiedName}\` (${s.kind}) — ${relPath(s.filePath, rootDir)}:${s.startLine}`)
			.join("\n");
		return `Multiple symbols match "${name}". Provide a \`file\` argument to narrow down:\n${list}`;
	}

	return results.map((sym) => renderSymbolContext(store, sym, rootDir)).join("\n\n---\n\n");
}

function renderSymbolContext(store: CodeGraphStore, sym: SymbolInfo, rootDir?: string): string {
	const fileInfo = store.getFileById(sym.fileId);

	// Stale index guard
	if (fileInfo) {
		try {
			const currentMtime = statSync(sym.filePath).mtimeMs;
			if (Math.abs(currentMtime - fileInfo.mtime) > 1500) {
				return `⚠️ File modified since last index: \`${relPath(sym.filePath, rootDir)}\`. Please run \`code_index\` again.`;
			}
		} catch {
			return `⚠️ File not found: \`${sym.filePath}\`.`;
		}
	}

	let sourceLines = "";
	try {
		const content = readFileSync(sym.filePath, "utf-8");
		const lines = content.split("\n");
		sourceLines = lines.slice(sym.startLine - 1, sym.endLine).join("\n");
	} catch {
		sourceLines = "(could not read source)";
	}

	const calleeEdges = store.getEdgesByFromId(sym.id);
	const calleeNames = [...new Set(calleeEdges.map((e) => e.toName))];
	const callsLine = calleeNames.length > 0 ? `\n\n**Calls:** ${calleeNames.join(", ")}` : "";

	const loc = `${relPath(sym.filePath, rootDir)}:${sym.startLine}-${sym.endLine}`;
	const header = `## \`${sym.qualifiedName}\` (${sym.kind}) — ${loc}`;
	const code = `\`\`\`${fenceLang(sym.filePath)}\n${sourceLines}\n\`\`\``;

	return `${header}\n\n${code}${callsLine}`;
}
