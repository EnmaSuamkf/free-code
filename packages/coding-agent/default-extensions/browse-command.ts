import type { ExtensionAPI } from "@free/pi-coding-agent";

/** Matches the Chrome-debug landing URL used in the VS Code plugin for optional browse targets. */
const DEFAULT_BROWSE_URL = "https://www.google.com";

function normalizeAgentBrowserUrl(raw: string): string {
	const value = raw.trim();
	if (!value) throw new Error("Enter a URL to open.");
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error("Enter a valid URL, for example https://example.com.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http and https URLs can be opened by the browser agent.");
	}
	return url.toString();
}

/**
 * Same instructions as the VS Code plugin (`buildAgentBrowserPrompt`): CDP `agent_browser` open + snapshot.
 */
function buildAgentBrowserPrompt(url: string, instruction: string): string {
	const extra = instruction.trim();
	return [
		`Open ${url} in the running CDP browser with the agent_browser tool.`,
		'CRITICAL: this browser is reached over CDP, and the connection does NOT persist between calls. You MUST include ["--cdp", "http://127.0.0.1:9222", ...] AND sessionMode "fresh" on EVERY agent_browser call (navigate, snapshot, click, type, tab). If you drop --cdp or use sessionMode "auto", you land on a blank about:blank session instead of this Chrome.',
		`Go to the page by reusing the current tab: call agent_browser with args ["--cdp", "http://127.0.0.1:9222", "navigate", "${url}"] and sessionMode "fresh". Use "navigate" (reuses the tab), not "open" (which can leave an extra blank tab).`,
		'Then inspect it with args ["--cdp", "http://127.0.0.1:9222", "snapshot", "-i"] and sessionMode "fresh".',
		'If a snapshot comes back empty or shows about:blank, you are on the wrong tab: call ["--cdp","http://127.0.0.1:9222","tab","list"] (sessionMode "fresh"), then ["--cdp","http://127.0.0.1:9222","tab","<tID>"] for the real page, then snapshot -i again — all with --cdp + fresh.',
		"Keep controlling that same browser (always --cdp + sessionMode fresh) for clicks, typing, and navigation so the user can watch each action live.",
		extra
			? `User goal: ${extra}`
			: "User goal: wait for my next instruction after the initial snapshot.",
		"If the CDP connection fails or agent_browser is unavailable, explain that a browser with remote debugging on port 9222 must be running (use the plugin's browser button to launch it).",
	].join("\n");
}

export default function browseCommandExtension(pi: ExtensionAPI) {
	pi.registerCommand("browse", {
		description:
			"Visible browser via agent_browser: /browse [url] [goal] (optional URL defaults to Google; same idea as the plugin globe button)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			let urlRaw: string;
			let instruction = "";
			if (!trimmed) {
				urlRaw = DEFAULT_BROWSE_URL;
			} else {
				const firstSpace = trimmed.search(/\s/);
				if (firstSpace === -1) {
					urlRaw = trimmed;
				} else {
					urlRaw = trimmed.slice(0, firstSpace).trim();
					instruction = trimmed.slice(firstSpace + 1).trim();
				}
			}
			let url: string;
			try {
				url = normalizeAgentBrowserUrl(urlRaw);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "warning");
				return;
			}
			pi.sendUserMessage(buildAgentBrowserPrompt(url, instruction));
		},
	});
}
