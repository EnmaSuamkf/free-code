import { describe, expect, it } from "vitest";
import type { ToolInfo } from "../src/core/extensions/types.js";
import {
	applyToolPickerSelection,
	BUILTIN_TOOL_NAMES,
	getToolPickerState,
	groupOptionalToolsBySource,
} from "../src/core/tool-picker-groups.js";

function tool(name: string, path: string, desc = "d"): ToolInfo {
	return {
		name,
		description: desc,
		sourceInfo: { path, source: "extension", scope: "user", origin: "top-level" },
	} as ToolInfo;
}

describe("tool-picker-groups", () => {
	it("groups MCP tools by server name in description", () => {
		const mcpPath = "/x/agent/extensions/mcp-client.ts";
		const tools: ToolInfo[] = [
			...["read", "bash"].map((n) => tool(n, "/core")),
			tool("a1", mcpPath, "[myserver] do thing"),
			tool("a2", mcpPath, "[myserver] do other"),
		];
		const g = groupOptionalToolsBySource(tools);
		expect(
			g
				.get("MCP: myserver")
				?.map((t) => t.name)
				.sort(),
		).toEqual(["a1", "a2"]);
	});

	it("applyToolPickerSelection keeps builtins and adds enabled groups only", () => {
		const mcpPath = "/e/mcp-client.ts";
		const tools: ToolInfo[] = [
			tool("read", "/b"),
			tool("bash", "/b"),
			tool("m1", mcpPath, "[s] a"),
			tool("m2", mcpPath, "[s] b"),
		];
		const current = ["read", "bash", "m1", "m2"];
		const next = applyToolPickerSelection(tools, current, new Set());
		expect(new Set(next)).toEqual(new Set(["read", "bash"]));
		const next2 = applyToolPickerSelection(tools, ["read", "bash"], new Set(["MCP: s"]));
		expect(new Set(next2)).toEqual(new Set(["read", "bash", "m1", "m2"]));
	});

	it("keeps bundled always-on extension tools active and out of toggleable groups", () => {
		const tools: ToolInfo[] = [
			tool("read", "/b"),
			tool("questionnaire", "/e/questionnaire.ts"),
			tool("subagent_create", "/e/subagent-widget.ts"),
			tool("optional", "/e/optional.ts"),
		];
		const state = getToolPickerState(tools, ["read"]);

		expect(state.groups.map((g) => g.key)).toEqual(["Extension: optional"]);
		expect(new Set(state.alwaysOnToolNames)).toEqual(new Set(["questionnaire", "subagent_create"]));
		expect(new Set(applyToolPickerSelection(tools, ["read"], new Set()))).toEqual(
			new Set(["read", "questionnaire", "subagent_create"]),
		);
	});

	it("getToolPickerState marks group enabled if any tool active", () => {
		const mcpPath = "/e/mcp-client.ts";
		const tools: ToolInfo[] = [tool("read", "/b"), tool("m1", mcpPath, "[s]")];
		const s = getToolPickerState(tools, ["read", "m1"]);
		expect(s.groups[0].enabled).toBe(true);
		expect(s.builtinActive.every((n) => BUILTIN_TOOL_NAMES.has(n))).toBe(true);
	});
});
