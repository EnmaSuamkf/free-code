import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	getExpectedRagKnowledgeBaseDir,
	isExpectedRagKnowledgeBaseDir,
	resolveRagServerProjectDir,
} from "../src/rag-server-launch.js";

describe("resolveRagServerProjectDir", () => {
	const originalEnv = process.env.FREE_CODE_RAG_SERVER_DIR;
	const originalLegacyEnv = process.env.EDO_RAG_SERVER_DIR;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.FREE_CODE_RAG_SERVER_DIR;
		} else {
			process.env.FREE_CODE_RAG_SERVER_DIR = originalEnv;
		}
		if (originalLegacyEnv === undefined) {
			delete process.env.EDO_RAG_SERVER_DIR;
		} else {
			process.env.EDO_RAG_SERVER_DIR = originalLegacyEnv;
		}
	});

	test("prefers FREE_CODE_RAG_SERVER_DIR when set", () => {
		process.env.FREE_CODE_RAG_SERVER_DIR = "/custom/rag/project";
		expect(resolveRagServerProjectDir("/ignored/agent")).toBe("/custom/rag/project");
	});

	test("falls back to legacy EDO_RAG_SERVER_DIR when set", () => {
		delete process.env.FREE_CODE_RAG_SERVER_DIR;
		process.env.EDO_RAG_SERVER_DIR = "/legacy/rag/project";
		expect(resolveRagServerProjectDir("/ignored/agent")).toBe("/legacy/rag/project");
	});

	test("reads path from agent rag-server-dir file when env unset", () => {
		delete process.env.FREE_CODE_RAG_SERVER_DIR;
		delete process.env.EDO_RAG_SERVER_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "rag-agent-"));
		const ragPath = join(agentDir, "my-rag");
		writeFileSync(join(agentDir, "rag-server-dir"), `${ragPath}\n`, "utf-8");
		expect(resolveRagServerProjectDir(agentDir)).toBe(ragPath);
	});

	test("recognizes migrated FreeCode knowledge base directory", () => {
		expect(getExpectedRagKnowledgeBaseDir()).toBe(join(homedir(), ".free-code", "knowledgeBase"));
		expect(isExpectedRagKnowledgeBaseDir(join(homedir(), ".free-code", "knowledgeBase"))).toBe(true);
		expect(isExpectedRagKnowledgeBaseDir(join(homedir(), ".edo-code", "knowledgeBase"))).toBe(false);
	});
});
