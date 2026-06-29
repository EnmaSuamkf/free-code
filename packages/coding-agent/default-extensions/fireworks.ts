/**
 * Fireworks AI provider for free-code (bundled default extension).
 *
 * Fireworks exposes an OpenAI-compatible API, so it is registered as an
 * `openai-completions` provider. The provider only appears when a Fireworks API key
 * is available — it is silent otherwise, so users who don't use Fireworks see nothing.
 *
 * Configuration (env vars, or in ~/.free-code/agent/.env):
 *   FIREWORKS_API_KEY   required — get it from the Fireworks dashboard ("Get API Key").
 *   FIREWORKS_BASE_URL  optional — defaults to https://api.fireworks.ai/inference/v1.
 *   FIREWORKS_MODELS    optional — comma/space-separated model ids to expose. Use the
 *                       exact `model` value from the dashboard, e.g.
 *                       "accounts/fireworks/models/kimi-k2p7-code" (serverless) or
 *                       "accounts/<acct>/deployments/<id>" (your dedicated deployment).
 *                       Defaults to the Kimi K2.7 Code serverless model.
 *
 * Note: function/tool calling requires a model whose endpoint supports it. Serverless
 * models tagged "Function calling" work out of the box; some dedicated deployments
 * return 400 on tool_choice unless tool calling is enabled for that deployment.
 */
import type { ExtensionAPI } from "@free/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://api.fireworks.ai/inference/v1";
const DEFAULT_MODEL_IDS = ["accounts/fireworks/models/kimi-k2p7-code"];

/** Read a var from process.env first, then ~/.free-code/agent/.env. */
function readEnvVar(name: string): string | undefined {
	if (process.env[name]) return process.env[name];
	const envPath = join(homedir(), ".free-code", "agent", ".env");
	if (!existsSync(envPath)) return undefined;
	try {
		for (const line of readFileSync(envPath, "utf-8").split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("#")) continue;
			const eq = t.indexOf("=");
			if (eq === -1 || t.slice(0, eq).trim() !== name) continue;
			let v = t.slice(eq + 1).trim();
			if (
				v.length >= 2 &&
				((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
			) {
				v = v.slice(1, -1);
			}
			return v || undefined;
		}
	} catch {
		// ignore unreadable .env
	}
	return undefined;
}

function resolveModelIds(): string[] {
	const raw = readEnvVar("FIREWORKS_MODELS");
	if (!raw) return DEFAULT_MODEL_IDS;
	const ids = raw
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return ids.length > 0 ? ids : DEFAULT_MODEL_IDS;
}

export default function fireworksProvider(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const apiKey = readEnvVar("FIREWORKS_API_KEY");
		if (!apiKey) return; // No key configured — stay silent.

		const baseUrl = readEnvVar("FIREWORKS_BASE_URL") ?? DEFAULT_BASE_URL;
		const ids = resolveModelIds();

		pi.registerProvider("fireworks", {
			baseUrl,
			apiKey,
			api: "openai-completions",
			authHeader: true,
			models: ids.map((id) => ({
				id,
				name: `${id.split("/").pop() ?? id} (Fireworks)`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 16384,
			})),
		});

		ctx.ui.notify(`Fireworks: ${ids.length} model(s) registered. Pick one with /model.`, "info");
	});
}
