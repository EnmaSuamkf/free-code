import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CodeGraphIndexer as CGIndexer, CodeGraphStore as CGStore, SymbolKind } from "@free/code-graph";
import type { AgentTool } from "@free/pi-agent-core";
import { Text } from "@free/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinitions } from "./tool-definition-wrapper.js";

// ---------------------------------------------------------------------------
// Lazy module loader — gracefully fails if @free/code-graph is not installed
// ---------------------------------------------------------------------------

type CodeGraphModule = typeof import("@free/code-graph");

let _cgModule: CodeGraphModule | null = null;
let _cgLoaded = false;

async function loadCodeGraph(): Promise<CodeGraphModule | null> {
	if (_cgLoaded) return _cgModule;
	_cgLoaded = true;
	try {
		_cgModule = await import("@free/code-graph");
	} catch {
		_cgModule = null;
	}
	return _cgModule;
}

const MODULE_UNAVAILABLE =
	"`@free/code-graph` module is not available. " +
	"Install it with: `npm install -g ./packages/code-graph` (from the repo root).";

// ---------------------------------------------------------------------------
// Lazy store singleton per cwd
// ---------------------------------------------------------------------------

let _storeCwd: string | null = null;
let _store: CGStore | null = null;

async function getOrLoadStore(cg: CodeGraphModule, cwd: string): Promise<CGStore | null> {
	const graphDir = join(cwd, ".code-graph");
	if (!existsSync(graphDir)) return null;

	if (_storeCwd !== cwd) {
		_store = null;
		_storeCwd = cwd;
	}

	if (!_store) {
		_store = new cg.CodeGraphStore();
		_store.load(graphDir);
	}

	return _store;
}

function invalidateStore(): void {
	_store = null;
}

const NOT_INDEXED = "Project not indexed. Use the `code_index` tool first.";

// ---------------------------------------------------------------------------
// code_index
// ---------------------------------------------------------------------------

const codeIndexSchema = Type.Object({
	force: Type.Optional(Type.Boolean({ description: "Re-index all files even if unchanged (default: false)" })),
});

