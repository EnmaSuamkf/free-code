import type { ExtractionResult, RawEdge, RawSymbol } from "./extractor.js";

// Tokens that look like calls (`name(`) but are language keywords, not callees.
const PY_CALL_KEYWORDS = new Set([
	"if",
	"elif",
	"else",
	"while",
	"for",
	"with",
	"try",
	"except",
	"finally",
	"return",
	"and",
	"or",
	"not",
	"in",
	"is",
	"lambda",
	"assert",
	"del",
	"raise",
	"yield",
	"global",
	"nonlocal",
	"class",
	"def",
	"import",
	"from",
	"as",
	"pass",
	"break",
	"continue",
]);

/** Visual width of leading indentation; tabs count as 4 columns. */
function leadingWidth(line: string): number {
	let w = 0;
	for (const ch of line) {
		if (ch === " ") w += 1;
		else if (ch === "\t") w += 4;
		else break;
	}
	return w;
}

function extractCalls(text: string, scope: string | null, edges: RawEdge[]): void {
	// Match the identifier immediately before "(", whether bare `foo(` or `obj.foo(`.
	const re = /(?:\.|\b)([A-Za-z_]\w*)\s*\(/g;
	let m = re.exec(text);
	while (m !== null) {
		const name = m[1]!;
		if (!PY_CALL_KEYWORDS.has(name)) {
			edges.push({ fromScope: scope, toName: name, kind: "CALLS" });
		}
		m = re.exec(text);
	}
}

/**
 * Heuristic Python symbol/edge extractor. Indentation-driven: a `class`/`def`
 * owns every line indented deeper than its own declaration. Produces the same
 * shape as the TypeScript extractor so the indexer can treat all languages uniformly.
 */
export function extractFromPython(content: string): ExtractionResult {
	const symbols: RawSymbol[] = [];
	const edges: RawEdge[] = [];
	const lines = content.split("\n");

	interface Frame {
		sym: RawSymbol;
		indent: number;
		kind: "class" | "function" | "method";
	}
	const stack: Frame[] = [];
	let lastContentLine = 0;

	// Close (and finalize endLine for) every scope at least as indented as `indent`.
	const closeTo = (indent: number, endLine: number): void => {
		while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
			stack.pop()!.sym.endLine = endLine;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const lineNo = i + 1;
		const stripped = raw.trim();
		if (stripped === "") continue; // blank lines never change scope

		const indent = leadingWidth(raw);
		closeTo(indent, lastContentLine);

		if (stripped.startsWith("#")) {
			lastContentLine = lineNo;
			continue;
		}

		const parent = stack.length > 0 ? stack[stack.length - 1]! : null;

		const classMatch = /^class\s+([A-Za-z_]\w*)/.exec(stripped);
		if (classMatch) {
			const name = classMatch[1]!;
			const qualifiedName = parent ? `${parent.sym.qualifiedName}.${name}` : name;
			const sym: RawSymbol = {
				kind: "class",
				name,
				qualifiedName,
				startLine: lineNo,
				endLine: lineNo,
				startCol: indent,
			};
			symbols.push(sym);
			stack.push({ sym, indent, kind: "class" });
			lastContentLine = lineNo;
			continue;
		}

		const defMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(stripped);
		if (defMatch) {
			const name = defMatch[1]!;
			const kind: "method" | "function" = parent?.kind === "class" ? "method" : "function";
			const qualifiedName = parent ? `${parent.sym.qualifiedName}.${name}` : name;
			const sym: RawSymbol = { kind, name, qualifiedName, startLine: lineNo, endLine: lineNo, startCol: indent };
			symbols.push(sym);
			stack.push({ sym, indent, kind });
			lastContentLine = lineNo;
			continue;
		}

		const fromImport = /^from\s+([.\w]+)\s+import\b/.exec(stripped);
		if (fromImport) {
			edges.push({ fromScope: null, toName: fromImport[1]!, kind: "IMPORTS" });
			lastContentLine = lineNo;
			continue;
		}
		const plainImport = /^import\s+([.\w]+)/.exec(stripped);
		if (plainImport) {
			edges.push({ fromScope: null, toName: plainImport[1]!, kind: "IMPORTS" });
			lastContentLine = lineNo;
			continue;
		}

		// Module-level assignment → variable symbol (skip `==` comparisons).
		if (indent === 0 && stack.length === 0) {
			const varMatch = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(stripped);
			if (varMatch) {
				const name = varMatch[1]!;
				symbols.push({
					kind: "variable",
					name,
					qualifiedName: name,
					startLine: lineNo,
					endLine: lineNo,
					startCol: 0,
				});
			}
		}

		extractCalls(stripped, parent ? parent.sym.qualifiedName : null, edges);
		lastContentLine = lineNo;
	}

	closeTo(-1, lastContentLine); // finalize anything still open at EOF
	return { symbols, edges };
}
