import type { ExtractionResult, RawEdge, RawSymbol } from "./extractor.js";

// Keywords that take the form `keyword (...)` — never method declarations or callees.
const JAVA_CONTROL_KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"synchronized",
	"return",
	"new",
	"else",
	"do",
	"try",
	"finally",
	"throw",
	"throws",
	"assert",
	"instanceof",
	"case",
	"super",
	"this",
]);

interface CleanState {
	inBlock: boolean;
}

/**
 * Strip line/block comments and string/char literals so brace counting and the
 * declaration regexes are not fooled by `{`, `}`, `(`, `)` inside them. String
 * literals collapse to `""` to preserve token boundaries.
 */
function cleanLine(line: string, state: CleanState): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const two = line.slice(i, i + 2);
		if (state.inBlock) {
			if (two === "*/") {
				state.inBlock = false;
				i += 2;
			} else {
				i += 1;
			}
			continue;
		}
		if (two === "/*") {
			state.inBlock = true;
			i += 2;
			continue;
		}
		if (two === "//") break; // rest of line is a comment
		const ch = line[i]!;
		if (ch === '"' || ch === "'") {
			i += 1;
			while (i < line.length) {
				if (line[i] === "\\") {
					i += 2;
					continue;
				}
				if (line[i] === ch) {
					i += 1;
					break;
				}
				i += 1;
			}
			out += '""';
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/**
 * Heuristic Java symbol/edge extractor. Brace-driven: `class`/`interface`/`enum`
 * and method declarations register a pending scope that is attached to the next
 * `{`; the matching `}` (same brace depth) finalizes its endLine.
 */
export function extractFromJava(content: string): ExtractionResult {
	const symbols: RawSymbol[] = [];
	const edges: RawEdge[] = [];
	const lines = content.split("\n");
	const state: CleanState = { inBlock: false };

	interface Frame {
		sym: RawSymbol;
		openDepth: number;
		isType: boolean;
	}
	interface Pending {
		kind: RawSymbol["kind"];
		name: string;
		startLine: number;
		startCol: number;
		isType: boolean;
	}

	const stack: Frame[] = [];
	const pending: Pending[] = []; // FIFO: declarations awaiting their opening "{"
	let braceDepth = 0;

	const enclosingType = (): Frame | null => {
		for (let k = stack.length - 1; k >= 0; k--) {
			if (stack[k]!.isType) return stack[k]!;
		}
		return null;
	};

	const typeRe = /\b(class|interface|enum)\s+([A-Za-z_]\w*)/g;
	const methodRe = /\b([A-Za-z_]\w*)\s*\([^()]*\)\s*(?:throws[\w\s,.<>]*?)?\{/g;
	const abstractMethodRe = /\b([A-Za-z_]\w*)\s*\([^()]*\)\s*(?:throws[\w\s,.<>]*?)?;/g;
	const callRe = /(?:\.|\b)([A-Za-z_]\w*)\s*\(/g;

	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const clean = cleanLine(lines[i]!, state);
		if (clean.trim() === "") continue;

		const imp = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/.exec(clean);
		if (imp) {
			edges.push({ fromScope: null, toName: imp[1]!, kind: "IMPORTS" });
			continue;
		}

		const declNames = new Set<string>();
		const linePendings: { p: Pending; index: number }[] = [];

		typeRe.lastIndex = 0;
		let tm = typeRe.exec(clean);
		while (tm !== null) {
			const kw = tm[1]!;
			const name = tm[2]!;
			const kind: RawSymbol["kind"] = kw === "class" ? "class" : kw === "interface" ? "interface" : "enum";
			declNames.add(name);
			linePendings.push({ p: { kind, name, startLine: lineNo, startCol: tm.index, isType: true }, index: tm.index });
			tm = typeRe.exec(clean);
		}

		methodRe.lastIndex = 0;
		let mm = methodRe.exec(clean);
		while (mm !== null) {
			const name = mm[1]!;
			// Skip control keywords, anonymous classes (`new Foo() {`), and methods
			// outside any type body — only real declarations become pending scopes.
			if (!JAVA_CONTROL_KEYWORDS.has(name) && !/\bnew\s+$/.test(clean.slice(0, mm.index)) && enclosingType()) {
				declNames.add(name);
				linePendings.push({
					p: { kind: "method", name, startLine: lineNo, startCol: mm.index, isType: false },
					index: mm.index,
				});
			}
			mm = methodRe.exec(clean);
		}

		// Bodyless methods (signature ends in ";"). These exist only in interfaces or
		// as `abstract` members — anywhere else a `name(...);` is a call statement, not
		// a declaration, so gate strictly to avoid matching e.g. `return compute(a, b);`.
		const et = enclosingType();
		const bodyless = et?.sym.kind === "interface" || /\babstract\b/.test(clean);
		if (bodyless && !/^\s*return\b/.test(clean)) {
			abstractMethodRe.lastIndex = 0;
			let am = abstractMethodRe.exec(clean);
			while (am !== null) {
				const name = am[1]!;
				const isCall = am.index > 0 && clean[am.index - 1] === "."; // x.foo(); is a call
				if (et && !JAVA_CONTROL_KEYWORDS.has(name) && !isCall) {
					declNames.add(name);
					const qualifiedName = `${et.sym.qualifiedName}.${name}`;
					symbols.push({
						kind: "method",
						name,
						qualifiedName,
						startLine: lineNo,
						endLine: lineNo,
						startCol: am.index,
					});
				}
				am = abstractMethodRe.exec(clean);
			}
		}

		linePendings.sort((a, b) => a.index - b.index);

		// Call edges, attributed to the current innermost scope.
		callRe.lastIndex = 0;
		const callScope = stack.length > 0 ? stack[stack.length - 1]!.sym.qualifiedName : null;
		let cm = callRe.exec(clean);
		while (cm !== null) {
			const name = cm[1]!;
			// Skip keywords and the symbol's own declaration appearing on this line.
			if (!JAVA_CONTROL_KEYWORDS.has(name) && !declNames.has(name)) {
				edges.push({ fromScope: callScope, toName: name, kind: "CALLS" });
			}
			cm = callRe.exec(clean);
		}

		// Scan braces, attaching queued declarations and closing finished scopes.
		let li = 0;
		for (let c = 0; c < clean.length; c++) {
			const ch = clean[c]!;
			if (ch === "{") {
				braceDepth += 1;
				// Prefer a declaration from this line that appears before this brace.
				while (li < linePendings.length && linePendings[li]!.index < c) {
					pending.push(linePendings[li]!.p);
					li += 1;
				}
				const p = pending.shift();
				if (p) {
					let qualifiedName = p.name;
					if (p.kind === "method") {
						const et = enclosingType();
						qualifiedName = et ? `${et.sym.qualifiedName}.${p.name}` : p.name;
					} else {
						const parentType = enclosingType();
						qualifiedName = parentType ? `${parentType.sym.qualifiedName}.${p.name}` : p.name;
					}
					const sym: RawSymbol = {
						kind: p.kind,
						name: p.name,
						qualifiedName,
						startLine: p.startLine,
						endLine: lineNo,
						startCol: p.startCol,
					};
					symbols.push(sym);
					stack.push({ sym, openDepth: braceDepth, isType: p.isType });
				}
			} else if (ch === "}") {
				while (stack.length > 0 && stack[stack.length - 1]!.openDepth === braceDepth) {
					stack.pop()!.sym.endLine = lineNo;
				}
				braceDepth = Math.max(0, braceDepth - 1);
			}
		}

		// Any declarations not yet consumed (brace on a later line) stay queued.
		while (li < linePendings.length) {
			pending.push(linePendings[li]!.p);
			li += 1;
		}
	}

	const lastLine = lines.length;
	while (stack.length > 0) stack.pop()!.sym.endLine = lastLine;

	return { symbols, edges };
}