export function createCodeIndexToolDefinition(cwd: string): ToolDefinition<typeof codeIndexSchema, undefined> {
	return {
		name: "code_index",
		label: "code_index",
		description:
			"Index the current project to build a code graph of symbols, calls, and imports. " +
			"Run once before using other code_* tools. Re-run with force=true after large refactors.",
		promptSnippet: "Build or update the code graph index for the project",
		parameters: codeIndexSchema,
		async execute(_id, { force }: Static<typeof codeIndexSchema>) {
			const cg = await loadCodeGraph();
			if (!cg) return { content: [{ type: "text" as const, text: MODULE_UNAVAILABLE }], details: undefined };

			invalidateStore();
			const store = new cg.CodeGraphStore();
			const graphDir = join(cwd, ".code-graph");
			store.load(graphDir);

			const indexer: CGIndexer = new cg.CodeGraphIndexer(cwd, store);
			const stats = await indexer.indexProject({ force });

			_store = store;
			_storeCwd = cwd;

			const text =
				`**Code graph indexed**\n\n` +
				`- Files indexed: ${stats.filesIndexed}\n` +
				`- Files skipped (unchanged): ${stats.filesSkipped}\n` +
				`- Symbols: ${stats.symbolsTotal}\n` +
				`- Edges (calls + imports): ${stats.edgesTotal}\n` +
				`- Duration: ${stats.durationMs}ms`;

			return { content: [{ type: "text" as const, text }], details: undefined };
		},
		renderCall(_args, theme) {
			return new Text(theme.bold("code_index"), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const output = (result as any)?.content?.[0]?.text ?? "";
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

// ---------------------------------------------------------------------------
// code_symbols
// ---------------------------------------------------------------------------

const SYMBOL_KINDS = ["function", "class", "method", "interface", "type", "variable", "enum"] as const;

const codeSymbolsSchema = Type.Object({
	query: Type.String({ description: "Symbol name or substring to search for (case-insensitive)" }),
	kind: Type.Optional(
		Type.Union(
			SYMBOL_KINDS.map((k) => Type.Literal(k)),
			{
				description: "Filter by symbol kind",
			},
		),
	),
	limit: Type.Optional(Type.Number({ description: "Max results (default: 50)" })),
});

export function createCodeSymbolsToolDefinition(cwd: string): ToolDefinition<typeof codeSymbolsSchema, undefined> {
	return {
		name: "code_symbols",
		label: "code_symbols",
		description:
			"Search for symbols (functions, classes, methods, types, etc.) in the indexed codebase by name. " +
			"Returns file locations. Run code_index first.",
		promptSnippet: "Find symbols by name in the code graph",
		parameters: codeSymbolsSchema,
		async execute(_id, { query, kind, limit }: Static<typeof codeSymbolsSchema>) {
			const cg = await loadCodeGraph();
			if (!cg) return { content: [{ type: "text" as const, text: MODULE_UNAVAILABLE }], details: undefined };

			const store = await getOrLoadStore(cg, cwd);
			if (!store) return { content: [{ type: "text" as const, text: NOT_INDEXED }], details: undefined };

			const text = cg.querySymbols(store, query, kind as SymbolKind | undefined, limit);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
		renderCall(args, theme) {
			const q = (args as any)?.query ?? "";
			return new Text(`${theme.bold("code_symbols")} ${theme.fg("accent", q)}`, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const output = (result as any)?.content?.[0]?.text ?? "";
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

// ---------------------------------------------------------------------------
// code_callers
// ---------------------------------------------------------------------------

const codeCallersSchema = Type.Object({
	name: Type.String({
		description:
			"Function or method name to find callers of. " +
			"Uses text-based matching — common names like save, init, render may return false positives from unrelated classes. " +
			"Use code_context to verify the caller before trusting results.",
	}),
	limit: Type.Optional(Type.Number({ description: "Max results (default: 50)" })),
});

export function createCodeCallersToolDefinition(cwd: string): ToolDefinition<typeof codeCallersSchema, undefined> {
	return {
		name: "code_callers",
		label: "code_callers",
		description:
			"Find all code locations that call a given function or method by name. " +
			"Text-based: expects false positives for overloaded names like save() or render(). " +
			"Run code_index first.",
		promptSnippet: "Find who calls a function in the code graph",
		parameters: codeCallersSchema,
		async execute(_id, { name, limit }: Static<typeof codeCallersSchema>) {
			const cg = await loadCodeGraph();
			if (!cg) return { content: [{ type: "text" as const, text: MODULE_UNAVAILABLE }], details: undefined };

			const store = await getOrLoadStore(cg, cwd);
			if (!store) return { content: [{ type: "text" as const, text: NOT_INDEXED }], details: undefined };

			const text = cg.queryCallers(store, name, limit);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
		renderCall(args, theme) {
			const n = (args as any)?.name ?? "";
			return new Text(`${theme.bold("code_callers")} ${theme.fg("accent", n)}`, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const output = (result as any)?.content?.[0]?.text ?? "";
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

// ---------------------------------------------------------------------------
// code_context
// ---------------------------------------------------------------------------

const codeContextSchema = Type.Object({
	name: Type.String({ description: "Symbol name (function, class, method, etc.) to retrieve source for" }),
	file: Type.Optional(
		Type.String({ description: "Partial file path to disambiguate when multiple symbols share the same name" }),
	),
});

export function createCodeContextToolDefinition(cwd: string): ToolDefinition<typeof codeContextSchema, undefined> {
	return {
		name: "code_context",
		label: "code_context",
		description:
			"Get the full source code of a symbol plus its direct callees. " +
			"Validates that the file has not changed since indexing — if it has, prompts to re-run code_index. " +
			"Run code_index first.",
		promptSnippet: "Get source and callees of a symbol from the code graph",
		parameters: codeContextSchema,
		async execute(_id, { name, file }: Static<typeof codeContextSchema>) {
			const cg = await loadCodeGraph();
			if (!cg) return { content: [{ type: "text" as const, text: MODULE_UNAVAILABLE }], details: undefined };

			const store = await getOrLoadStore(cg, cwd);
			if (!store) return { content: [{ type: "text" as const, text: NOT_INDEXED }], details: undefined };

			const text = cg.queryContext(store, name, file, cwd);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
		renderCall(args, theme) {
			const n = (args as any)?.name ?? "";
			return new Text(`${theme.bold("code_context")} ${theme.fg("accent", n)}`, 0, 0);
		},
		renderResult(result, _opts, theme) {
			const output = (result as any)?.content?.[0]?.text ?? "";
			return new Text(theme.fg("toolOutput", output), 0, 0);
		},
	};
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createCodeGraphToolDefinitions(cwd: string): ToolDefinition<any, any>[] {
	return [
		createCodeIndexToolDefinition(cwd),
		createCodeSymbolsToolDefinition(cwd),
		createCodeCallersToolDefinition(cwd),
		createCodeContextToolDefinition(cwd),
	];
}

export function createCodeGraphTools(cwd: string): AgentTool<any>[] {
	return wrapToolDefinitions(createCodeGraphToolDefinitions(cwd));
}
