/**
 * set_active_model + get_active_model extension
 *
 * Registers `set_active_model` so the LLM can switch the active model when the user
 * asks in natural language, and `get_active_model` to read the current session model
 * (for workflows that temporarily switch and restore).
 * Pairs with the existing `/model` slash command and the model picker — the
 * tool is the path the LLM uses; users keep the picker / slash command for
 * direct control.
 *
 * Semantics: the change takes effect on the NEXT user turn. The current turn
 * always finishes with the previous model, since `session.setModel` swaps the
 * model used for subsequent calls (see packages/coding-agent/src/core/agent-session.ts).
 * The tool result text says so explicitly so the LLM does not promise that the
 * already-streaming reply comes from the new model.
 *
 * Install:
 *   cp -R packages/coding-agent/examples/extensions/set-active-model ~/.free-code/agent/extensions/
 *   # or symlink:
 *   ln -s "$(pwd)/packages/coding-agent/examples/extensions/set-active-model" ~/.free-code/agent/extensions/set-active-model
 *
 * Verify (in any chat session): `/tools` should list `set_active_model` and
 * `get_active_model` under the extension group.
 */

import type { ExtensionAPI } from "@free/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "set_active_model",
		label: "Switch active model",
		promptSnippet:
			"set_active_model(provider, modelId): switch the session's active LLM for the next user turn when the user explicitly asks; the harness validates ids—call with the user's exact strings.",
		promptGuidelines: [
			"When the user explicitly asks to change the active model (including ids you do not recognize from training, e.g. newer Copilot names), you MUST call set_active_model with the exact provider and modelId from their message, UI tags like [github-copilot], or the picker—do not refuse as 'invalid' from memory alone.",
			"Do not pre-validate model names yourself; only the running agent has the configured catalog. If the pair is wrong, the tool error tells you what to fix.",
		],
		description:
			"Switch the active LLM for the next user turn. Use ONLY when the user EXPLICITLY asks to change the model (e.g. 'change the model to gemini-2.5-pro', 'cambia el modelo a claude-sonnet-4-5', 'cambia a gpt-5.4 [github-copilot]'). Do NOT call this when the user is merely discussing or asking about models. Prefer calling this tool with the user's exact provider/modelId rather than refusing—validation runs when the tool executes. The CURRENT turn always finishes with the previous model; the new model is used from the NEXT user turn onward.",
		parameters: Type.Object({
			provider: Type.String({
				description:
					"Provider id exactly as the user wrote it, as shown in the UI (e.g. tag [github-copilot]), or as in the model picker (e.g. 'google-vertex', 'openai', 'anthropic', 'github-copilot'). The harness checks this against the live registry when the tool runs.",
			}),
			modelId: Type.String({
				description:
					"Model id exactly as the user wrote it or as in the model picker (e.g. 'gemini-2.5-pro', 'claude-sonnet-4-5', 'gpt-5', 'gpt-5.4'). Do not substitute another id; if unsure, still use the user's string so the tool error can list valid options.",
			}),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const all = ctx.modelRegistry.getAvailable();
			const model = all.find((m) => m.provider === params.provider && m.id === params.modelId);
			if (!model) {
				const sameId = all.filter((m) => m.id === params.modelId);
				if (sameId.length > 0) {
					const provs = sameId
						.map((m) => m.provider)
						.sort()
						.join(", ");
					throw new Error(
						`Model id '${params.modelId}' is configured under provider(s) [${provs}], not '${params.provider}'. Re-call with one of those providers.`,
					);
				}
				const provs = [...new Set(all.map((m) => m.provider))].sort().join(", ") || "(none)";
				throw new Error(
					`Model not found: ${params.provider}/${params.modelId}. Configured providers with valid auth: ${provs}. Use the exact provider/modelId pair shown in the user's model picker.`,
				);
			}

			const ok = await pi.setModel(model);
			if (!ok) {
				throw new Error(
					`Cannot switch to ${model.id} [${model.provider}]: no API auth configured for that provider. Ask the user to run \`/login\` for ${model.provider} or set the matching env var, then retry.`,
				);
			}

			return {
				content: [
					{
						type: "text",
						text: `Switched active model to ${model.id} [${model.provider}] (${model.name}). The change takes effect from the next user turn; this turn finishes with the previous model.`,
					},
				],
				details: { provider: model.provider, modelId: model.id, name: model.name },
			};
		},
	});

	pi.registerTool({
		name: "get_active_model",
		label: "Read active model",
		description:
			"Return the session's current active model (provider + modelId + display name). Call BEFORE temporarily switching with set_active_model so you can restore the same model afterward. Safe to call anytime; takes no arguments.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const m = ctx.model;
			if (!m) {
				return {
					content: [
						{
							type: "text",
							text: "No active model is set for this session.",
						},
					],
					details: {},
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Active model: ${m.id} [${m.provider}] (${m.name}).`,
					},
				],
				details: { provider: m.provider, modelId: m.id, name: m.name },
			};
		},
	});
}
