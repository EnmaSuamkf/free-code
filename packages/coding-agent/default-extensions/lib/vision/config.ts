/**
 * Vision extension configuration.
 *
 * Defaults are merged with a persisted JSON file at
 * `<agent-dir>/vision.json`, then overridden by environment variables and
 * (optionally) CLI flags registered by the extension.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CaptureBackend =
	| "auto"
	| "portal"
	| "grim"
	| "gnome-screenshot"
	| "spectacle"
	| "scrot"
	| "import"
	| "screencapture"
	| "powershell";

export type SttBackend = "auto" | "openai" | "groq" | "whisper-cpp";
export type TtsBackend = "auto" | "openai" | "espeak" | "say";
export type VoiceMode = "review" | "send";

export interface VisionConfig {
	captureBackend: CaptureBackend;
	/** Show the XDG portal interactive picker when using the portal backend. */
	captureInteractive: boolean;
	sttBackend: SttBackend;
	ttsBackend: TtsBackend;
	/** STT language code: "es", "en", or "auto". */
	language: string;
	sttModel: string;
	ttsModel: string;
	ttsVoice: string;
	/** Target width for downscaled captures (0 = keep the auto-resize default of 2000px). */
	captureMaxWidth: number;
	captureJpegQuality: number;
	/** Where the /voice transcript lands: "review" = input editor, "send" = submit immediately. */
	voiceMode: VoiceMode;
	/** Speak assistant responses aloud while live mode is active. */
	liveSpeak: boolean;
	/** Show the 👁 status indicator while live mode is active. */
	liveIndicator: boolean;
	/** Push-to-talk shortcut (empty = no shortcut registered). */
	shortcut: string;
	/** Max recording window for the /voice command, in milliseconds. */
	voiceCommandDuration: number;
	/** Max recording window for each live-mode turn, in milliseconds. */
	liveTurnMaxMs: number;
	/** Always capture screen on every live turn (true) or only when keywords detected (false). */
	liveAlwaysCapture: boolean;
	/** Wake word to activate live mode listening (empty = no wake word, always process). */
	liveWakeWord: string;
	/** Voice Activity Detection for live mode. */
	liveVad: boolean;
	/** Silence duration threshold in milliseconds for live mode. */
	liveSilenceMs: number;
	/** Energy threshold for voice detection in live mode. */
	liveEnergyThreshold: number;
}

export const DEFAULT_VISION_CONFIG: VisionConfig = {
	captureBackend: "auto",
	captureInteractive: true,
	sttBackend: "auto",
	ttsBackend: "auto",
	language: "auto",
	sttModel: "whisper-1",
	ttsModel: "tts-1",
	ttsVoice: "alloy",
	captureMaxWidth: 1568,
	captureJpegQuality: 70,
	voiceMode: "review",
	liveSpeak: true,
	liveIndicator: true,
	shortcut: "ctrl+alt+v",
	voiceCommandDuration: 6000,
	liveTurnMaxMs: 8000,
	liveAlwaysCapture: false,
	liveWakeWord: "auto",
	liveVad: true,
	liveSilenceMs: 2000,
	liveEnergyThreshold: 0.015,
};

const ENV_MAP: Partial<Record<keyof VisionConfig, string>> = {
	captureBackend: "VISION_CAPTURE_BACKEND",
	captureInteractive: "VISION_CAPTURE_INTERACTIVE",
	sttBackend: "VISION_STT_BACKEND",
	ttsBackend: "VISION_TTS_BACKEND",
	language: "VISION_LANGUAGE",
	sttModel: "VISION_STT_MODEL",
	ttsModel: "VISION_TTS_MODEL",
	ttsVoice: "VISION_TTS_VOICE",
	captureMaxWidth: "VISION_CAPTURE_MAX_WIDTH",
	captureJpegQuality: "VISION_CAPTURE_JPEG_QUALITY",
	voiceMode: "VISION_VOICE_MODE",
	liveSpeak: "VISION_LIVE_SPEAK",
	liveIndicator: "VISION_LIVE_INDICATOR",
	shortcut: "VISION_SHORTCUT",
	voiceCommandDuration: "VISION_VOICE_COMMAND_DURATION",
	liveTurnMaxMs: "VISION_LIVE_TURN_MAX_MS",
	liveAlwaysCapture: "VISION_LIVE_ALWAYS_CAPTURE",
	liveWakeWord: "VISION_LIVE_WAKE_WORD",
};

