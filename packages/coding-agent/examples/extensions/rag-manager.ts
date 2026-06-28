/**
 * RAG manager extension — registers `/rag-kb` and `/rag` commands.
 * Knowledge base: ~/.free-code/knowledgeBase/
 * RAG server: http://localhost:8085 (override with FREE_CODE_RAG_SERVER_URL)
 */

import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@free/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@free/pi-coding-agent";

const DEFAULT_RAG_BASE = "http://localhost:8085";
const DEFAULT_RAG_MAX_CHUNKS = 3;
const DEFAULT_RAG_MAX_CHARS = 3000;
const RAG_ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".md", ".txt"]);
/** Sidecar filenames; stored in the KB dir but not embedded in the vector index (server skips in addkb / rebuild). */
const KNOWLEDGE_METADATA_SUFFIX = ".knowledge.md";
const SUBCOMMANDS = ["addFile", "addGroup", "search", "list", "remove"] as const;
const KB_SUBCOMMANDS = ["create", "delete", "use", "list"] as const;
const KB_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

function readEnv(primary: string, legacy?: string): string | undefined {
	const raw = process.env[primary]?.trim() || (legacy ? process.env[legacy]?.trim() : undefined);
	return raw && raw.length > 0 ? raw : undefined;
}

function getRagServerBase(): string {
	const base = readEnv("FREE_CODE_RAG_SERVER_URL", "EDO_RAG_SERVER_URL") ?? DEFAULT_RAG_BASE;
	return base.replace(/\/$/, "");
}

function getKnowledgeBaseRootDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "knowledgeBase");
}

function getKnowledgeBaseDir(kb: string): string {
	return join(getKnowledgeBaseRootDir(), kb);
}

function normalizeKbName(raw: string): string {
	const kb = raw.trim();
	if (!KB_NAME_REGEX.test(kb)) {
		throw new Error("Invalid KB name. Use only letters, numbers, '-' or '_'.");
	}
	return kb;
}

