/**
 * Vision mode for free-code — eyes (screen) and ears (voice).
 *
 * Ships three slash commands and one mode:
 *   /see [question]            — capture the screen, ask about it (Phase 1)
 *   /voice [question]          — push-to-talk: record, transcribe, ask (Phase 2)
 *   /vision                    — manage vision settings and backends
 *   /vision live [on|off]      — hands-free mode: capture + STT + TTS (Phase 3)
 *   /vision status|backends|config
 *
 * Built on the existing extension API: `pi.sendUserMessage` with `ImageContent`,
 * `pi.registerCommand`, `pi.registerShortcut`, `ctx.ui.setStatus`/`setEditorText`,
 * `pi.on` events, and `pi.appendEntry`. The only core change is exposing
 * `resizeImage` from `@free/pi-coding-agent`.
 *
 * See `analysis/vision-mode-plan.md` for the full investigation and design.
 */

import { resizeImage, type ExtensionAPI, type ExtensionContext } from "@free/pi-coding-agent";
import type { ImageContent, TextContent } from "@free/pi-ai";
import type { KeyId } from "@free/pi-tui";

import {
	DEFAULT_VISION_CONFIG,
	loadVisionConfig,
	saveVisionConfig,
	type CaptureBackend,
	type SttBackend,
	type TtsBackend,
	type VisionConfig,
	type VoiceMode,
} from "./lib/vision/config.ts";
import {
	captureScreen,
	cleanupCapture,
	isWaylandSession,
	listCaptureBackends,
} from "./lib/vision/capture.ts";
import {
	cleanupRecord,
	listRecorders,
	listSttBackends,
	recordMicrophone,
	transcribe,
	type RecordResult,
} from "./lib/vision/stt.ts";
import { listTtsBackends, speak, stopTts } from "./lib/vision/tts.ts";

const VISION_SUBCOMMANDS = ["live", "status", "backends", "config"] as const;
void VISION_SUBCOMMANDS;

interface LiveState {
	active: boolean;
	busy: boolean;
	captureAbort?: AbortController;
	ttsAbort?: AbortController;
}

function imageToContent(base64: string, mimeType: string): ImageContent {
	return { type: "image", data: base64, mimeType };
}

async function fileToImageContent(
	filePath: string,
	mimeType: string,
	cfg: VisionConfig,
): Promise<ImageContent> {
	const { readFileSync } = await import("node:fs");
	const raw = readFileSync(filePath);
	const base64 = raw.toString("base64");
	const opts =
		cfg.captureMaxWidth > 0
			? { maxWidth: cfg.captureMaxWidth, maxHeight: cfg.captureMaxWidth, jpegQuality: cfg.captureJpegQuality }
			: { jpegQuality: cfg.captureJpegQuality };
	const resized = await resizeImage(imageToContent(base64, mimeType), opts);
	if (!resized) {
		throw new Error(
			"Could not resize the screenshot (Photon unavailable). The photon-node WASM asset is missing.",
		);
	}
	return { type: "image", data: resized.data, mimeType: resized.mimeType };
}

