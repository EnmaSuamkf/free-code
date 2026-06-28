import { Type } from "@free/pi-ai";
import { type AgentToolResult, defineTool, type ExtensionAPI } from "@free/pi-coding-agent";
import { spawn } from "child_process";

const atlassianTool = defineTool({
	name: "jira",
	label: "Jira",
	description:
		"Interacts with the Atlassian MCP server to perform Jira actions. The input should be a JSON string for the MCP.",
	parameters: Type.Object({
		request: Type.String({
			description: "A JSON string representing the request to the Atlassian MCP server.",
		}),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<undefined>> {
		const command = "docker";
		const args = [
			"run",
			"--platform",
			"linux/amd64",
			"--rm",
			"-i",
			"--env-file",
			"/Users/pablo.castaneda/.env",
			"europe-west4-docker.pkg.dev/edo-mcplibrary-prod01/mcp-library/mcp-atlassian-oficial:latest",
		];

		return new Promise((resolve, reject) => {
			const mcpProcess = spawn(command, args);
			let output = "";
			let errorOutput = "";

			mcpProcess.stdout.on("data", (data) => {
				output += data.toString();
			});

			mcpProcess.stderr.on("data", (data) => {
				errorOutput += data.toString();
			});

			mcpProcess.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(`Atlassian MCP process exited with code ${code}: ${errorOutput}`));
				} else {
					resolve({
						content: [{ type: "text", text: output }],
						details: undefined,
					});
				}
			});

			mcpProcess.on("error", (err) => {
				reject(new Error(`Failed to start Atlassian MCP process: ${err.message}`));
			});

			// Write the JSON request to the process's stdin
			mcpProcess.stdin.write(params.request);
			mcpProcess.stdin.end();
		});
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(atlassianTool);
}
