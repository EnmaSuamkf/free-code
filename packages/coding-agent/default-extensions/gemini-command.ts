import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@free/pi-coding-agent";

const GEMINI_ASK_SKILL_NAME = "gemini-browser";
const GEMINI_DOWNLOAD_SKILL_NAME = "gemini-download";
const GEMINI_USAGE =
	"Usage: /gemini ask <mensaje> | /gemini download <nombre_del_archivo> | /gemini open [chat_id]";

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---\n")) {
		return content.trim();
	}

	const end = content.indexOf("\n---\n", 4);
	if (end === -1) {
		return content.trim();
	}

	return content.slice(end + "\n---\n".length).trim();
}

function stripWrappingQuotes(input: string): string {
	const trimmed = input.trim();
	if (trimmed.length < 2) {
		return trimmed;
	}

	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return trimmed.slice(1, -1).trim();
	}

	return trimmed;
}

export default function geminiCommandExtension(pi: ExtensionAPI) {
	pi.registerCommand("gemini", {
		description:
			"Gemini commands via skills: /gemini ask <mensaje> | /gemini download <archivo> | /gemini open [chat_id]",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			const firstWhitespace = trimmedArgs.search(/\s/);
			const subcommand = firstWhitespace === -1 ? trimmedArgs : trimmedArgs.slice(0, firstWhitespace);
			const rest = firstWhitespace === -1 ? "" : trimmedArgs.slice(firstWhitespace + 1).trim();
			const isAsk = subcommand === "ask";
			const isDownload = subcommand === "download";
			const isOpen = subcommand === "open";
			if (!isAsk && !isDownload && !isOpen) {
				ctx.ui.notify(GEMINI_USAGE, "warning");
				return;
			}
			const promptInput = stripWrappingQuotes(rest);
			if ((isAsk || isDownload) && !promptInput) {
				ctx.ui.notify(GEMINI_USAGE, "warning");
				return;
			}

			if (isOpen) {
				const normalizedChatId = promptInput.replace(/^\/+|\/+$/g, "");
				const targetUrl = normalizedChatId
					? `https://gemini.google.com/app/${normalizedChatId}`
					: "https://gemini.google.com/app";
				pi.sendUserMessage(
					[
						"Execute agent_browser with exactly these params:",
						"```json",
						JSON.stringify(
							{
								args: ["--cdp", "http://127.0.0.1:9222", "navigate", targetUrl],
								sessionMode: "fresh",
							},
							null,
							2,
						),
						"```",
						'CRITICAL: this browser is reached over CDP and the connection does NOT persist between calls. Include ["--cdp", "http://127.0.0.1:9222", ...] AND sessionMode "fresh" on EVERY follow-up agent_browser call (snapshot, click, type, tab). If you drop --cdp or use sessionMode "auto", you land on a blank about:blank session instead of this Chrome. Use "navigate" (reuses the tab), not "open" (which can leave an extra blank tab).',
						'If a snapshot comes back empty or shows about:blank, you are on the wrong tab: call ["--cdp","http://127.0.0.1:9222","tab","list"] (sessionMode "fresh"), then ["--cdp","http://127.0.0.1:9222","tab","<tID>"] for the Gemini page, then snapshot -i again — all with --cdp + fresh.',
					].join("\n"),
				);
				return;
			}

			const skillName = isAsk ? GEMINI_ASK_SKILL_NAME : GEMINI_DOWNLOAD_SKILL_NAME;
			const skillPath = join(getAgentDir(), "skills", skillName, "SKILL.md");
			const skillBody = stripFrontmatter(readFileSync(skillPath, "utf-8"));
			const skillBlock = [
				`<skill name="${skillName}" location="${skillPath}">`,
				`References are relative to ${dirname(skillPath)}.`,
				"",
				skillBody,
				"</skill>",
			].join("\n");

			pi.sendUserMessage(
				isAsk
					? [
							skillBlock,
							"",
							"Use the gemini-browser skill for this combined write-and-send request.",
							'This browser is reached over CDP: EVERY agent_browser call below MUST include ["--cdp", "http://127.0.0.1:9222", ...] and sessionMode "fresh". Do not use `agent_browser` batch or `agent_browser wait`.',
							"Gemini's prompt is a contenteditable editor, so set the text with real keystrokes, not by setting a value:",
							'1. Focus the editor: click `[data-test-id="textarea-inner"]`.',
							'2. Type the exact message with `type` on `[data-test-id="textarea-inner"]` (use `type`, NOT `fill` — `fill` can leave the visible editor empty so the Send button never appears).',
							'3. Confirm with `snapshot -i`: the editor must now contain the text AND a `Send message` button must be present. If the prompt is still empty, or only `Microphone` is enabled with no `Send message` button, the text did not register — report the write failure and STOP. NEVER click `Microphone`.',
							'4. Send by clicking `[data-mat-icon-name="send"]` exactly once. NEVER press Return/Enter to send — Enter does not submit reliably in Gemini and leaves the text sitting in the input.',
							"5. After sending, run the post-send blocking bash `sleep 20` plus `agent_browser snapshot -i` cycle until Gemini answers or the attempt limit is reached.",
							"Gemini is still answering while `fonticon=\"stop\"` is present. Do not finish until a post-send snapshot shows that the stop icon has disappeared and the response is visible.",
							"",
							"Exact message:",
							"```text",
							promptInput,
							"```",
						].join("\n")
					: [
							skillBlock,
							"",
							"Use the gemini-download skill for this request.",
							"Use `agent_browser` only and follow the skill workflow: snapshot, open attachment, snapshot again, click `Download` in viewer.",
							"Do not reuse stale refs from previous snapshots.",
							"",
							"Target filename:",
							"```text",
							promptInput,
							"```",
						].join("\n"),
			);
		},
	});
}
