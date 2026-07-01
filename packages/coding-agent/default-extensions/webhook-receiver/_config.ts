/**
 * Configuration for the webhook-receiver extension.
 *
 * Persisted to `<agentDir>/webhook-receiver.json`. Environment variables
 * override the persisted values at load time (useful for one-off runs / CI):
 *   FREECODE_WEBHOOK_ENABLED, FREECODE_WEBHOOK_PORT, FREECODE_WEBHOOK_HOST,
 *   FREECODE_WEBHOOK_PUBLIC_URL
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@free/pi-coding-agent";

export type HookMode = "queue" | "trigger";

export interface HookConfig {
	mode: HookMode;
	/** Shared secret expected in the `X-Webhook-Secret` header. */
	secret?: string;
	/** Secret used to verify an HMAC-SHA256 signature of the raw body (`X-Signature: sha256=<hex>`). */
	hmacSecret?: string;
}

export interface WebhookConfig {
	enabled: boolean;
	host: string;
	/** Base port. Each session binds the first free port from here upward (see portRange). */
	port: number;
	/** How many consecutive ports to try before giving up (base .. base+portRange-1). */
	portRange: number;
	publicBaseUrl: string | null;
	defaultMode: HookMode;
	maxBodyBytes: number;
	hooks: Record<string, HookConfig>;
}

const DEFAULTS: WebhookConfig = {
	enabled: true,
	host: "127.0.0.1",
	port: 8787,
	portRange: 20,
	publicBaseUrl: null,
	defaultMode: "queue",
	maxBodyBytes: 1024 * 1024,
	hooks: {},
};

function configFile(): string {
	return path.join(getAgentDir(), "webhook-receiver.json");
}

function envBool(value: string | undefined): boolean | undefined {
	if (value == null) return undefined;
	return /^(1|true|yes|on)$/i.test(value.trim());
}

export function loadConfig(): WebhookConfig {
	let fileCfg: Partial<WebhookConfig> = {};
	try {
		fileCfg = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<WebhookConfig>;
	} catch {
		// Missing/invalid config file → fall back to defaults.
	}

	const cfg: WebhookConfig = {
		...DEFAULTS,
		...fileCfg,
		hooks: { ...(fileCfg.hooks ?? {}) },
	};

	const enabled = envBool(process.env.FREECODE_WEBHOOK_ENABLED);
	if (enabled != null) cfg.enabled = enabled;
	if (process.env.FREECODE_WEBHOOK_PORT) {
		const port = Number(process.env.FREECODE_WEBHOOK_PORT);
		if (Number.isFinite(port) && port > 0) cfg.port = port;
	}
	if (process.env.FREECODE_WEBHOOK_HOST) cfg.host = process.env.FREECODE_WEBHOOK_HOST;
	if (process.env.FREECODE_WEBHOOK_PUBLIC_URL) cfg.publicBaseUrl = process.env.FREECODE_WEBHOOK_PUBLIC_URL;

	return cfg;
}

export function saveConfig(cfg: WebhookConfig): void {
	const file = configFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}
