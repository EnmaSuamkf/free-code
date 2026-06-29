/**
 * LM Studio provider for free-code (bundled default extension).
 *
 * Registers an OpenAI-compatible provider pointing at LM Studio's local server and
 * auto-discovers whatever models are currently loaded (GET /v1/models). It only
 * registers when the server responds, so users who don't run LM Studio see nothing.
 * Start the server in LM Studio (Developer tab → Start Server), then pick a model
 * with /model.
 *
 * Override the endpoint with LMSTUDIO_BASE_URL if you changed the port.
 */
import type { ExtensionAPI } from "@free/pi-coding-agent";

const LM_STUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";

export default function lmStudioProvider(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		let ids: string[] = [];
		try {
			const res = await fetch(`${LM_STUDIO_BASE_URL}/models`, {
				signal: AbortSignal.timeout(3000),
			});
			if (!res.ok) return;
			const data = (await res.json()) as { data?: Array<{ id?: string }> };
			ids = (data.data ?? [])
				.map((m) => m.id ?? "")
				.filter(Boolean)
				// Skip embedding models — they can't be used for chat.
				.filter((id) => !/embed/i.test(id));
		} catch {
			// LM Studio server not running / unreachable — skip silently.
			return;
		}
		if (ids.length === 0) return;

		pi.registerProvider("lmstudio", {
			baseUrl: LM_STUDIO_BASE_URL,
			// LM Studio ignores the key, but the provider requires a non-empty one.
			apiKey: "lm-studio",
			api: "openai-completions",
			models: ids.map((id) => ({
				id,
				name: `${id} (LM Studio)`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 4096,
				// Local OpenAI-compatible servers usually don't support the `developer`
				// role or `reasoning_effort` — send a plain system message instead.
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			})),
		});

		ctx.ui.notify(
			`LM Studio: ${ids.length} model(s) registered from ${LM_STUDIO_BASE_URL}. Pick one with /model (provider "lmstudio").`,
			"info",
		);
	});
}