export function visionConfigPath(agentDir?: string): string {
	const dir = agentDir ?? defaultAgentDir();
	return join(dir, "vision.json");
}

function defaultAgentDir(): string {
	return join(homedir(), ".free-code", "agent");
}

function parseValue(key: keyof VisionConfig, raw: string): unknown {
	switch (key) {
		case "captureInteractive":
		case "liveSpeak":
		case "liveIndicator":
		case "liveAlwaysCapture":
			return raw === "true" || raw === "1";
		case "captureMaxWidth":
		case "captureJpegQuality":
		case "voiceCommandDuration":
		case "liveTurnMaxMs":
			return Number.parseInt(raw, 10);
		default:
			return raw;
	}
}

function coerce(key: keyof VisionConfig, value: unknown): VisionConfig[keyof VisionConfig] | undefined {
	if (value === undefined || value === null) return undefined;
	const str = typeof value === "string" ? value : String(value);
	if (
		key === "captureInteractive" ||
		key === "liveSpeak" ||
		key === "liveIndicator" ||
		key === "liveAlwaysCapture"
	) {
		if (typeof value === "boolean") return value as boolean;
		return parseValue(key, str) as boolean;
	}
	if (
		key === "captureMaxWidth" ||
		key === "captureJpegQuality" ||
		key === "voiceCommandDuration" ||
		key === "liveTurnMaxMs"
	) {
		if (typeof value === "number") return value as number;
		return parseValue(key, str) as number;
	}
	return str;
}

/**
 * Load vision config: defaults ← persisted JSON ← env vars ← CLI flags.
 * `getFlag` is the extension's `pi.getFlag` (optional).
 */
export function loadVisionConfig(
	agentDir?: string,
	getFlag?: (name: string) => boolean | string | undefined,
): VisionConfig {
	const cfg: VisionConfig = { ...DEFAULT_VISION_CONFIG };

	const filePath = visionConfigPath(agentDir);
	try {
		if (existsSync(filePath)) {
			const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<VisionConfig>;
			for (const key of Object.keys(DEFAULT_VISION_CONFIG) as (keyof VisionConfig)[]) {
				const v = coerce(key, raw[key]);
				if (v !== undefined) (cfg as unknown as Record<string, unknown>)[key] = v;
			}
		}
	} catch {
		// Ignore malformed config; defaults remain.
	}

	for (const key of Object.keys(ENV_MAP) as (keyof VisionConfig)[]) {
		const envName = ENV_MAP[key];
		if (!envName) continue;
		const envVal = process.env[envName];
		if (envVal !== undefined && envVal !== "") {
			const v = coerce(key, parseValue(key, envVal));
			if (v !== undefined) (cfg as unknown as Record<string, unknown>)[key] = v;
		}
	}

	if (getFlag) {
		const flagMap: Partial<Record<keyof VisionConfig, string>> = {
			captureBackend: "vision-capture-backend",
			sttBackend: "vision-stt-backend",
			ttsBackend: "vision-tts-backend",
			language: "vision-language",
			voiceMode: "vision-voice-mode",
		};
		for (const key of Object.keys(flagMap) as (keyof VisionConfig)[]) {
			const flagName = flagMap[key];
			if (!flagName) continue;
			const flagVal = getFlag(flagName);
			if (flagVal !== undefined && flagVal !== "") {
				const v = coerce(key, flagVal);
				if (v !== undefined) (cfg as unknown as Record<string, unknown>)[key] = v;
			}
		}
	}

	return cfg;
}

export function saveVisionConfig(cfg: Partial<VisionConfig>, agentDir?: string): void {
	const filePath = visionConfigPath(agentDir);
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		const merged = { ...loadVisionConfig(agentDir), ...cfg };
		writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
	} catch {
		// Persisting config is best-effort.
	}
}
