import type { ExtensionAPI } from "@free/pi-coding-agent";

const DRIVE_USAGE = "Usage: /drive download <url>";

function normalizeUrl(raw: string): string {
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

function buildDriveDownloadPrompt(url: string, projectDir: string): string {
	return [
		"Execute the following Google Drive download workflow using agent_browser only. Follow each step in order and do not skip steps.",
		"",
		"## Step 1 — Ask the user which format to download",
		"Before opening the browser, use AskUserQuestion to ask the user:",
		'  Question: "Which format would you like to download?"',
		"  Options:",
		'    - label: "PDF (.pdf)",   description: "Download as PDF Document"',
		'    - label: "Word (.docx)", description: "Download as Microsoft Word"',
		'    - label: "Text (.txt)",  description: "Download as plain text"',
		"Wait for the answer and record it as CHOSEN_FORMAT before doing anything else.",
		"",
		"## Step 2 — Open the document",
		"Open this URL in the existing browser session (already logged in to Google):",
		`  ${url}`,
		"Call agent_browser with:",
		'  args: ["--cdp", "http://127.0.0.1:9222", "open", "' + url + '"]',
		"Wait for the page to fully load.",
		"",
		"## Step 3 — Snapshot the page",
		'Call agent_browser with args ["snapshot", "-i"] to inspect the loaded document.',
		"Verify the document is open and the toolbar is visible before proceeding.",
		"",
		"## Step 4 — Open the File menu",
		'Click the element with id="docs-file-menu" to open the File menu.',
		'Call agent_browser with args ["click", "#docs-file-menu"].',
		'Then snapshot again with args ["snapshot", "-i"] to confirm the menu opened.',
		"",
		"## Step 5 — Click the Download menu item",
		'Find the element whose aria-label contains "Download" (it may appear as "Download d" or similar with a shortcut indicator).',
		"Click it using its ref from the snapshot.",
		'Then snapshot again with args ["snapshot", "-i"] to see the format submenu.',
		"",
		"## Step 6 — Click the chosen format",
		"Based on CHOSEN_FORMAT, find the submenu item whose aria-label CONTAINS the corresponding extension string and click it:",
		'  - PDF (.pdf)   → find element where aria-label contains ".pdf",  e.g. aria-label="PDF Document (.pdf)"',
		'  - Word (.docx) → find element where aria-label contains ".docx", e.g. aria-label="Microsoft Word (.docx)"',
		'  - Text (.txt)  → find element where aria-label contains ".txt",  e.g. aria-label="Plain text (.txt)"',
		"Use the CSS attribute-contains selector to target it, for example:",
		'  agent_browser click [aria-label*=".pdf"]',
		"If the CSS selector does not match, fall back to the ref from the snapshot for the item whose label visually shows the chosen extension.",
		"After clicking the format, do NOT assume the download started — always go to Step 7 and snapshot first to check for the multi-tab export dialog.",
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
		`find "$HOME/Downloads" -maxdepth 1 -newer /tmp/.drive_dl_ref -type f 2>/dev/null | head -5`,
		"```",
		"If that does not work, fall back to:",
		"```bash",
		`ls -t "$HOME/Downloads" | head -3`,
		"```",
		"Record the full absolute path of the downloaded file as DOWNLOADED_FILE.",
		"",
		"## Step 10 — Copy the file to the project",
		`Copy the downloaded file to the project directory: ${projectDir}`,
		"Run:",
		"```bash",
		`cp "$DOWNLOADED_FILE" "${projectDir}/"`,
		"```",
		"Confirm the copy succeeded by listing the file in the project directory.",
		"",
		"## Step 11 — Close the browser",
		'Call agent_browser with args ["close"] to close the browser session.',
		"",
		"## Hard rules",
		"- Use agent_browser for all browser actions. Do not use AppleScript or other automation.",
		"- Do not retry failed downloads. If a step fails, report what was observed and stop.",
		"- Never mutate DOM attributes (no setAttribute calls).",
		"- Resolve all paths to absolute paths — never use ~ in agent_browser download calls.",
		"- Report the final destination path of the copied file when done.",
	].join("\n");
}

export default function driveCommandExtension(pi: ExtensionAPI) {
	pi.registerCommand("drive", {
		description: "Google Drive download: /drive download <url>",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			const firstWhitespace = trimmedArgs.search(/\s/);
			const subcommand = firstWhitespace === -1 ? trimmedArgs : trimmedArgs.slice(0, firstWhitespace);
			const rest = firstWhitespace === -1 ? "" : trimmedArgs.slice(firstWhitespace + 1).trim();

			if (subcommand !== "download") {
				ctx.ui.notify(DRIVE_USAGE, "warning");
				return;
			}

			if (!rest) {
				ctx.ui.notify(DRIVE_USAGE, "warning");
				return;
			}

			let url: string;
			try {
				url = normalizeUrl(rest);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "warning");
				return;
			}

			pi.sendUserMessage(buildDriveDownloadPrompt(url, ctx.cwd));
		},
	});
}