async function listKnowledgeBases(): Promise<{ ok: true; kbs: string[] } | { ok: false; error: string }> {
	const base = getRagServerBase();
	try {
		const res = await fetch(`${base}/kbs`, { method: "GET" });
		if (!res.ok) return { ok: false, error: `RAG server: ${res.status} ${res.statusText}` };
		const data = (await res.json()) as unknown;
		if (!data || typeof data !== "object" || !("knowledge_bases" in data)) {
			return { ok: false, error: "Invalid response from RAG server (expected { knowledge_bases: string[] })." };
		}
		const kbs = (data as { knowledge_bases: unknown }).knowledge_bases;
		if (!Array.isArray(kbs) || !kbs.every((x) => typeof x === "string")) {
			return { ok: false, error: "Invalid knowledge_bases list from RAG server." };
		}
		return { ok: true, kbs };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
}

async function mutateKnowledgeBase(
	path: "createkb" | "deletekb",
	kb: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const base = getRagServerBase();
	try {
		const res = await fetch(`${base}/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kb }),
		});
		if (!res.ok) {
			let detail = `${res.status} ${res.statusText}`;
			try {
				const errBody = (await res.json()) as { detail?: unknown };
				if (errBody?.detail !== undefined) {
					detail = typeof errBody.detail === "string" ? errBody.detail : JSON.stringify(errBody.detail);
				}
			} catch {
				// ignore JSON parse errors
			}
			return { ok: false, error: detail };
		}
		return { ok: true };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
}

function getRagMaxChunks(): number {
	const raw = readEnv("FREE_CODE_RAG_MAX_CHUNKS", "EDO_RAG_MAX_CHUNKS");
	if (raw) {
		const n = parseInt(raw, 10);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return DEFAULT_RAG_MAX_CHUNKS;
}

function getRagMaxChars(): number {
	const raw = readEnv("FREE_CODE_RAG_MAX_CHARS", "EDO_RAG_MAX_CHARS");
	if (raw) {
		const n = parseInt(raw, 10);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return DEFAULT_RAG_MAX_CHARS;
}

function isAllowedRagExtension(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	return RAG_ALLOWED_EXTENSIONS.has(ext);
}

function isKnowledgeMetadataDestPath(destPath: string): boolean {
	return basename(destPath).toLowerCase().endsWith(KNOWLEDGE_METADATA_SUFFIX);
}

/** Normalize pasted paths: trim, strip `[…]` wrappers, repeated matching quotes, then stray `'`/`"` on the ends. */
function normalizeUserPathArg(raw: string): string {
	const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
		["'", "'"],
		['"', '"'],
		["\u2018", "\u2019"],
		["\u201c", "\u201d"],
	];

	let s = raw.trim();
	let changed = true;
	while (changed) {
		changed = false;
		s = s.trim();
		if (s.length >= 2 && s[0] === "[" && s[s.length - 1] === "]") {
			s = s.slice(1, -1).trim();
			changed = true;
			continue;
		}
		for (const [open, close] of QUOTE_PAIRS) {
			if (s.length >= open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
				s = s.slice(open.length, s.length - close.length).trim();
				changed = true;
				break;
			}
		}
	}
	while (s.length > 0 && (s[0] === "'" || s[0] === '"')) {
		s = s.slice(1).trim();
	}
	while (s.length > 0) {
		const last = s[s.length - 1];
		if (last === "'" || last === '"') {
			s = s.slice(0, -1).trim();
		} else {
			break;
		}
	}
	return s.trim();
}

type RagAddResult = { ok: true; destPath: string } | { ok: false; error: string };
type RagAddGroupResult =
	| {
			ok: true;
			added: string[];
			skipped: string[];
			failed: Array<{ file: string; error: string }>;
	  }
	| { ok: false; error: string };

async function ragAdd(sourcePath: string, cwd: string, kb: string): Promise<RagAddResult> {
	const cleaned = normalizeUserPathArg(sourcePath);
	const resolvedSource = resolve(cwd, cleaned);
	if (!existsSync(resolvedSource)) {
		return { ok: false, error: `File not found: ${sourcePath}` };
	}
	try {
		const st = await stat(resolvedSource);
		if (!st.isFile()) {
			return { ok: false, error: `Not a file: ${sourcePath}` };
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}

	if (!isAllowedRagExtension(resolvedSource)) {
		return {
			ok: false,
			error: `Unsupported file type. Allowed: ${[...RAG_ALLOWED_EXTENSIONS].sort().join(", ")}`,
		};
	}

	const baseName = basename(resolvedSource);
	const kbDir = getKnowledgeBaseDir(kb);
	await mkdir(kbDir, { recursive: true });

	const destPath = join(kbDir, baseName);

	if (existsSync(destPath)) {
		const removed = await notifyRemoveKb(baseName, kb);
		if (!removed.ok) {
			return {
				ok: false,
				error: `Could not replace existing file '${baseName}' in KB '${kb}': ${removed.error}`,
			};
		}
	}

	try {
		await copyFile(resolvedSource, destPath);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}

	const notify = await notifyAddKb(baseName, kb);
	if (!notify.ok) {
		try {
			await unlink(destPath);
		} catch {
			// best-effort rollback
		}
		return { ok: false, error: `File copied to ${destPath}, but indexer failed: ${notify.error}` };
	}

	return { ok: true, destPath };
}

async function ragAddGroup(folderPath: string, cwd: string, kb: string): Promise<RagAddGroupResult> {
	const cleaned = normalizeUserPathArg(folderPath);
	const resolvedFolder = resolve(cwd, cleaned);
	if (!existsSync(resolvedFolder)) {
		return { ok: false, error: `Folder not found: ${folderPath}` };
	}
	try {
		const st = await stat(resolvedFolder);
		if (!st.isDirectory()) {
			return { ok: false, error: `Not a folder: ${folderPath}` };
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}

	let names: string[] = [];
	try {
		names = await readdir(resolvedFolder);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}

	const added: string[] = [];
	const skipped: string[] = [];
	const failed: Array<{ file: string; error: string }> = [];

	for (const name of names.sort()) {
		const candidate = join(resolvedFolder, name);
		try {
			const st = await stat(candidate);
			if (!st.isFile()) {
				skipped.push(name);
				continue;
			}
		} catch {
			skipped.push(name);
			continue;
		}
		if (!isAllowedRagExtension(candidate)) {
			skipped.push(name);
			continue;
		}
		const addedFile = await ragAdd(candidate, cwd, kb);
		if (addedFile.ok) {
			added.push(name);
		} else {
			failed.push({ file: name, error: addedFile.error });
		}
	}

	return { ok: true, added, skipped, failed };
}

/** POST /addkb with JSON body `{ "filename": "<basename in knowledge base>", "kb": "<name>" }`. */
async function notifyAddKb(filename: string, kb: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const base = getRagServerBase();
	try {
		const res = await fetch(`${base}/addkb`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filename, kb }),
		});
		if (!res.ok) {
			let detail = `${res.status} ${res.statusText}`;
			try {
				const errBody = (await res.json()) as { detail?: unknown };
				if (errBody?.detail !== undefined) {
					detail = typeof errBody.detail === "string" ? errBody.detail : JSON.stringify(errBody.detail);
				}
			} catch {
				// ignore JSON parse errors
			}
			return { ok: false, error: detail };
		}
		return { ok: true };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
}

async function notifyRemoveKb(filename: string, kb: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const base = getRagServerBase();
	try {
		const res = await fetch(`${base}/removekb`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filename, kb }),
		});
		if (!res.ok) {
			let detail = `${res.status} ${res.statusText}`;
			try {
				const errBody = (await res.json()) as { detail?: unknown };
				if (errBody?.detail !== undefined) {
					detail = typeof errBody.detail === "string" ? errBody.detail : JSON.stringify(errBody.detail);
				}
			} catch {
				// ignore JSON parse errors
			}
			return { ok: false, error: detail };
		}
		return { ok: true };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
}

type DiscoverFileJson = { filename: string; content: string; truncated?: boolean };

type RagDiscoverResult =
	| { ok: true; kb: string; files: DiscoverFileJson[]; message?: string }
	| { ok: false; error: string; discoverUnsupported?: boolean };

async function fetchRagDiscover(kb: string): Promise<RagDiscoverResult> {
	const base = getRagServerBase();
	try {
		const res = await fetch(`${base}/discover?kb=${encodeURIComponent(kb)}`, { method: "GET" });
		if (!res.ok) {
			if (res.status === 404) {
				return { ok: false, error: `RAG server: ${res.status} ${res.statusText}`, discoverUnsupported: true };
			}
			return { ok: false, error: `RAG server: ${res.status} ${res.statusText}` };
		}
		const data = (await res.json()) as unknown;
		if (!data || typeof data !== "object" || !("files" in data)) {
			return { ok: false, error: "Invalid response from RAG server (expected discover JSON with files)." };
		}
		const filesRaw = (data as { files: unknown }).files;
		if (!Array.isArray(filesRaw)) {
			return { ok: false, error: "Invalid discover.files from RAG server." };
		}
		const files: DiscoverFileJson[] = [];
		for (const item of filesRaw) {
			if (!item || typeof item !== "object") continue;
			const o = item as Record<string, unknown>;
			const fn = o.filename;
			const content = o.content;
			if (typeof fn !== "string" || typeof content !== "string") continue;
			files.push({
				filename: fn,
				content,
				truncated: o.truncated === true,
			});
		}
		const message =
			"message" in data && typeof (data as { message?: unknown }).message === "string"
				? (data as { message: string }).message
				: undefined;
		return { ok: true, kb, files, message };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
}

function formatDiscoverKbPrompt(kb: string, disc: RagDiscoverResult): string {
	if (!disc.ok) {
		return `Knowledge base "${kb}" is selected. Metadata overview (GET /discover) could not be loaded: ${disc.error}`;
	}
	const header = `Knowledge base "${kb}" — overview from *.knowledge.md metadata files (these are not returned by /rag search / vector query). Use this to understand what the KB covers.\n\n`;
	if (disc.files.length === 0) {
		return `${header}${disc.message ?? "No *.knowledge.md metadata files in this KB."}`;
	}
	const blocks = disc.files
		.map((f) => {
			const trunc = f.truncated ? "\n[Truncated by server size limit]" : "";
			return `### ${f.filename}\n${f.content}${trunc}`;
		})
		.join("\n\n---\n\n");
	const tail = disc.message ? `\n\nNote: ${disc.message}` : "";
	return `${header}${blocks}${tail}`;
}

type RagQueryResult = { ok: true; chunks: string[] } | { ok: false; error: string };

async function ragQuery(text: string, kb: string): Promise<RagQueryResult> {
	const q = text.trim();
	if (!q) {
		return { ok: false, error: "Query text is empty." };
	}
	const base = getRagServerBase();
	const maxChunks = getRagMaxChunks();
	const maxChars = getRagMaxChars();
	const url = `${base}/query?text=${encodeURIComponent(q)}&top_k=${maxChunks}&kb=${encodeURIComponent(kb)}`;
	try {
		const res = await fetch(url, { method: "GET" });
		if (!res.ok) {
			return { ok: false, error: `RAG server: ${res.status} ${res.statusText}` };
		}
		const data = (await res.json()) as unknown;
		if (!data || typeof data !== "object" || !("results" in data)) {
			return { ok: false, error: "Invalid response from RAG server (expected { results: string[] })." };
		}
		const results = (data as { results: unknown }).results;
		if (!Array.isArray(results) || !results.every((x) => typeof x === "string")) {
			return { ok: false, error: "Invalid results array from RAG server." };
		}

		const limited = results.slice(0, maxChunks);
		const truncated: string[] = [];
		let totalChars = 0;
		for (const chunk of limited) {
			const remaining = maxChars - totalChars;
			if (remaining <= 0) break;
			if (chunk.length <= remaining) {
				truncated.push(chunk);
				totalChars += chunk.length;
			} else {
				truncated.push(`${chunk.slice(0, remaining)}\n[…truncated]`);
				totalChars += remaining;
				break;
			}
		}

		return { ok: true, chunks: truncated };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
}

function formatRagUsePrompt(query: string, chunks: string[]): string {
	const header =
		"The following excerpts were retrieved from the local knowledge base (RAG). Use them to ground your answer; if they are insufficient, say so.\n\n";
	const body = chunks.map((c, i) => `[${i + 1}] ${c}`).join("\n\n---\n\n");
	return `${header}${body}\n\n---\n\nUser question: ${query.trim()}`;
}

type RagListResult = { ok: true; files: string[] } | { ok: false; error: string };

async function ragList(kb: string): Promise<RagListResult> {
	const kbDir = getKnowledgeBaseDir(kb);
	if (!existsSync(kbDir)) {
		return { ok: true, files: [] };
	}
	try {
		const names = await readdir(kbDir);
		const files: string[] = [];
		for (const name of names) {
			const p = join(kbDir, name);
			try {
				const st = await stat(p);
				if (st.isFile()) files.push(name);
			} catch {
				// skip
			}
		}
		files.sort();
		return { ok: true, files };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
}

type RagRemoveResult = { ok: true } | { ok: false; error: string };
type RagCommandCtx = {
	ui: { notify: (message: string, type: "info" | "warning" | "error") => void };
};

function isSafeKbFilename(name: string): boolean {
	if (!name || name !== basename(name)) return false;
	if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;
	return true;
}

async function ragRemove(filename: string, kb: string): Promise<RagRemoveResult> {
	const trimmed = filename.trim();
	if (!trimmed) {
		return { ok: false, error: "Filename is required." };
	}
	if (!isSafeKbFilename(trimmed)) {
		return { ok: false, error: "Invalid filename (use a base name only, no paths)." };
	}
	const kbRoot = resolve(getKnowledgeBaseDir(kb));
	const target = resolve(kbRoot, trimmed);
	const rel = relative(kbRoot, target);
	if (rel.startsWith("..") || rel.includes("..")) {
		return { ok: false, error: "Invalid path." };
	}
	if (!existsSync(target)) {
		return { ok: false, error: `Not found in knowledge base: ${trimmed}` };
	}
	try {
		await unlink(target);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}

	const base = getRagServerBase();
	try {
		await fetch(`${base}/removekb`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filename: trimmed, kb }),
		});
	} catch {
		// optional per rag-server-spec future enhancement
	}
	return { ok: true };
}

function parseSubcommand(args: string): { sub: string; rest: string } {
	const t = args.trim();
	if (!t) return { sub: "", rest: "" };
	const match = /^(\S+)\s*(.*)$/s.exec(t);
	if (!match) return { sub: "", rest: "" };
	return { sub: match[1], rest: match[2] };
}

export default function ragManagerExtension(pi: ExtensionAPI) {
	let selectedKb: string | null = null;

	const emitSelectedKb = (kb: string | null) => {
		pi.events.emit("rag-kb:selected", { kb });
	};

	const notifyKbSelectionStatus = async (ctx: RagCommandCtx) => {
		const selected = selectedKb ? `Selected KB: ${selectedKb}` : "No KB selected.";
		const listed = await listKnowledgeBases();
		if (!listed.ok) {
			ctx.ui.notify(`${selected}\nCould not list KBs: ${listed.error}\nUse: /rag-kb list`, "info");
			return;
		}
		const available = listed.kbs.length > 0 ? listed.kbs.join(", ") : "(none)";
		ctx.ui.notify(`${selected}\nAvailable KBs: ${available}\nUse: /rag-kb use <name>`, "info");
	};

	const injectKbDiscoverContext = async (kb: string, onWarn?: (msg: string) => void): Promise<void> => {
		const disc = await fetchRagDiscover(kb);
		if (!disc.ok) {
			if (disc.discoverUnsupported) {
				const hint = `(${kb}) KB sidecars (*.knowledge.md) are on disk under ${getKnowledgeBaseDir(kb)}, but this RAG server has no GET /discover (404). Upgrade/run free-code-rag from the repo so /rag-kb use can inject metadata overviews. /rag search never includes those files by design.`;
				if (onWarn) onWarn(hint);
				else pi.sendUserMessage(hint);
				return;
			}
			const msg = `Could not load KB metadata overview: ${disc.error}`;
			if (onWarn) onWarn(msg);
			else pi.sendUserMessage(`(${msg})`);
			return;
		}
		pi.sendUserMessage(formatDiscoverKbPrompt(kb, disc));
	};

	pi.registerCommand("rag-kb", {
		description: "Manage RAG knowledge bases: /rag-kb create|delete|use <name> | /rag-kb list",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trimStart();
			const parts = p.split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				return KB_SUBCOMMANDS.map((s) => ({ value: `${s} `, label: s }));
			}
			if (parts.length === 1) {
				const filtered = KB_SUBCOMMANDS.filter((s) => s.startsWith(parts[0]));
				return filtered.length > 0 ? filtered.map((s) => ({ value: `${s} `, label: s })) : null;
			}
			const [sub, ...rest] = parts;
			if (sub !== "use" && sub !== "delete") return null;
			const typedName = rest.join(" ");
			const kbDir = getKnowledgeBaseRootDir();
			try {
				const names = readdirSync(kbDir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name)
					.sort();
				const filtered = typedName ? names.filter((name) => name.startsWith(typedName)) : names;
				return filtered.map((name) => ({ value: `${sub} ${name}`, label: name }));
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			const { sub, rest } = parseSubcommand(args);
			if (!sub) {
				ctx.ui.notify("Usage: /rag-kb create|delete|use <kb_name> | /rag-kb list", "info");
				return;
			}
			switch (sub) {
				case "list": {
					const listed = await listKnowledgeBases();
					if (!listed.ok) {
						ctx.ui.notify(`Could not list KBs: ${listed.error}`, "error");
						return;
					}
					ctx.ui.notify(
						listed.kbs.length > 0
							? `Available KBs: ${listed.kbs.join(", ")}`
							: "No KBs available yet. Create one with /rag-kb create <kb_name>",
						"info",
					);
					return;
				}
				case "create": {
					const kbRaw = rest.trim();
					if (!kbRaw) {
						ctx.ui.notify("Usage: /rag-kb create <kb_name>", "warning");
						return;
					}
					let kb: string;
					try {
						kb = normalizeKbName(kbRaw);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						ctx.ui.notify(msg, "error");
						return;
					}
					const created = await mutateKnowledgeBase("createkb", kb);
					if (!created.ok) {
						ctx.ui.notify(`Could not create KB '${kb}': ${created.error}`, "error");
						return;
					}
					ctx.ui.notify(`Created KB: ${kb}`, "info");
					return;
				}
				case "delete": {
					const kbRaw = rest.trim();
					if (!kbRaw) {
						ctx.ui.notify("Usage: /rag-kb delete <kb_name>", "warning");
						return;
					}
					let kb: string;
					try {
						kb = normalizeKbName(kbRaw);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						ctx.ui.notify(msg, "error");
						return;
					}
					const deleted = await mutateKnowledgeBase("deletekb", kb);
					if (!deleted.ok) {
						ctx.ui.notify(`Could not delete KB '${kb}': ${deleted.error}`, "error");
						return;
					}
					if (selectedKb === kb) {
						selectedKb = null;
						emitSelectedKb(null);
					}
					ctx.ui.notify(`Deleted KB: ${kb}`, "info");
					return;
				}
				case "use": {
					const kbRaw = rest.trim();
					if (!kbRaw) {
						ctx.ui.notify("Usage: /rag-kb use <kb_name>", "warning");
						return;
					}
					let kb: string;
					try {
						kb = normalizeKbName(kbRaw);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						ctx.ui.notify(msg, "error");
						return;
					}
					const listed = await listKnowledgeBases();
					if (!listed.ok) {
						ctx.ui.notify(`Could not verify KBs: ${listed.error}`, "error");
						return;
					}
					if (!listed.kbs.includes(kb)) {
						ctx.ui.notify(`KB '${kb}' does not exist. Create it first with /rag-kb create ${kb}`, "warning");
						return;
					}
					selectedKb = kb;
					emitSelectedKb(selectedKb);
					ctx.ui.notify(`Selected KB: ${selectedKb}`, "info");
					await injectKbDiscoverContext(kb, (msg) => ctx.ui.notify(msg, "warning"));
					return;
				}
				default:
					ctx.ui.notify("Unknown subcommand. Try: create, delete, use, list", "warning");
			}
		},
	});

	pi.events.on("rag-kb:select", async (data) => {
		if (!data || typeof data !== "object") return;
		const raw = (data as Record<string, unknown>).kb;
		if (raw === null || raw === undefined || raw === "") {
			selectedKb = null;
			emitSelectedKb(null);
			return;
		}
		if (typeof raw !== "string") return;
		let kb: string;
		try {
			kb = normalizeKbName(raw);
		} catch {
			selectedKb = null;
			emitSelectedKb(null);
			return;
		}
		const listed = await listKnowledgeBases();
		if (!listed.ok || !listed.kbs.includes(kb)) {
			selectedKb = null;
			emitSelectedKb(null);
			return;
		}
		selectedKb = kb;
		emitSelectedKb(selectedKb);
		void injectKbDiscoverContext(kb);
	});

	pi.registerCommand("rag", {
		description:
			"Knowledge base (RAG): /rag addFile <file> | /rag addGroup <folder> | /rag search <query> | /rag list | /rag remove <file>",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trimStart();
			const filtered = SUBCOMMANDS.filter((s) => s.startsWith(p));
			return filtered.length > 0 ? filtered.map((s) => ({ value: `${s} `, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const { sub, rest } = parseSubcommand(args);

			if (!sub) {
				ctx.ui.notify(
					"Usage: /rag addFile <path> | /rag addGroup <folder> | /rag search <query> | /rag list | /rag remove <filename>",
					"info",
				);
				return;
			}

			switch (sub) {
				case "addFile": {
					if (!selectedKb) {
						await notifyKbSelectionStatus(ctx);
						return;
					}
					const pathArg = normalizeUserPathArg(rest);
					if (!pathArg) {
						ctx.ui.notify("Usage: /rag addFile <file_path>", "warning");
						return;
					}
					const resolved = resolve(ctx.cwd, pathArg);
					if (!isAllowedRagExtension(resolved)) {
						ctx.ui.notify(
							`Unsupported file type. Allowed extensions: ${[...RAG_ALLOWED_EXTENSIONS].sort().join(", ")}`,
							"warning",
						);
						return;
					}
					ctx.ui.notify(`Adding file to KB '${selectedKb}'...`, "info");
					const result = await ragAdd(pathArg, ctx.cwd, selectedKb);
					if (!result.ok) {
						ctx.ui.notify(result.error, "error");
						return;
					}
					const addedMsg = isKnowledgeMetadataDestPath(result.destPath)
						? `Stored in KB '${selectedKb}' (${KNOWLEDGE_METADATA_SUFFIX} sidecar — on disk for GET /discover; not in vector /rag search): ${result.destPath}`
						: `Added to KB '${selectedKb}': ${result.destPath}`;
					ctx.ui.notify(addedMsg, "info");
					return;
				}
				case "addGroup": {
					if (!selectedKb) {
						await notifyKbSelectionStatus(ctx);
						return;
					}
					const folderArg = normalizeUserPathArg(rest);
					if (!folderArg) {
						ctx.ui.notify("Usage: /rag addGroup <folder_with_files>", "warning");
						return;
					}
					ctx.ui.notify(`Adding files from folder to KB '${selectedKb}'...`, "info");
					const grouped = await ragAddGroup(folderArg, ctx.cwd, selectedKb);
					if (!grouped.ok) {
						ctx.ui.notify(grouped.error, "error");
						return;
					}
					const summary = [
						`KB '${selectedKb}'`,
						`Added: ${grouped.added.length}`,
						`Skipped: ${grouped.skipped.length}`,
						`Failed: ${grouped.failed.length}`,
					];
					if (grouped.failed.length > 0) {
						const failedLines = grouped.failed.slice(0, 5).map((x) => `- ${x.file}: ${x.error}`);
						ctx.ui.notify(`${summary.join(" | ")}\n${failedLines.join("\n")}`, "warning");
						return;
					}
					ctx.ui.notify(summary.join(" | "), "info");
					return;
				}
				case "search": {
					if (!selectedKb) {
						await notifyKbSelectionStatus(ctx);
						return;
					}
					const query = rest.trim();
					if (!query) {
						ctx.ui.notify("Usage: /rag search <query>", "warning");
						return;
					}
					const q = await ragQuery(query, selectedKb);
					if (!q.ok) {
						ctx.ui.notify(q.error, "error");
						return;
					}
					const prompt = formatRagUsePrompt(query, q.chunks);
					pi.sendUserMessage(prompt);
					return;
				}
				case "list": {
					if (!selectedKb) {
						await notifyKbSelectionStatus(ctx);
						return;
					}
					const list = await ragList(selectedKb);
					if (!list.ok) {
						ctx.ui.notify(list.error, "error");
						return;
					}
					const kbDir = getKnowledgeBaseDir(selectedKb);
					if (list.files.length === 0) {
						ctx.ui.notify(`KB '${selectedKb}' is empty (${kbDir})`, "info");
						return;
					}
					ctx.ui.notify(`KB '${selectedKb}' (${kbDir})\n${list.files.join("\n")}`, "info");
					return;
				}
				case "remove": {
					if (!selectedKb) {
						await notifyKbSelectionStatus(ctx);
						return;
					}
					const name = rest.trim();
					if (!name) {
						ctx.ui.notify("Usage: /rag remove <filename>", "warning");
						return;
					}
					const removed = await ragRemove(name, selectedKb);
					if (!removed.ok) {
						ctx.ui.notify(removed.error, "error");
						return;
					}
					ctx.ui.notify(`Removed from KB '${selectedKb}': ${name}`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}. Try: addFile, addGroup, search, list, remove`, "warning");
			}
		},
	});
}
