/**
 * RAG manager extension — registers `/rag-kb` and `/rag` commands.
 * Knowledge base: ~/.free-code/knowledgeBase/
 * RAG server: http://localhost:8085 (override with FREE_CODE_RAG_SERVER_URL)
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, copyFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@free/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@free/pi-coding-agent";

const DEFAULT_RAG_BASE = "http://localhost:8085";
const DEFAULT_RAG_MAX_CHUNKS = 3;
const DEFAULT_RAG_MAX_CHARS = 3000;
const RAG_ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".md", ".txt"]);
/** Sidecar filenames; stored in the KB dir but not embedded in the vector index (server skips in addkb / rebuild). */
const KNOWLEDGE_METADATA_SUFFIX = ".knowledge.md";
const SUBCOMMANDS = ["addFile", "addGroup", "addGithubUrl", "addDrive", "search", "list", "remove", "refresh", "schedule"] as const;
const SOURCES_FILENAME = "sources.json";

function readEnv(primary: string, legacy?: string): string | undefined {
	const raw = process.env[primary]?.trim() || (legacy ? process.env[legacy]?.trim() : undefined);
	return raw && raw.length > 0 ? raw : undefined;
}

const PRESET_SCHEDULES: Record<string, { cron: string; label: string }> = {
	hourly: { cron: "7 * * * *",  label: "every hour" },
	daily:  { cron: "57 8 * * *", label: "every day at ~9am" },
	weekly: { cron: "57 8 * * 1", label: "every Monday at ~9am" },
};
const KB_SUBCOMMANDS = ["create", "delete", "use", "list"] as const;
const KB_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

type GithubSource = { type: "github"; url: string; subPath?: string; addedAt: string; lastRefreshedAt?: string };
type FileSource = { type: "file"; sourcePath: string; addedAt: string; lastRefreshedAt?: string };
type SourceEntry = GithubSource | FileSource;
type ScheduleConfig = { cron: string; preset?: string; cronJobId?: string; createdAt: string };

async function loadSources(kb: string): Promise<SourceEntry[]> {
	const p = join(getKnowledgeBaseDir(kb), SOURCES_FILENAME);
	try {
		const raw = await readFile(p, "utf-8");
		const parsed = JSON.parse(raw) as { sources?: unknown };
		return Array.isArray(parsed.sources) ? (parsed.sources as SourceEntry[]) : [];
	} catch {
		return [];
	}
}

async function saveSources(kb: string, sources: SourceEntry[]): Promise<void> {
	const kbDir = getKnowledgeBaseDir(kb);
	await mkdir(kbDir, { recursive: true });
	await writeFile(join(kbDir, SOURCES_FILENAME), JSON.stringify({ sources }, null, 2), "utf-8");
}

async function upsertGithubSource(kb: string, url: string, subPath?: string): Promise<void> {
	const sources = await loadSources(kb);
	const now = new Date().toISOString();
	const idx = sources.findIndex((s) => s.type === "github" && s.url === url && (s as GithubSource).subPath === subPath);
	if (idx >= 0) {
		(sources[idx] as GithubSource).lastRefreshedAt = now;
	} else {
		const entry: GithubSource = { type: "github", url, addedAt: now };
		if (subPath) entry.subPath = subPath;
		sources.push(entry);
	}
	await saveSources(kb, sources);
}

async function upsertFileSource(kb: string, sourcePath: string): Promise<void> {
	const sources = await loadSources(kb);
	const now = new Date().toISOString();
	const idx = sources.findIndex((s) => s.type === "file" && (s as FileSource).sourcePath === sourcePath);
	if (idx >= 0) {
		(sources[idx] as FileSource).lastRefreshedAt = now;
	} else {
		sources.push({ type: "file", sourcePath, addedAt: now });
	}
	await saveSources(kb, sources);
}

async function loadScheduleConfig(kb: string): Promise<ScheduleConfig | undefined> {
	const p = join(getKnowledgeBaseDir(kb), SOURCES_FILENAME);
	try {
		const raw = await readFile(p, "utf-8");
		const parsed = JSON.parse(raw) as { schedule?: unknown };
		return parsed.schedule as ScheduleConfig | undefined;
	} catch {
		return undefined;
	}
}

