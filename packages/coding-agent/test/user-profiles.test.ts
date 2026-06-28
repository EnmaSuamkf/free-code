import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@free/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import type { ResourceDisplayFilter, ToolInfo } from "../src/core/extensions/types.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import {
	applyUserProfile,
	captureUserProfile,
	DEFAULT_PROFILE_ID,
	defaultSerializedProfile,
	ensureProfilesFileOnDisk,
	parseProfileArgs,
	readUserProfilesFile,
	visibleSkillNamesForPrompt,
} from "../src/core/user-profiles.js";

const prevAgentDir = process.env[ENV_AGENT_DIR];
let agentRoot: string;

beforeEach(() => {
	agentRoot = join(tmpdir(), `free-code-user-profiles-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(agentRoot, { recursive: true });
	process.env[ENV_AGENT_DIR] = agentRoot;
});

afterEach(() => {
	if (prevAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = prevAgentDir;
	}
	try {
		rmSync(agentRoot, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("parseProfileArgs", () => {
	it("parses list / info / use / save / create / delete", () => {
		expect(parseProfileArgs("")).toEqual({ kind: "interactive" });
		expect(parseProfileArgs("  ")).toEqual({ kind: "interactive" });
		expect(parseProfileArgs("list")).toEqual({ kind: "list" });
		expect(parseProfileArgs("info my-prof")).toEqual({ kind: "info", name: "my-prof" });
		expect(parseProfileArgs("use my-prof")).toEqual({ kind: "use", name: "my-prof" });
		expect(parseProfileArgs("save")).toEqual({ kind: "save", name: undefined });
		expect(parseProfileArgs("save x")).toEqual({ kind: "save", name: "x" });
		expect(parseProfileArgs("create foo")).toEqual({ kind: "create", name: "foo" });
		expect(parseProfileArgs("delete foo")).toEqual({ kind: "delete", name: "foo" });
	});

	it("returns errors for bad usage", () => {
		expect(parseProfileArgs("list extra").kind).toBe("error");
		expect(parseProfileArgs("info").kind).toBe("error");
		expect(parseProfileArgs("use").kind).toBe("error");
		expect(parseProfileArgs("use a b").kind).toBe("error");
		expect(parseProfileArgs("unknown").kind).toBe("error");
	});
});

describe("profiles.json I/O", () => {
	it("ensureProfilesFileOnDisk bootstraps default", () => {
		const f = ensureProfilesFileOnDisk();
		expect(f.version).toBe(1);
		expect(f.activeProfile).toBe(DEFAULT_PROFILE_ID);
		expect(f.profiles[DEFAULT_PROFILE_ID]).toEqual(defaultSerializedProfile());
		const path = join(agentRoot, "profiles.json");
		expect(readFileSync(path, "utf8")).toContain(DEFAULT_PROFILE_ID);
	});

	it("read normalizes default to empty preset", () => {
		const path = join(agentRoot, "profiles.json");
		mkdirSync(agentRoot, { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				activeProfile: "default",
				profiles: {
					default: {
						themeName: "nord",
						ragKnowledgeBase: "mykb",
						activeModel: { provider: "anthropic", id: "claude-3" },
						enabledOptionalToolGroupKeys: ["MCP: x"],
						hideAllSkills: false,
						hiddenSkillNames: ["a"],
						activeDiscoveredAgents: [{ name: "z", path: "/z" }],
					},
				},
			}),
		);
		const f = readUserProfilesFile();
		expect(f.profiles[DEFAULT_PROFILE_ID]).toEqual(defaultSerializedProfile());
	});
});

describe("visibleSkillNamesForPrompt", () => {
	const prompt =
		"<skill><name>rag</name><description></description></skill>" +
		"<skill><name>plan-workflow</name><description></description></skill>";

	it("returns only skills not in the hidden list", () => {
		const profile = {
			...defaultSerializedProfile(),
			hideAllSkills: false,
			hiddenSkillNames: ["plan-workflow"],
		};
		expect(visibleSkillNamesForPrompt(profile, prompt)).toEqual(["rag"]);
	});

	it("returns empty when all skills are hidden for the profile", () => {
		const profile = {
			...defaultSerializedProfile(),
			hideAllSkills: true,
			hiddenSkillNames: [],
		};
		expect(visibleSkillNamesForPrompt(profile, prompt)).toEqual([]);
	});
});

describe("applyUserProfile / captureUserProfile", () => {
	function mcpTool(name: string): ToolInfo {
		return {
			name,
			description: "[testserver] do thing",
			parameters: Type.Object({}),
			sourceInfo: createSyntheticSourceInfo(join(agentRoot, "mcp-client.ts"), { source: "test" }),
		};
	}

	it("round-trips optional MCP group and filter fields", async () => {
		const tools: ToolInfo[] = [
			{
				name: "read",
				description: "",
				parameters: Type.Object({}),
				sourceInfo: createSyntheticSourceInfo(join(agentRoot, "core.ts"), { source: "test" }),
			},
			mcpTool("testserver:tool1"),
		];
		let active = ["read"];
		let lastFilter: ResourceDisplayFilter | undefined;
		let setModelCalls = 0;
		const fakeModel = { provider: "test", id: "m1" } as Model<any>;
		const deps = {
			getAllTools: () => tools,
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
			setResourceDisplayFilter: (f: ResourceDisplayFilter) => {
				lastFilter = f;
			},
			getSystemPrompt: () => "<skill><name>s1</name><description></description></skill>",
			getResourceDisplayFilter: () => lastFilter,
			getModel: () => fakeModel,
		};

		await applyUserProfile(
			deps,
			{
				themeName: null,
				ragKnowledgeBase: null,
				activeModel: { provider: "test", id: "m1" },
				enabledOptionalToolGroupKeys: ["MCP: testserver"],
				hideAllSkills: true,
				hiddenSkillNames: [],
				activeDiscoveredAgents: [],
			},
			{
				resolveModel: (p, id) => (p === "test" && id === "m1" ? fakeModel : undefined),
				setModel: async () => {
					setModelCalls++;
					return true;
				},
			},
		);
		expect(active).toContain("testserver:tool1");
		expect(lastFilter?.activeMcpServers).toEqual(["testserver"]);
		expect(setModelCalls).toBe(1);

		const snap = captureUserProfile({ ...deps, getResourceDisplayFilter: () => lastFilter }, "dark");
		expect(snap.enabledOptionalToolGroupKeys).toContain("MCP: testserver");
		expect(snap.hideAllSkills).toBe(true);
		expect(snap.themeName).toBe("dark");
		expect(snap.activeModel).toEqual({ provider: "test", id: "m1" });
	});
});