export default function visionExtension(pi: ExtensionAPI): void {
	pi.registerFlag("vision-capture-backend", {
		description: "Screen-capture backend: auto|portal|grim|gnome-screenshot|spectacle|scrot|import|screencapture|powershell",
		type: "string",
	});
	pi.registerFlag("vision-stt-backend", {
		description: "STT backend: auto|openai|groq|whisper-cpp",
		type: "string",
	});
	pi.registerFlag("vision-tts-backend", {
		description: "TTS backend: auto|openai|espeak|say",
		type: "string",
	});
	pi.registerFlag("vision-language", {
		description: "Vision language code: es|en|auto",
		type: "string",
	});
	pi.registerFlag("vision-voice-mode", {
		description: "Where /voice transcript lands: review|send",
		type: "string",
	});

	const getCfg = (): VisionConfig =>
		loadVisionConfig(undefined, (name) => pi.getFlag(name));

	const live: LiveState = { active: false, busy: false };

	function resolveSttOpts(cfg: VisionConfig) {
		const apiKey =
			cfg.sttBackend === "groq" ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY;
		return {
			backend: cfg.sttBackend,
			language: cfg.language,
			model: cfg.sttModel,
			apiKey,
		};
	}

	function resolveTtsOpts(cfg: VisionConfig) {
		return {
			backend: cfg.ttsBackend,
			model: cfg.ttsModel,
			voice: cfg.ttsVoice,
			apiKey: process.env.OPENAI_API_KEY,
		};
	}

	// --- /see: capture the screen and ask about it --------------------------

	async function runSee(args: string, ctx: ExtensionContext): Promise<void> {
		const cfg = getCfg();
		const question = args.trim();
		if (!question) {
			ctx.ui.notify("Usage: /see <what do you want to ask about the screen?>", "warning");
			return;
		}
		ctx.ui.setStatus("vision", "👁 capturing…");
		let capture;
		try {
			capture = await captureScreen({
				backend: cfg.captureBackend,
				interactive: cfg.captureInteractive,
				timeoutMs: 20000,
			});
		} catch (err) {
			ctx.ui.setStatus("vision", undefined);
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return;
		}
		ctx.ui.setStatus("vision", "👁 resizing…");
		let image: ImageContent;
		try {
			image = await fileToImageContent(capture.filePath, capture.mimeType, cfg);
		} catch (err) {
			ctx.ui.setStatus("vision", undefined);
			cleanupCapture(capture);
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return;
		}
		cleanupCapture(capture);
		ctx.ui.setStatus("vision", undefined);

		const content: (TextContent | ImageContent)[] = [
			{ type: "text", text: `${question}\n\n(Screen captured via ${capture.backend}.)` },
			image,
		];
		pi.sendUserMessage(content);
	}

	// --- /voice: push-to-talk via command -----------------------------------

	async function runVoice(args: string, ctx: ExtensionContext): Promise<void> {
		const cfg = getCfg();
		const extra = args.trim();
		if (listRecorders().length === 0) {
			ctx.ui.notify(
				'No audio recorder found. Install "pw-record", "arecord", "sox", or "ffmpeg".',
				"error",
			);
			return;
		}

		const controller = new AbortController();
		ctx.ui.setStatus("vision", "🎙 recording… (stop with the push-to-talk shortcut)");
		ctx.ui.notify("Recording — say your question. Stop with the push-to-talk shortcut.", "info");

		let record;
		try {
			record = await recordMicrophone(controller.signal);
		} catch (err) {
			ctx.ui.setStatus("vision", undefined);
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return;
		}

		// Command form: record a fixed window, then transcribe.
		await new Promise<void>((r) => setTimeout(r, cfg.voiceCommandDuration));
		controller.abort();
		await record.stop();
		ctx.ui.setStatus("vision", "🎙 transcribing…");
		let text: string;
		try {
			text = await transcribe(record.wavPath, resolveSttOpts(cfg));
		} catch (err) {
			ctx.ui.setStatus("vision", undefined);
			cleanupRecord(record);
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return;
		} finally {
			cleanupRecord(record);
		}
		ctx.ui.setStatus("vision", undefined);

		// Reject Whisper hallucinations (silence/noise).
		if (isLikelyHallucination(text)) {
			ctx.ui.notify("No speech detected (hallucination filtered).", "warning");
			return;
		}

		// Ignore empty or noise-only transcriptions (punctuation, spaces).
		const cleaned = text.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ]/g, "");
		if (!cleaned || cleaned.length < 2) {
			ctx.ui.notify("No speech detected.", "warning");
			return;
		}

		const combined = extra ? `${text}\n\n(Context: ${extra})` : text;
		if (cfg.voiceMode === "send") {
			pi.sendUserMessage(combined);
		} else {
			ctx.ui.setEditorText(combined);
			ctx.ui.notify("Transcribed — review and press Enter to send.", "info");
		}
	}

	// --- /vision live: hands-free mode --------------------------------------

	function setLiveStatus(ctx: ExtensionContext): void {
		if (!live.active) {
			ctx.ui.setStatus("vision", undefined);
			return;
		}
		const label = live.busy ? "👁 live · listening…" : "👁 live · ready";
		ctx.ui.setStatus("vision", label);
	}

	function stopLiveCapture(): void {
		live.captureAbort?.abort();
		live.captureAbort = undefined;
	}

	function stopLiveTts(): void {
		stopTts(live.ttsAbort);
		live.ttsAbort = undefined;
	}

	async function liveTurn(ctx: ExtensionContext): Promise<void> {
		if (!live.active) return;
		if (live.busy) return;
		const wake = getCfg().liveWakeWord?.trim();
		// Handle empty or quote-only values (from config parsing)
		const isEmpty = !wake || wake === '""' || wake === "''";
		const msg = isEmpty ? "🎤 Listening..." : `🎤 Listening (say "${wake}" to activate)...`;
		ctx.ui.notify(msg, "info");
		const cfg = getCfg();
		live.busy = true;
		setLiveStatus(ctx);

		const controller = new AbortController();
		live.captureAbort = controller;
		let record;
		try {
			record = await recordMicrophone(controller.signal);
		} catch (err) {
			ctx.ui.notify(
				`Live mode recording failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			live.busy = false;
			setLiveStatus(ctx);
			return;
		}

		// Record up to liveTurnMaxMs; the PTT shortcut can abort sooner.
		await Promise.race([
			new Promise<void>((r) => setTimeout(r, cfg.liveTurnMaxMs)),
			new Promise<void>((r) => controller.signal.addEventListener("abort", () => r(), { once: true })),
		]);
		await record.stop();

		let text: string;
		try {
			text = await transcribe(record.wavPath, resolveSttOpts(cfg));
			ctx.ui.notify(`[DEBUG] Transcribed: "${text}"`, "info");

			// Reject common Whisper hallucinations (silence/noise transcribed as "Thank you.", etc.)
			if (isLikelyHallucination(text)) {
				ctx.ui.notify(`[DEBUG] Ignored hallucination: "${text}"`, "info");
				live.busy = false;
				setLiveStatus(ctx);
				void liveTurn(ctx);
				return;
			}
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			cleanupRecord(record);
			live.busy = false;
			setLiveStatus(ctx);
			return;
		} finally {
			cleanupRecord(record);
		}

		// Ignore empty transcriptions, noise, or just punctuation.
		const cleaned = text.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ]/g, "");
		if (!cleaned || cleaned.length < 2) {
			ctx.ui.notify(`[DEBUG] Ignored (too short): "${text}"`, "info");
			live.busy = false;
			setLiveStatus(ctx);
			// Continue listening for the next utterance.
			void liveTurn(ctx);
			return;
		}

		// Wake word detection: only process if text starts with the wake word (or no wake word set).
		if (cfg.liveWakeWord) {
			const normalized = normalizeForWake(text);
			const wakeWords = cfg.liveWakeWord.split(/\s*,\s*/).map(w => normalizeForWake(w));
			let matched = false;
			let originalWake = "";
			for (const wake of wakeWords) {
				if (normalized.startsWith(wake)) {
					matched = true;
					// Find where the wake word ends in the original text to strip it.
					// Count characters in wake, map back to original (accounting for spaces/hyphens).
					let charCount = 0;
					let i = 0;
					for (; i < text.length && charCount < wake.length; i++) {
						const c = text[i].toLowerCase();
						if (c !== " " && c !== "-") charCount++;
					}
					originalWake = text.slice(0, i);
					text = text.slice(i).trim();
					break;
				}
			}
			if (!matched) {
				// No wake word detected — ignore and continue listening.
				ctx.ui.notify(
					`[DEBUG] No wake word. Got: "${normalized}", expected: ${wakeWords.join(", ")}`,
					"info",
				);
				live.busy = false;
				setLiveStatus(ctx);
				void liveTurn(ctx);
				return;
			}
			if (!text) {
				// Only wake word, no actual command — acknowledge and continue.
				ctx.ui.notify("[DEBUG] Wake word only, no command", "info");
				live.busy = false;
				setLiveStatus(ctx);
				void liveTurn(ctx);
				return;
			}
			ctx.ui.notify(`[DEBUG] Wake word matched! Command: "${text}"`, "info");
		}

		// Capture a fresh frame only if the user asks for vision (or liveAlwaysCapture is on).
		const shouldCapture = cfg.liveAlwaysCapture || needsVision(text);
		let content: string | (TextContent | ImageContent)[];
		if (shouldCapture) {
			let capture;
			try {
				capture = await captureScreen({
					backend: cfg.captureBackend,
					interactive: false,
					timeoutMs: 15000,
				});
			} catch {
				capture = undefined;
			}
			if (capture) {
				try {
					const image = await fileToImageContent(capture.filePath, capture.mimeType, cfg);
					content = [{ type: "text", text }, image];
				} catch {
					content = text;
				} finally {
					cleanupCapture(capture);
				}
			} else {
				content = text;
			}
		} else {
			// No vision keywords detected — just send text.
			content = text;
		}

		pi.sendUserMessage(content, { deliverAs: "steer" });
		// busy stays true until agent_end → next turn.
	}

	function startLive(ctx: ExtensionContext): void {
		if (live.active) {
			ctx.ui.notify("Vision live mode is already active.", "info");
			return;
		}
		if (listRecorders().length === 0) {
			ctx.ui.notify(
				"Live mode needs an audio recorder (pw-record/arecord/sox/ffmpeg).",
				"error",
			);
			return;
		}
		live.active = true;
		live.busy = false; // Ensure clean state
		pi.appendEntry("vision-live-state", { active: true, startedAt: Date.now() });
		setLiveStatus(ctx);
		const cfg = getCfg();
		const wake = cfg.liveWakeWord?.trim();
		const isEmpty = !wake || wake === '""' || wake === "''";
		const wakeMsg = isEmpty ? " Say something." : ` Say "${wake}" to activate.`;
		ctx.ui.notify(`Vision live mode on.${wakeMsg} /vision live off to stop.`, "info");
		setTimeout(() => void liveTurn(ctx), 500); // Delay to ensure UI updates
	}

	function stopLive(ctx: ExtensionContext): void {
		if (!live.active) return;
		live.active = false;
		live.busy = false;
		stopLiveCapture();
		stopLiveTts();
		pi.appendEntry("vision-live-state", { active: false });
		ctx.ui.setStatus("vision", undefined);
		ctx.ui.notify("Vision live mode off.", "info");
	}

	// Speak assistant text while live (Phase 3).
	pi.on("message_end", async (event, ctx) => {
		const cfg = getCfg();
		if (!live.active || !cfg.liveSpeak) return;
		if (event.message?.role !== "assistant") return;
		const text = collectAssistantText(event.message);
		if (!text) return;
		stopLiveTts();
		const controller = new AbortController();
		live.ttsAbort = controller;
		try {
			await speak(text, { ...resolveTtsOpts(cfg), signal: controller.signal });
		} catch {
			// TTS is optional; ignore failures.
		}
	});

	// After the agent finishes a turn, listen again (continuous hands-free).
	pi.on("agent_end", async (_event, ctx) => {
		if (!live.active) return;
		live.busy = false;
		setLiveStatus(ctx);
		await liveTurn(ctx);
	});

	// --- /vision command ----------------------------------------------------

	pi.registerCommand("vision", {
		description:
			"Vision mode: /vision live [on|off] | status | backends | config <key> <value>. See /see and /voice.",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const cfg = getCfg();

			if (sub === "live") {
				const arg = rest[0]?.toLowerCase();
				if (arg === "off" || arg === "stop") stopLive(ctx);
				else if (arg === "on" || arg === "start") startLive(ctx);
				else if (arg === "status" || !arg) {
					ctx.ui.notify(`Vision live: ${live.active ? "on" : "off"}`, "info");
				} else {
					ctx.ui.notify("Usage: /vision live [on|off|status]", "warning");
				}
				return;
			}

			if (sub === "status") {
				ctx.ui.notify(
					[
						`Vision live: ${live.active ? "on" : "off"}`,
						`capture: ${cfg.captureBackend} | stt: ${cfg.sttBackend} | tts: ${cfg.ttsBackend}`,
						`language: ${cfg.language} | voice-mode: ${cfg.voiceMode}`,
						`session: ${isWaylandSession() ? "Wayland" : "X11/other"}`,
					].join("\n"),
					"info",
				);
				return;
			}

			if (sub === "backends") {
				const capture = listCaptureBackends();
				const recorders = listRecorders();
				const stt = listSttBackends({
					openaiKey: process.env.OPENAI_API_KEY,
					groqKey: process.env.GROQ_API_KEY,
				});
				const tts = listTtsBackends({ openaiKey: process.env.OPENAI_API_KEY });
				const lines: string[] = ["Capture:"];
				for (const b of capture) lines.push(`  ${b.available ? "✓" : "✗"} ${b.id} — ${b.label}`);
				lines.push("Recorders:");
				lines.push(`  ${recorders.length ? recorders.join(", ") : "(none)"}`);
				lines.push("STT:");
				for (const b of stt) lines.push(`  ${b.available ? "✓" : "✗"} ${b.id} — ${b.label}`);
				lines.push("TTS:");
				for (const b of tts) lines.push(`  ${b.available ? "✓" : "✗"} ${b.id} — ${b.label}`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "config") {
				const key = rest[0];
				const value = rest[1];
				if (!key) {
					ctx.ui.notify(
						`Config:\n${Object.entries(cfg)
							.map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
							.join("\n")}`,
						"info",
					);
					return;
				}
				if (!value) {
					ctx.ui.notify(`${key} = ${JSON.stringify((cfg as unknown as Record<string, unknown>)[key])}`, "info");
					return;
				}
				if (!(key in DEFAULT_VISION_CONFIG)) {
					ctx.ui.notify(`Unknown config key: ${key}`, "error");
					return;
				}
				const patch: Record<string, unknown> = {
					[key]: parseConfigValue(key as keyof VisionConfig, value),
				};
				saveVisionConfig(patch);
				ctx.ui.notify(`Set ${key} = ${JSON.stringify(patch[key])}`, "info");
				return;
			}

			ctx.ui.notify(
				[
					"Vision mode — usage:",
					"  /see <question>            capture screen, ask about it",
					"  /voice <context?>          record, transcribe, ask",
					"  /vision live [on|off]      toggle hands-free mode",
					"  /vision status             show current state",
					"  /vision backends           list available backends",
					"  /vision config [key] [val] view / set config",
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("see", {
		description: "Capture the screen and ask about it: /see <question>",
		handler: async (args, ctx) => runSee(args, ctx),
	});

	pi.registerCommand("voice", {
		description: "Push-to-talk: /voice [context] — record, transcribe, ask (stop with the PTT shortcut)",
		handler: async (args, ctx) => runVoice(args, ctx),
	});

	// Push-to-talk shortcut (configurable via config.shortcut / VISION_SHORTCUT).
	const cfg0 = getCfg();
	if (cfg0.shortcut) {
		let recording = false;
		let activeController: AbortController | null = null;
		let activeRec: RecordResult | null = null;
		pi.registerShortcut(cfg0.shortcut as KeyId, {
			description: "Vision: push-to-talk (press to start/stop recording, then transcribe)",
			handler: async (ctx) => {
				if (live.active) {
					// In live mode the shortcut barges in on the current capture.
					stopLiveCapture();
					return;
				}
				if (!recording) {
					recording = true;
					activeController = new AbortController();
					ctx.ui.setStatus("vision", "🎙 recording… (press again to stop)");
					try {
						const cfg = getCfg();
						const record = await recordMicrophone(activeController.signal);
						activeRec = record;
						// Block until the user presses again (abort).
						await new Promise<void>((r) =>
							activeController!.signal.addEventListener("abort", () => r(), { once: true }),
						);
						await record.stop();
						ctx.ui.setStatus("vision", "🎙 transcribing…");
						let text: string;
						try {
							text = await transcribe(record.wavPath, resolveSttOpts(cfg));
						} finally {
							cleanupRecord(record);
						}
						ctx.ui.setStatus("vision", undefined);
						// Reject Whisper hallucinations (silence/noise).
						if (isLikelyHallucination(text)) {
							ctx.ui.notify("No speech detected (hallucination filtered).", "warning");
							return;
						}
						// Ignore empty or noise-only transcriptions (punctuation, spaces).
						const cleaned = text.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ]/g, "");
						if (!cleaned || cleaned.length < 2) {
							ctx.ui.notify("No speech detected.", "warning");
							return;
						}
						if (cfg.voiceMode === "send") pi.sendUserMessage(text);
						else {
							ctx.ui.setEditorText(text);
							ctx.ui.notify("Transcribed — press Enter to send.", "info");
						}
					} catch (err) {
						ctx.ui.setStatus("vision", undefined);
						ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
					} finally {
						recording = false;
						activeController = null;
						activeRec = null;
					}
				} else {
					activeController?.abort();
				}
			},
		});
	}

	pi.on("session_shutdown", () => {
		if (live.active) {
			live.active = false;
			live.busy = false;
			stopLiveCapture();
			stopLiveTts();
		}
	});
}

// --- helpers --------------------------------------------------------------

/**
 * Normalize text for wake word matching (remove spaces, hyphens, lowercase).
 */
function normalizeForWake(text: string): string {
	return text.toLowerCase().replace(/[\s-]+/g, "");
}

/**
 * Common Whisper hallucinations on silence/noise.
 * These are rejected automatically to avoid processing background noise.
 */
const WHISPER_HALLUCINATIONS = [
	"thank you",
	"thanks for watching",
	"bye",
	"goodbye",
	"see you",
	"gracias",
	"hasta luego",
	"adiós",
	"ciao",
	"merci",
	"danke",
];

function isLikelyHallucination(text: string): boolean {
	const lower = text.toLowerCase().trim();
	return WHISPER_HALLUCINATIONS.some(h => lower === h || lower === `${h}.`);
}

/**
 * Detect if the user's utterance requests vision (screen capture).
 * Checks for keywords like "qué ves", "mira", "pantalla", "describe", etc.
 */
function needsVision(text: string): boolean {
	const lower = text.toLowerCase();
	// Spanish keywords
	if (/\b(qué|que) ves\b/.test(lower)) return true;
	if (/\b(mira|mirame|observa|ve|ver)\b/.test(lower)) return true;
	if (/\bpantalla\b/.test(lower)) return true;
	if (/\b(describe|dime (qué|que) hay)\b/.test(lower)) return true;
	if (/\bcaptura\b/.test(lower)) return true;
	// English keywords
	if (/\bwhat do you see\b/.test(lower)) return true;
	if (/\b(look|watch|observe)\b/.test(lower)) return true;
	if (/\b(screen|display)\b/.test(lower)) return true;
	if (/\bdescribe\b/.test(lower)) return true;
	return false;
}

// --- helpers --------------------------------------------------------------

function parseConfigValue(key: keyof VisionConfig, raw: string): unknown {
	// Handle empty string literal cases
	if (!raw || raw === '""' || raw === "''") {
		return "";
	}
	// Strip surrounding quotes repeatedly
	let val = raw;
	while (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
		val = val.slice(1, -1);
	}
	switch (key) {
		case "captureInteractive":
		case "liveSpeak":
		case "liveIndicator":
			return val === "true" || val === "1";
		case "captureMaxWidth":
		case "captureJpegQuality":
			return Number.parseInt(val, 10);
		default:
			return val;
	}
}

interface AssistantLike {
	role?: string;
	content?: unknown;
}

function collectAssistantText(message: AssistantLike): string {
	if (message?.role !== "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && "type" in part && part.type === "text"
					? String((part as { text?: unknown }).text ?? "")
					: "",
			)
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

export type { CaptureBackend, SttBackend, TtsBackend, VoiceMode };
