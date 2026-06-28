export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
	editToolDefinition,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
	findToolDefinition,
} from "./find.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
	grepToolDefinition,
} from "./grep.js";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
	lsToolDefinition,
} from "./ls.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
	writeToolDefinition,
} from "./write.js";

import type { AgentTool } from "@free/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import {
	type BashToolOptions,
	bashTool,
	bashToolDefinition,
	createBashTool,
	createBashToolDefinition,
} from "./bash.js";
import { createCodeGraphToolDefinitions, createCodeGraphTools } from "./code-graph-tools.js";
import { createEditTool, createEditToolDefinition, editTool, editToolDefinition } from "./edit.js";
import { createFindTool, createFindToolDefinition, findTool, findToolDefinition } from "./find.js";
import { createGrepTool, createGrepToolDefinition, grepTool, grepToolDefinition } from "./grep.js";
import { createLsTool, createLsToolDefinition, lsTool, lsToolDefinition } from "./ls.js";
import {
	createReadTool,
	createReadToolDefinition,
	type ReadToolOptions,
	readTool,
	readToolDefinition,
} from "./read.js";
import { createWriteTool, createWriteToolDefinition, writeTool, writeToolDefinition } from "./write.js";

export {
	createCodeCallersToolDefinition,
	createCodeContextToolDefinition,
	createCodeGraphToolDefinitions,
	createCodeGraphTools,
	createCodeIndexToolDefinition,
	createCodeSymbolsToolDefinition,
} from "./code-graph-tools.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;

export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];
export const readOnlyTools: Tool[] = [readTool, grepTool, findTool, lsTool];

const _defaultCodeGraphTools = createCodeGraphTools(process.cwd());
const [codeIndexTool, codeSymbolsTool, codeCallersTool, codeContextTool] = _defaultCodeGraphTools;

export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	code_index: codeIndexTool!,
	code_symbols: codeSymbolsTool!,
	code_callers: codeCallersTool!,
	code_context: codeContextTool!,
};

const _defaultCodeGraphDefs = createCodeGraphToolDefinitions(process.cwd());
const [codeIndexDef, codeSymbolsDef, codeCallersDef, codeContextDef] = _defaultCodeGraphDefs;

export const allToolDefinitions = {
	read: readToolDefinition,
	bash: bashToolDefinition,
	edit: editToolDefinition,
	write: writeToolDefinition,
	grep: grepToolDefinition,
	find: findToolDefinition,
	ls: lsToolDefinition,
	code_index: codeIndexDef!,
	code_symbols: codeSymbolsDef!,
	code_callers: codeCallersDef!,
	code_context: codeContextDef!,
};

export type ToolName = keyof typeof allTools;

/** Built-in tools enabled when the session does not override the active set (CLI, SDK, AgentSession). */
export const DEFAULT_ACTIVE_BUILTIN_TOOL_NAMES: ToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"code_index",
	"code_symbols",
	"code_callers",
	"code_context",
];

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const cgDefs = createCodeGraphToolDefinitions(cwd);
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
		code_index: cgDefs[0]!,
		code_symbols: cgDefs[1]!,
		code_callers: cgDefs[2]!,
		code_context: cgDefs[3]!,
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd),
		createWriteTool(cwd),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd, options?.read), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const cgTools = createCodeGraphTools(cwd);
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		code_index: cgTools[0]!,
		code_symbols: cgTools[1]!,
		code_callers: cgTools[2]!,
		code_context: cgTools[3]!,
	};
}
