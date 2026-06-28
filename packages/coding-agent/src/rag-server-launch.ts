/**
 * Optionally starts the local Python RAG server (free-code-rag) when free-code starts,
 * if it is not already listening and a project directory was resolved.
 *
 * Path resolution (first match):
 * 1. FREE_CODE_RAG_SERVER_DIR
 * 2. ~/.free-code/agent/rag-server-dir (single line, absolute path)
 * 3. Sibling directory ../free-code-rag next to the free-code git checkout (packages/coding-agent -> repo root)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getPackageDir } from "./config.js";

const DEFAULT_RAG_BASE = "http://localhost:8085";

export function getExpectedRagKnowledgeBaseDir(): string {
	return join(homedir(), CONFIG_DIR_NAME, "knowledgeBase");
}

export function isExpectedRagKnowledgeBaseDir(actualDir: string): boolean {
	return resolve(actualDir) === resolve(getExpectedRagKnowledgeBaseDir());
}

function readEnv(primary: string, legacy?: string): string | undefined {
	const raw = process.env[primary]?.trim() || (legacy ? process.env[legacy]?.trim() : undefined);
	return raw && raw.length > 0 ? raw : undefined;
}

function getRagServerBaseUrl(): string {
	const base = readEnv("FREE_CODE_RAG_SERVER_URL", "EDO_RAG_SERVER_URL") ?? DEFAULT_RAG_BASE;
	return base.replace(/\/$/, "");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRagAutoDisabled(): boolean {
	const v = readEnv("FREE_CODE_RAG_SERVER_AUTO", "EDO_RAG_SERVER_AUTO")?.toLowerCase();
	return v === "0" || v === "false" || v === "no" || v === "off";
}

function readAgentRagServerDirFile(agentDir: string): string | undefined {
	const path = join(agentDir, "rag-server-dir");
	try {
		const text = readFileSync(path, "utf-8").trim();
		if (text.length === 0) return undefined;
		return text;
	} catch {
		return undefined;
	}
}

function resolveSiblingFreeCodeRag(packageDir: string): string | undefined {
	const repoRoot = dirname(dirname(packageDir));
	const sibling = join(repoRoot, "free-code-rag");
	const mainPy = join(sibling, "main.py");
	const req = join(sibling, "requirements.txt");
	if (existsSync(mainPy) && existsSync(req)) {
		return sibling;
	}
	return undefined;
}

/**
 * Returns the absolute path to the RAG Python project root (contains main.py and requirements.txt), or undefined.
 */
export function resolveRagServerProjectDir(agentDir: string): string | undefined {
	const envDir = readEnv("FREE_CODE_RAG_SERVER_DIR", "EDO_RAG_SERVER_DIR");
	if (envDir) {
		return envDir;
	}
	const fromFile = readAgentRagServerDirFile(agentDir);
	if (fromFile) {
		return fromFile;
	}
	return resolveSiblingFreeCodeRag(getPackageDir());
}

async function isRagServerListening(baseUrl: string): Promise<boolean> {
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 2500);
		const res = await fetch(`${baseUrl}/query?text=ping`, { signal: ac.signal });
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

async function getRagServerKnowledgeBaseDir(baseUrl: string): Promise<string | undefined> {
	const base = baseUrl.replace(/\/$/, "");
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 2500);
		const res = await fetch(`${base}/health`, { signal: ac.signal });
		clearTimeout(timer);
		if (!res.ok) return undefined;
		const data = (await res.json()) as unknown;
		if (!data || typeof data !== "object" || !("knowledge_base_dir" in data)) return undefined;
		const value = (data as { knowledge_base_dir?: unknown }).knowledge_base_dir;
		return typeof value === "string" && value.trim().length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/** True if the server exposes GET /discover (current free-code-rag). Old binaries return 404 for this route. */
export async function ragServerSupportsDiscover(baseUrl: string): Promise<boolean> {
	const base = baseUrl.replace(/\/$/, "");
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 2500);
		const res = await fetch(`${base}/discover?kb=default`, { signal: ac.signal });
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

export type MaybeStartRagServerOptions = {
	agentDir: string;
};

/** Result of attempting to ensure the local RAG HTTP server is reachable (see `maybeStartRagServer`). */
export type RagServerLaunchResult =
	| {
			outcome: "skipped";
			reason: "auto_disabled" | "no_project" | "incomplete_project";
	  }
	| {
			outcome: "ok";
			baseUrl: string;
			projectDir: string;
			how: "already_listening" | "spawned";
	  }
	| {
			outcome: "incompatible_server";
			baseUrl: string;
			projectDir: string;
			expectedKnowledgeBaseDir: string;
			actualKnowledgeBaseDir?: string;
	  }
	| {
			outcome: "timeout";
			baseUrl: string;
			projectDir: string;
	  };

/**
 * If a RAG project directory is known, the server is not already up, and auto-start is allowed,
 * spawns `pip3 install -r requirements.txt && python3 main.py` in the background.
 */
export async function maybeStartRagServer(options: MaybeStartRagServerOptions): Promise<RagServerLaunchResult> {
	if (isRagAutoDisabled()) {
		return { outcome: "skipped", reason: "auto_disabled" };
	}
	const projectDir = resolveRagServerProjectDir(options.agentDir);
	if (!projectDir) {
		return { outcome: "skipped", reason: "no_project" };
	}
	const mainPy = join(projectDir, "main.py");
	const req = join(projectDir, "requirements.txt");
	if (!existsSync(mainPy) || !existsSync(req)) {
		return { outcome: "skipped", reason: "incomplete_project" };
	}

	const baseUrl = getRagServerBaseUrl();
	if (await isRagServerListening(baseUrl)) {
		const actualKnowledgeBaseDir = await getRagServerKnowledgeBaseDir(baseUrl);
		if (!actualKnowledgeBaseDir || !isExpectedRagKnowledgeBaseDir(actualKnowledgeBaseDir)) {
			return {
				outcome: "incompatible_server",
				baseUrl,
				projectDir,
				expectedKnowledgeBaseDir: getExpectedRagKnowledgeBaseDir(),
				actualKnowledgeBaseDir,
			};
		}
		return { outcome: "ok", baseUrl, projectDir, how: "already_listening" };
	}

	// Prefer the venv created by the installer (install-free-code-mac.command). When it exists, deps and the
	// embedding model are already provisioned, so just launch — this avoids the first-run `pip install` +
	// model download that otherwise blows past the 90s readiness budget. Fall back to system python3 otherwise.
	const venvPython = join(projectDir, ".venv", "bin", "python");
	const startCmd = existsSync(venvPython)
		? "exec ./.venv/bin/python main.py"
		: "pip3 install -r requirements.txt && exec python3 main.py";

	const child = spawn("bash", ["-lc", startCmd], {
		cwd: projectDir,
		detached: true,
		stdio: "ignore",
		env: process.env,
	});
	child.unref();

	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (await isRagServerListening(baseUrl)) {
			return { outcome: "ok", baseUrl, projectDir, how: "spawned" };
		}
		await sleep(400);
	}

	return { outcome: "timeout", baseUrl, projectDir };
}
