import type { ExtensionAPI } from "@free/pi-coding-agent";

const ACTIVE_TOOLS_ENV = "FREE_CODE_SUBAGENT_ACTIVE_TOOLS";

function parseToolNames(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_resources_ready", async () => {
		const toolNames = parseToolNames(process.env[ACTIVE_TOOLS_ENV]);
		if (toolNames.length === 0) return;
		pi.setActiveTools(toolNames);
	});
}
