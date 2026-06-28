import ts from "typescript";
import { resolveImportPath } from "./alias-resolver.js";
import type { AliasEntry, EdgeKind, SymbolKind } from "./types.js";

export interface RawSymbol {
	kind: SymbolKind;
	name: string;
	qualifiedName: string;
	startLine: number;
	endLine: number;
	startCol: number;
}

export interface RawEdge {
	fromScope: string | null;
	toName: string;
	kind: EdgeKind;
}

export interface ExtractionResult {
	symbols: RawSymbol[];
	edges: RawEdge[];
}

function lineOf(source: ts.SourceFile, pos: number): number {
	return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function colOf(source: ts.SourceFile, pos: number): number {
	return source.getLineAndCharacterOfPosition(pos).character;
}

export function extractFromSource(source: ts.SourceFile, aliases: AliasEntry[], rootDir: string): ExtractionResult {
	const symbols: RawSymbol[] = [];
	const edges: RawEdge[] = [];
	const scopeStack: string[] = [];

	function currentScope(): string | null {
		return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1]! : null;
	}

	function addSymbol(kind: SymbolKind, name: string, qualifiedName: string, node: ts.Node): void {
		const start = node.getStart(source);
		symbols.push({
			kind,
			name,
			qualifiedName,
			startLine: lineOf(source, start),
			endLine: lineOf(source, node.getEnd()),
			startCol: colOf(source, start),
		});
	}

	function inferArrowName(node: ts.ArrowFunction | ts.FunctionExpression): string {
		const parent = node.parent;
		if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
			return parent.name.text;
		}
		if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
			return parent.name.text;
		}
		return "<anonymous>";
	}

	function visit(node: ts.Node): void {
		// --- Symbol extraction ---

		if (ts.isFunctionDeclaration(node) && node.name) {
			const name = node.name.text;
			addSymbol("function", name, name, node);
			scopeStack.push(name);
			ts.forEachChild(node, visit);
			scopeStack.pop();
			return;
		}

		if (ts.isClassDeclaration(node) && node.name) {
			const name = node.name.text;
			addSymbol("class", name, name, node);
			scopeStack.push(name);
			ts.forEachChild(node, visit);
			scopeStack.pop();
			return;
		}

		if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
			const methodName = node.name.text;
			const parent = currentScope();
			const qualifiedName = parent ? `${parent}.${methodName}` : methodName;
			addSymbol("method", methodName, qualifiedName, node);
			scopeStack.push(qualifiedName);
			ts.forEachChild(node, visit);
			scopeStack.pop();
			return;
		}

		if (ts.isInterfaceDeclaration(node)) {
			addSymbol("interface", node.name.text, node.name.text, node);
			// interfaces have no runtime scope; still visit for nested types
			ts.forEachChild(node, visit);
			return;
		}

		if (ts.isTypeAliasDeclaration(node)) {
			addSymbol("type", node.name.text, node.name.text, node);
			return;
		}

		if (ts.isEnumDeclaration(node)) {
			addSymbol("enum", node.name.text, node.name.text, node);
			return;
		}

		if (ts.isVariableStatement(node)) {
			const isTopLevel = node.parent.kind === ts.SyntaxKind.SourceFile;
			if (isTopLevel) {
				for (const decl of node.declarationList.declarations) {
					if (!ts.isIdentifier(decl.name)) continue;
					const varName = decl.name.text;
					const isFuncLike =
						decl.initializer &&
						(ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
					addSymbol(isFuncLike ? "function" : "variable", varName, varName, decl);
				}
			}
			// Fall through to default visit so arrow/function expressions inside get scope-pushed
			ts.forEachChild(node, visit);
			return;
		}

		// ArrowFunction / FunctionExpression: push inferred scope for call attribution
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
			const name = inferArrowName(node);
			scopeStack.push(name);
			ts.forEachChild(node, visit);
			scopeStack.pop();
			return;
		}

		// --- Edge extraction ---

		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			let calleeName: string | null = null;
			if (ts.isIdentifier(callee)) {
				calleeName = callee.text;
			} else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
				calleeName = callee.name.text;
			}
			if (calleeName) {
				edges.push({ fromScope: currentScope(), toName: calleeName, kind: "CALLS" });
			}
			// Continue traversal: nested calls (e.g. foo(bar())) need their own edges
			ts.forEachChild(node, visit);
			return;
		}

		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const raw = node.moduleSpecifier.text;
			const resolved = resolveImportPath(raw, aliases, rootDir);
			edges.push({ fromScope: null, toName: resolved, kind: "IMPORTS" });
			return;
		}

		ts.forEachChild(node, visit);
	}

	visit(source);
	return { symbols, edges };
}