async function saveScheduleConfig(kb: string, schedule: ScheduleConfig | null): Promise<void> {
	const p = join(getKnowledgeBaseDir(kb), SOURCES_FILENAME);
	let data: Record<string, unknown> = { sources: [] };
	try {
		const raw = await readFile(p, "utf-8");
		data = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		// file may not exist yet
	}
	if (schedule === null) {
		delete data.schedule;
	} else {
		data.schedule = schedule;
	}
	const kbDir = getKnowledgeBaseDir(kb);
	await mkdir(kbDir, { recursive: true });
	await writeFile(p, JSON.stringify(data, null, 2), "utf-8");
}

function isValidCronExpression(expr: string): boolean {
	return expr.trim().split(/\s+/).length === 5;
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

async function verifyRagServerKnowledgeBaseRoot(): Promise<{ ok: true } | { ok: false; error: string }> {
	const base = getRagServerBase();
	const expected = resolve(getKnowledgeBaseRootDir());
	try {
		const res = await fetch(`${base}/health`, { method: "GET" });
		if (!res.ok) {
			return { ok: false, error: `RAG server health check failed: ${res.status} ${res.statusText}` };
		}
		const data = (await res.json()) as unknown;
		const rawDir =
			data && typeof data === "object" && "knowledge_base_dir" in data
				? (data as { knowledge_base_dir?: unknown }).knowledge_base_dir
				: undefined;
		if (typeof rawDir !== "string" || rawDir.trim().length === 0) {
			return {
				ok: false,
				error: "RAG server health response is missing knowledge_base_dir. Start the current free-code-rag server.",
			};
		}
		const actual = resolve(rawDir);
		if (actual !== expected) {
			return {
				ok: false,
				error: `RAG server at ${base} is using ${actual}, but FreeCode stores KB files in ${expected}. Stop the old RAG server on port 8085 and start free-code-rag again.`,
			};
		}
		return { ok: true };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, error: msg };
	}
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
		const compatible = await verifyRagServerKnowledgeBaseRoot();
		if (!compatible.ok) return compatible;

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
		const compatible = await verifyRagServerKnowledgeBaseRoot();
		if (!compatible.ok) return compatible;

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
type RagAddGroupResult = {
	ok: true;
	added: string[];
	skipped: string[];
	failed: Array<{ file: string; error: string }>;
} | { ok: false; error: string };

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

	const compatible = await verifyRagServerKnowledgeBaseRoot();
	if (!compatible.ok) return compatible;

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
		const compatible = await verifyRagServerKnowledgeBaseRoot();
		if (!compatible.ok) return compatible;

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
		const compatible = await verifyRagServerKnowledgeBaseRoot();
		if (!compatible.ok) return compatible;

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
		const compatible = await verifyRagServerKnowledgeBaseRoot();
		if (!compatible.ok) return compatible;

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
		const compatible = await verifyRagServerKnowledgeBaseRoot();
		if (!compatible.ok) return compatible;

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
			if (name === SOURCES_FILENAME) continue;
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
	const compatible = await verifyRagServerKnowledgeBaseRoot();
	if (!compatible.ok) return compatible;

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

const execFileAsync = promisify(execFile);

async function ragAddGithubUrl(url: string, kb: string, subPath?: string): Promise<RagAddGroupResult> {
	const trimmedUrl = url.trim();
	if (!trimmedUrl) {
		return { ok: false, error: "GitHub URL is required." };
	}
	if (!trimmedUrl.startsWith("https://") && !trimmedUrl.startsWith("git@")) {
		return { ok: false, error: "Invalid URL. Must start with https:// or git@." };
	}

	const tmpBase = await mkdtemp(join(tmpdir(), "rag-github-"));
	const cloneTarget = join(tmpBase, "repo");

	try {
		try {
			await execFileAsync("git", ["clone", "--depth", "1", trimmedUrl, cloneTarget]);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, error: `git clone failed: ${msg}` };
		}

		const indexRoot = subPath ? join(cloneTarget, subPath) : cloneTarget;

		if (!existsSync(indexRoot)) {
			return { ok: false, error: `Path '${subPath}' not found in repository.` };
		}

		try {
			const st = await stat(indexRoot);
			if (!st.isDirectory()) {
				return { ok: false, error: `Path '${subPath}' is not a directory in the repository.` };
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, error: msg };
		}

		return await ragAddGroup(indexRoot, indexRoot, kb);
	} finally {
		try {
			await rm(tmpBase, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

function normalizeGoogleDriveUrl(raw: string): string {
	const value = raw.trim();
	if (!value) throw new Error("A Google Drive URL is required.");
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error("Enter a valid URL, for example https://docs.google.com/...");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http and https URLs are supported.");
	}
	return url.toString();
}

function buildRagDrivePrompt(url: string, kb: string, ragBase: string): string {
	const kbDir = join(homedir(), ".free-code", "knowledgeBase", kb);
	return [
		"Execute the following workflow using agent_browser only. Follow each step in order and do not skip steps.",
		"Goal: download a Google Drive document and index it into the RAG knowledge base.",
		"",
		"## Step 1 — Open the document",
		"Open this URL in the existing Chrome debug session (already logged in to Google):",
		`  ${url}`,
		'Call agent_browser with args ["--cdp", "http://127.0.0.1:9222", "open", "' + url + '"] and sessionMode "fresh".',
		"Wait for the page to fully load.",
		"",
		"## Step 2 — Snapshot the page",
		'Call agent_browser with args ["snapshot", "-i"] to inspect the loaded document.',
		"Verify the document is open and the toolbar is visible before proceeding.",
		"",
		"## Step 3 — Open the File menu",
		'Click the element with id="docs-file-menu" to open the File menu.',
		'Call agent_browser with args ["click", "#docs-file-menu"].',
		'Then snapshot again with args ["snapshot", "-i"] to confirm the menu opened.',
		"",
		"## Step 4 — Click the Download menu item",
		'Find the element with aria-label that contains "Download" (it may appear as "Download d" or similar with a keyboard shortcut indicator).',
		'Click it using agent_browser with args ["click", "[aria-label=\\"Download d\\"]"] or the matching ref from the snapshot.',
		'If the exact aria-label differs, use the ref from the snapshot for the Download menu item.',
		'Then snapshot again with args ["snapshot", "-i"] to see the format submenu.',
		"",
		"## Step 5 — Ask the user which format to download",
		"Use AskUserQuestion to present a questionnaire to the user with these exact options:",
		'  Question: "Which format would you like to download?"',
		"  Options:",
		'    - label: "PDF (.pdf)",   description: "Download as PDF Document"',
		'    - label: "Word (.docx)", description: "Download as Microsoft Word"',
		'    - label: "Text (.txt)",  description: "Download as plain text"',
		"Wait for the user's answer before proceeding.",
		"",
		"## Step 6 — Click the chosen format",
		"Based on the user's selection, click the corresponding submenu item:",
		'  - PDF  → click aria-label containing "PDF"  (e.g. "PDF Document (.pdf)")',
		'  - DOCX → click aria-label containing "Word" or "docx" (e.g. "Microsoft Word (.docx)")',
		'  - TXT  → click aria-label containing "text" or "txt" (e.g. "Plain text (.txt)")',
		"Use the snapshot refs if the aria-label does not match exactly. After clicking the format, do NOT assume the download started — always go to Step 7 and snapshot first to check for the multi-tab export dialog.",
		"",
		"## Step 7 — Switch to All Tabs and export (REQUIRED after every format click)",
		"Take a snapshot with args [\"snapshot\", \"-i\"]. This snapshot is MANDATORY — never assume the download already started without inspecting it first.",
		"In the snapshot, a multi-tab export dialog appears as a heading \"Download\" together with a combobox labeled \"Tab\" (shown like: combobox \"Tab\" ...: Current Tab) and a button \"Export\". Multi-tab Google Docs ALWAYS show this dialog, and you MUST switch the tab selector to \"All Tabs\" before exporting. Target elements by their snapshot ref, not by CSS.",
		"  1. Click the ref of the combobox labeled \"Tab\" (its value reads \"Current Tab\") to open it.",
		"  2. Snapshot again with args [\"snapshot\", \"-i\"]. The opened listbox now lists option \"Current Tab\" and option \"All Tabs\".",
		"  3. Click the ref of the option \"All Tabs\".",
		"  4. Snapshot once more and confirm the \"Tab\" combobox now reads \"All Tabs\" (not \"Current Tab\") before continuing.",
		"  5. Click the ref of the button \"Export\" to start the download.",
		"Only if the snapshot has NO \"Download\" dialog (no combobox labeled \"Tab\" and no \"Export\" button) does the document have a single tab and the download already started — in that case skip to Step 8.",
		"",
		"## Step 8 — Wait for the download to complete",
		"Run this bash command to wait up to 30 seconds for a new file to appear in ~/Downloads:",
		"```bash",
		`DEST="$HOME/Downloads"`,
		`BEFORE=$(ls -t "$DEST" | head -5)`,
		`sleep 5`,
		`for i in $(seq 1 5); do`,
		`  AFTER=$(ls -t "$DEST" | head -5)`,
		`  if [ "$BEFORE" != "$AFTER" ]; then break; fi`,
		`  sleep 3`,
		`done`,
		"```",
		"",
		"## Step 9 — Identify the downloaded file",
		"Run this bash command to find the most recently downloaded file:",
		"```bash",
		`ls -t "$HOME/Downloads" | head -3`,
		"```",
		"Record the full absolute path of the downloaded file as DOWNLOADED_FILE (e.g. /Users/you/Downloads/MyDoc.pdf). Never use ~ — always expand to the absolute path.",
		"",
		"## Step 10 — Copy the file to the RAG knowledge base directory",
		`Copy the downloaded file directly into the KB directory: ${kbDir}`,
		"Run:",
		"```bash",
		`mkdir -p "${kbDir}"`,
		`cp "$DOWNLOADED_FILE" "${kbDir}/"`,
		"```",
		"Record the basename of the file as BASENAME (e.g. MyDoc.pdf).",
		"Confirm the copy succeeded by listing the file:",
		"```bash",
		`ls "${kbDir}/$BASENAME"`,
		"```",
		"",
		"## Step 11 — Index the file in the RAG server",
		`Call POST ${ragBase}/addkb with this exact JSON body:`,
		'  { "filename": "<BASENAME>", "kb": "' + kb + '" }',
		"Run:",
		"```bash",
		`curl -s -X POST ${ragBase}/addkb \\`,
		`  -H "Content-Type: application/json" \\`,
		`  -d "{\\"filename\\":\\"$BASENAME\\",\\"kb\\":\\"${kb}\\"}"`,
		"```",
		'If the server returns an error, report it but note the file is already saved to the KB directory.',
		"",
		"## Step 12 — Close the browser",
		'Call agent_browser with args ["close"] to close the browser session.',
		"",
		"## Final report",
		"Confirm to the user:",
		"- The Google Drive URL that was downloaded",
		"- The format selected",
		`- The file indexed into KB '${kb}': ${kbDir}/<BASENAME>`,
		"",
		"## Hard rules",
		"- Use agent_browser for all browser actions. Do not use AppleScript or other automation.",
		"- Do not retry failed downloads. If a step fails, report what was observed and stop.",
		"- Never mutate DOM attributes (no setAttribute calls).",
		"- Resolve all paths to absolute paths — never use ~ in agent_browser or cp calls.",
	].join("\n");
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
				const hint =
					`(${kb}) KB sidecars (*.knowledge.md) are on disk under ${getKnowledgeBaseDir(kb)}, but this RAG server has no GET /discover (404). Upgrade/run free-code-rag from the repo so /rag-kb use can inject metadata overviews. /rag search never includes those files by design.`;
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
			"Knowledge base (RAG): /rag addFile <file> | /rag addGroup <folder> | /rag addGithubUrl <url> [subpath] | /rag addDrive <google_drive_url> | /rag search <query> | /rag list | /rag remove <file> | /rag refresh | /rag schedule [daily|weekly|hourly|<cron>|off]",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trimStart();
			const filtered = SUBCOMMANDS.filter((s) => s.startsWith(p));
			return filtered.length > 0 ? filtered.map((s) => ({ value: `${s} `, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const { sub, rest } = parseSubcommand(args);

			if (!sub) {
				ctx.ui.notify(
					"Usage: /rag addFile <path> | /rag addGroup <folder> | /rag addGithubUrl <url> [subpath] | /rag addDrive <google_drive_url> | /rag search <query> | /rag list | /rag remove <filename> | /rag refresh | /rag schedule [daily|weekly|hourly|<cron>|off]",
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
					await upsertFileSource(selectedKb, resolve(ctx.cwd, normalizeUserPathArg(pathArg)));
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
				case "addGithubUrl": {
					if (!selectedKb) {
						await notifyKbSelectionStatus(ctx);
						return;
					}
					const parts = rest.trim().split(/\s+/);
					const urlArg = parts[0] ?? "";
					const subPathArg = parts.length > 1 ? parts.slice(1).join("/") : undefined;
					if (!urlArg) {
						ctx.ui.notify("Usage: /rag addGithubUrl <github_url> [subpath]", "warning");
						return;
					}
					const label = subPathArg ? `${urlArg} (${subPathArg})` : urlArg;
					ctx.ui.notify(`Cloning ${label} and indexing into KB '${selectedKb}'...`, "info");
					const githubResult = await ragAddGithubUrl(urlArg, selectedKb, subPathArg);
					if (!githubResult.ok) {
						ctx.ui.notify(githubResult.error, "error");
						return;
					}
					await upsertGithubSource(selectedKb, urlArg, subPathArg);
					const summary = [
						`KB '${selectedKb}'`,
						`Added: ${githubResult.added.length}`,
						`Skipped: ${githubResult.skipped.length}`,
						`Failed: ${githubResult.failed.length}`,
					];
					if (githubResult.failed.length > 0) {
						const failedLines = githubResult.failed.slice(0, 5).map((x) => `- ${x.file}: ${x.error}`);
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
				case "schedule": {
					if (!selectedKb) {
						await notifyKbSelectionStatus(ctx);
						return;
					}
					const scheduleArg = rest.trim().toLowerCase();

					// Show current status when no arg
					if (!scheduleArg) {
						const current = await loadScheduleConfig(selectedKb);
						const presets = Object.entries(PRESET_SCHEDULES)
							.map(([k, v]) => `  ${k} → "${v.cron}" (${v.label})`)
							.join("\n");
						if (current) {
							const label = current.preset ? `${current.preset} (${current.cron})` : current.cron;
							ctx.ui.notify(
								`KB '${selectedKb}' is scheduled: ${label}\nCreated: ${current.createdAt}\n\nOptions: daily | weekly | hourly | <cron expr> | off\n${presets}`,
								"info",
							);
						} else {
							ctx.ui.notify(
								`KB '${selectedKb}' has no active schedule.\nOptions: daily | weekly | hourly | <cron expr> | off\n${presets}`,
								"info",
							);
						}
						return;
					}

					// Disable schedule
					if (scheduleArg === "off") {
						const current = await loadScheduleConfig(selectedKb);
						if (!current) {
							ctx.ui.notify(`KB '${selectedKb}' has no active schedule.`, "info");
							return;
						}
						await saveScheduleConfig(selectedKb, null);
						if (current.cronJobId) {
							pi.sendUserMessage(
								`[RAG Schedule] Please cancel the cron job with ID "${current.cronJobId}" for KB '${selectedKb}' using the CronDelete tool.`,
							);
						} else {
							ctx.ui.notify(`Schedule removed for KB '${selectedKb}'.`, "info");
						}
						return;
					}

					// Validate the KB has GitHub sources
					const allSources = await loadSources(selectedKb);
					const githubSources = allSources.filter((s) => s.type === "github");
					if (githubSources.length === 0) {
						ctx.ui.notify(
							`KB '${selectedKb}' has no GitHub sources to schedule.\nAdd one first with: /rag addGithubUrl <url>`,
							"warning",
						);
						return;
					}

					// Resolve cron expression
					let cron: string;
					let preset: string | undefined;

					if (scheduleArg in PRESET_SCHEDULES) {
						const p = PRESET_SCHEDULES[scheduleArg];
						cron = p.cron;
						preset = scheduleArg;
					} else {
						if (!isValidCronExpression(scheduleArg)) {
							ctx.ui.notify(
								`Invalid schedule. Use: daily | weekly | hourly | <5-field cron expr> | off\nExample: "0 9 * * 1-5" for weekdays at 9am`,
								"warning",
							);
							return;
						}
						cron = scheduleArg;
					}

					// Cancel any existing cron job before creating a new one
					const existingSchedule = await loadScheduleConfig(selectedKb);
					if (existingSchedule?.cronJobId) {
						pi.sendUserMessage(
							`[RAG Schedule] Before creating the new cron job, please cancel the existing cron job with ID "${existingSchedule.cronJobId}" for KB '${selectedKb}' using CronDelete.`,
						);
					}

					// Save schedule config (without cronJobId yet — the AI will fill it in)
					await saveScheduleConfig(selectedKb, {
						cron,
						...(preset ? { preset } : {}),
						createdAt: new Date().toISOString(),
					});

					const sourcesPath = join(getKnowledgeBaseDir(selectedKb), SOURCES_FILENAME);
					const label = preset ? `${preset} (${cron})` : cron;
					ctx.ui.notify(
						`Schedule "${label}" saved for KB '${selectedKb}'.\nSetting up cron job... (note: auto-expires after 7 days)`,
						"info",
					);

					pi.sendUserMessage(
						`[RAG Schedule] Please create a durable recurring cron job using CronCreate with these exact parameters:\n` +
						`- cron: "${cron}"\n` +
						`- recurring: true\n` +
						`- durable: true\n` +
						`- prompt: "Refresh RAG knowledge base '${selectedKb}'. Read sources from ${sourcesPath}, then for each GitHub source re-clone and re-index all files using the RAG HTTP API at ${getRagServerBase()}. Follow the RAG skill instructions."\n\n` +
						`After CronCreate returns the job ID, store it in ${sourcesPath} under the JSON key "schedule.cronJobId" using the Edit or Write tool (read the file first). Then notify the user the cron job is active.`,
					);
					return;
				}
				case "refresh": {
					if (!selectedKb) {
						await notifyKbSelectionStatus(ctx);
						return;
					}
					const sources = await loadSources(selectedKb);
					if (sources.length === 0) {
						ctx.ui.notify(
							`KB '${selectedKb}' has no tracked sources to refresh.\nSources are registered automatically when you use /rag addFile or /rag addGithubUrl.`,
							"info",
						);
						return;
					}
					ctx.ui.notify(`Refreshing ${sources.length} source(s) in KB '${selectedKb}'...`, "info");
					let totalAdded = 0;
					let totalSkipped = 0;
					const refreshErrors: string[] = [];
					for (const source of sources) {
						if (source.type === "github") {
							const label = source.subPath ? `${source.url} (${source.subPath})` : source.url;
							const res = await ragAddGithubUrl(source.url, selectedKb, source.subPath);
							if (!res.ok) {
								refreshErrors.push(`GitHub ${label}: ${res.error}`);
							} else {
								totalAdded += res.added.length;
								totalSkipped += res.skipped.length;
								res.failed.forEach((f) => refreshErrors.push(`${label} / ${f.file}: ${f.error}`));
								await upsertGithubSource(selectedKb, source.url, source.subPath);
							}
						} else if (source.type === "file") {
							if (!existsSync(source.sourcePath)) {
								refreshErrors.push(`File no longer exists: ${source.sourcePath}`);
								continue;
							}
							const res = await ragAdd(source.sourcePath, "/", selectedKb);
							if (!res.ok) {
								refreshErrors.push(`File ${source.sourcePath}: ${res.error}`);
							} else {
								totalAdded++;
								await upsertFileSource(selectedKb, source.sourcePath);
							}
						}
					}
					const summary = [
						`KB '${selectedKb}' refreshed`,
						`Added/Updated: ${totalAdded}`,
						`Skipped: ${totalSkipped}`,
					];
					if (refreshErrors.length > 0) {
						ctx.ui.notify(`${summary.join(" | ")}\nErrors:\n${refreshErrors.slice(0, 5).join("\n")}`, "warning");
					} else {
						ctx.ui.notify(summary.join(" | "), "info");
					}
					return;
				}
				case "addDrive": {
					if (!selectedKb) {
						await notifyKbSelectionStatus(ctx);
						return;
					}
					const urlArg = rest.trim();
					if (!urlArg) {
						ctx.ui.notify("Usage: /rag addDrive <google_drive_url>", "warning");
						return;
					}
					let driveUrl: string;
					try {
						driveUrl = normalizeGoogleDriveUrl(urlArg);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						ctx.ui.notify(msg, "warning");
						return;
					}
					ctx.ui.notify(`Downloading from Google Drive and indexing into KB '${selectedKb}'...`, "info");
					pi.sendUserMessage(buildRagDrivePrompt(driveUrl, selectedKb, getRagServerBase()));
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand: ${sub}. Try: addFile, addGroup, addGithubUrl, drive, search, list, remove, refresh, schedule`, "warning");
			}
		},
	});
}
