import type { ExtensionAPI } from "@free/pi-coding-agent";

const SYMBOL_KINDS = ["function", "class", "method", "interface", "type", "variable", "enum"] as const;

function parseArgs(raw: string): { positional: string[]; flags: Record<string, string> } {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!;
		if (tok.startsWith("--")) {
			const key = tok.slice(2);
			const next = tokens[i + 1];
			if (next && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = "true";
			}
		} else {
			positional.push(tok);
		}
	}
	return { positional, flags };
}

export default function (pi: ExtensionAPI) {
	// /codeGraph-index [--force]
	pi.registerCommand("codeGraph-index", {
		description: "Index the project code graph. Use --force to re-index all files.",
		getArgumentCompletions: (prefix) => {
			const opt = "--force";
			return opt.startsWith(prefix) ? [{ value: opt, label: opt }] : null;
		},
		handler: async (args, ctx) => {
			const { flags } = parseArgs(args);
			const force = "force" in flags;
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Try again when idle.", "warning");
				return;
			}
			pi.sendUserMessage(`Run \`code_index\`${force ? " with force=true" : ""}.`);
		},
	});

	// /codeGraph-symbols <query> [--kind <kind>] [--limit <n>]
	pi.registerCommand("codeGraph-symbols", {
		description: "Search symbols by name. Usage: /codeGraph-symbols <query> [--kind function|class|...] [--limit n]",
		getArgumentCompletions: (prefix) => {
			const kindOpts = SYMBOL_KINDS.map((k) => `--kind ${k}`);
			const limitOpt = "--limit";
			const candidates = [limitOpt, ...kindOpts];
			const filtered = candidates.filter((c) => c.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const { positional, flags } = parseArgs(args);
			const query = positional.join(" ");
			if (!query) {
				ctx.ui.notify("Usage: /codeGraph-symbols <query> [--kind kind] [--limit n]", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Try again when idle.", "warning");
				return;
			}
			const kindPart = flags["kind"] ? `, kind="${flags["kind"]}"` : "";
			const limitPart = flags["limit"] ? `, limit=${flags["limit"]}` : "";
			pi.sendUserMessage(`Run \`code_symbols\` with query="${query}"${kindPart}${limitPart}.`);
		},
	});

	// /codeGraph-callers <name> [--limit <n>]
	pi.registerCommand("codeGraph-callers", {
		description: "Find all callers of a function or method. Usage: /codeGraph-callers <name> [--limit n]",
		getArgumentCompletions: (prefix) => {
			const opt = "--limit";
			return opt.startsWith(prefix) ? [{ value: opt, label: opt }] : null;
		},
		handler: async (args, ctx) => {
			const { positional, flags } = parseArgs(args);
			const name = positional.join(" ");
			if (!name) {
				ctx.ui.notify("Usage: /codeGraph-callers <name> [--limit n]", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Try again when idle.", "warning");
				return;
			}
			const limitPart = flags["limit"] ? `, limit=${flags["limit"]}` : "";
			pi.sendUserMessage(`Run \`code_callers\` with name="${name}"${limitPart}.`);
		},
	});

	// /codeGraph-context <name> [--file <partial-path>]
	pi.registerCommand("codeGraph-context", {
		description: "Get source and callees of a symbol. Usage: /codeGraph-context <name> [--file <partial-path>]",
		getArgumentCompletions: (prefix) => {
			const opt = "--file";
			return opt.startsWith(prefix) ? [{ value: opt, label: opt }] : null;
		},
		handler: async (args, ctx) => {
			const { positional, flags } = parseArgs(args);
			const name = positional.join(" ");
			if (!name) {
				ctx.ui.notify("Usage: /codeGraph-context <name> [--file partial-path]", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Try again when idle.", "warning");
				return;
			}
			const filePart = flags["file"] ? `, file="${flags["file"]}"` : "";
			pi.sendUserMessage(`Run \`code_context\` with name="${name}"${filePart}.`);
		},
	});
}
