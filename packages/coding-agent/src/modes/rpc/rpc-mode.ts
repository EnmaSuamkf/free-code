/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import { getAgentPickerSnapshot } from "../../core/agent-picker-state.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	QuestionnaireDialogResult,
} from "../../core/extensions/index.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { getSkillPickerSnapshot, parseSkillBlocks } from "../../core/skill-picker-state.js";
import { applyToolPickerSelection, getToolPickerState } from "../../core/tool-picker-groups.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcAgentPickerState,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSkillPickerState,
	RpcSlashCommand,
	RpcToolPickerState,
} from "./rpc-types.js";

/**
 * Slash commands listed by RPC `get_commands` (free-code RPC / VS Code catalog).
 * Prompt templates and skills are omitted; other extension commands stay available but are not advertised.
 */
const RPC_GET_COMMANDS_ALLOWLIST = new Set([
	"session",
	"tools",
	"pick-tools",
	"files",
	"pick-agent",
	"pick-skill",
	"commands",
	"browse",
	"gemini",
	"sh",
	"pick-theme",
	"profile",
	"mode",
	"sub",
	"login",
	"logout",
	"mcp",
	"mcp-import",
	"webhook",
	"codeGraph-index",
	"codeGraph-symbols",
	"codeGraph-callers",
	"codeGraph-context",
	"vision",
	"see",
	"voice",
]);

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSkillPickerState,
	RpcToolPickerState,
} from "./rpc-types.js";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		hasInteractiveUI: false,
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		openExternal(url: string): void {
			const trimmed = String(url || "").trim();
			if (!trimmed) return;
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "open_external",
				url: trimmed,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		setTerminalMouseReporting(_enabled: boolean): void {
			// Mouse reporting requires a host terminal
		},

		placeCaretFromTerminalCell(_col: number, _row: number): boolean {
			return false;
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		questionnaire: (questions, opts) =>
			createDialogPromise<QuestionnaireDialogResult>(
				opts,
				{ answers: [], cancelled: true },
				{ method: "questionnaire", questions, timeout: opts?.timeout },
				(response) => {
					if ("cancelled" in response && response.cancelled === true) {
						return {
							answers: [],
							cancelled: true,
							unsupported: "unsupported" in response ? response.unsupported === true : false,
						};
					}
					if ("answers" in response && Array.isArray(response.answers)) {
						return { answers: response.answers, cancelled: false };
					}
					return { answers: [], cancelled: true };
				},
			),

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// RPC mode has no TUI to theme; the GUI host (macOS app, VS Code
			// webview) controls its own appearance. Treat applying a theme as a
			// silent no-op success so profile application doesn't surface a
			// spurious "Theme switching not supported" startup warning.
			return { success: true };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (options) => {
					const result = await runtimeHost.newSession(options);
					if (!result.cancelled) {
						await rebindSession();
					}
					return result;
				},
				fork: async (entryId) => {
					const result = await runtimeHost.fork(entryId);
					if (!result.cancelled) {
						await rebindSession();
					}
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath) => {
					const result = await runtimeHost.switchSession(sessionPath);
					if (!result.cancelled) {
						await rebindSession();
					}
					return result;
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			output(event);
		});
	};

	await rebindSession();

	// Emit startup warning if no model is available (no credentials configured)
	if (runtimeHost.modelFallbackMessage) {
		output({
			type: "extension_ui_request",
			id: crypto.randomUUID(),
			method: "notify",
			message: runtimeHost.modelFallbackMessage,
			notifyType: "warning",
		} as RpcExtensionUIRequest);
	}

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
					})
					.catch((e) => output(error(id, "prompt", e.message)));
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "export_markdown": {
				const path = session.exportToMarkdown(command.outputPath);
				return success(id, "export_markdown", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) {
					if (!RPC_GET_COMMANDS_ALLOWLIST.has(command.invocationName)) continue;
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			case "get_tool_picker_state": {
				const tools = session.getAllTools();
				const activeToolNames = session.getActiveToolNames();
				const snap = getToolPickerState(tools, activeToolNames);
				const data: RpcToolPickerState = {
					groups: snap.groups,
					builtinActive: snap.builtinActive,
					alwaysOnToolNames: snap.alwaysOnToolNames,
					activeToolNames,
				};
				return success(id, "get_tool_picker_state", data);
			}

			case "set_tool_picker": {
				const keys = command.enabledGroupKeys;
				if (!Array.isArray(keys)) {
					return error(id, "set_tool_picker", "enabledGroupKeys must be an array");
				}
				const tools = session.getAllTools();
				const current = session.getActiveToolNames();
				const enabled = new Set(keys.filter((k) => typeof k === "string"));
				const next = applyToolPickerSelection(tools, current, enabled);
				session.setActiveToolsByName(next);
				return success(id, "set_tool_picker");
			}

			case "get_skill_picker_state": {
				const systemPrompt = session.systemPrompt;
				const hidden = session.extensionRunner?.getResourceDisplayFilter()?.hiddenSkillNames;
				// Skills already loaded into the merged system prompt (with token estimates)
				const promptRows = getSkillPickerSnapshot(systemPrompt, hidden);
				const inPromptNames = new Set(promptRows.map((r) => r.name));
				// All skills available on disk — include ones not yet in the prompt as disabled
				const diskSkills = session.resourceLoader.getSkills().skills;
				const diskRows = diskSkills
					.filter((s) => !inPromptNames.has(s.name))
					.map((s) => ({
						name: s.name,
						description: s.description ?? "",
						tokensEstimated: 0,
						enabled: false,
					}));
				const data: RpcSkillPickerState = {
					skills: [
						...promptRows.map((r) => ({
							name: r.name,
							description: r.description,
							tokensEstimated: r.tokensEstimated,
							enabled: r.enabled,
						})),
						...diskRows,
					],
					hint: "Toggle skills to include or exclude their XML blocks from the system prompt sent to the model.",
				};
				return success(id, "get_skill_picker_state", data);
			}

			case "get_agent_picker_state": {
				const agentsFiles = session.resourceLoader.getAgentsFiles().agentsFiles;
				const filter = session.extensionRunner?.getResourceDisplayFilter();
				const rows = getAgentPickerSnapshot(agentsFiles, filter);
				const data: RpcAgentPickerState = {
					agents: rows.map((r) => ({
						name: r.name,
						description: r.description,
						tokensEstimated: r.tokensEstimated,
						enabled: r.enabled,
					})),
				};
				return success(id, "get_agent_picker_state", data);
			}

			case "set_agent_picker": {
				const runner = session.extensionRunner;
				if (!runner) {
					return error(id, "set_agent_picker", "Extension host unavailable");
				}
				const enabledInput = command.enabledAgentNames;
				if (!Array.isArray(enabledInput)) {
					return error(id, "set_agent_picker", "enabledAgentNames must be an array");
				}
				const enabledSet = new Set(enabledInput.filter((k): k is string => typeof k === "string"));
				const allAgents = getAgentPickerSnapshot([], runner.getResourceDisplayFilter());
				const prev = runner.getResourceDisplayFilter();
				runner.setResourceDisplayFilter({
					hiddenExtensionPaths: prev?.hiddenExtensionPaths,
					activeMcpServers: prev?.activeMcpServers,
					hiddenSkillNames: prev?.hiddenSkillNames,
					activeDiscoveredAgents: allAgents
						.filter((a) => enabledSet.has(a.name))
						.map((a) => ({ name: a.name, path: "" })),
				});
				return success(id, "set_agent_picker");
			}

			case "set_skill_picker": {
				const runner = session.extensionRunner;
				if (!runner) {
					return error(id, "set_skill_picker", "Extension host unavailable");
				}
				const enabledInput = command.enabledSkillNames;
				if (!Array.isArray(enabledInput)) {
					return error(id, "set_skill_picker", "enabledSkillNames must be an array");
				}
				const systemPrompt = session.systemPrompt;
				const parsedNames = parseSkillBlocks(systemPrompt).map((s) => s.name);
				const enabledSet = new Set(enabledInput.filter((k): k is string => typeof k === "string"));
				const hiddenSkillNames = new Set(parsedNames.filter((n) => !enabledSet.has(n)));
				const prev = runner.getResourceDisplayFilter();
				runner.setResourceDisplayFilter({
					hiddenExtensionPaths: prev?.hiddenExtensionPaths,
					activeMcpServers: prev?.activeMcpServers,
					activeDiscoveredAgents: prev?.activeDiscoveredAgents,
					hiddenSkillNames,
				});
				return success(id, "set_skill_picker");
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(): Promise<never> {
		unsubscribe?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		process.exit(0);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			output(response);
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
