/**
 * Text-to-speech backends for the vision extension.
 *
 * OpenAI TTS API (streamed PCM), espeak (local Linux), and say (macOS).
 */

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { TtsBackend } from "./config.ts";

export interface TtsOptions {
	backend: TtsBackend;
	model: string;
	voice: string;
	apiKey?: string;
	/** Called with PCM/bytes as they arrive (streaming). Optional. */
	onChunk?: (chunk: Buffer) => void;
	/** Abort the playback / API request. */
	signal?: AbortSignal;
}

export interface TtsBackendInfo {
	id: string;
	available: boolean;
	label: string;
}

function commandAvailable(cmd: string): boolean {
	try {
		const r = spawnSync("which", [cmd], { stdio: "ignore" });
		return r.status === 0;
	} catch {
		return false;
	}
}

interface TtsBackendDef {
	id: TtsBackend;
	available: (opts: TtsOptions) => boolean;
	speak: (text: string, opts: TtsOptions) => Promise<void>;
}

async function playWavStream(stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream, opts: TtsOptions): Promise<void> {
	// Download the full WAV to a temp file, then play it (avoids streaming glitches).
	const player = commandAvailable("pw-play")
		? { command: "pw-play", args: [] }
		: commandAvailable("aplay")
			? { command: "aplay", args: ["-q"] }
			: null;
	if (!player) {
		throw new Error('No audio player found. Install "pw-play" or "aplay" for TTS playback.');
	}

	// Collect the stream into a buffer.
	const chunks: Uint8Array[] = [];
	const webStream = stream as ReadableStream<Uint8Array>;
	const reader = webStream.getReader?.();
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}
	} else {
		// Node stream
		const nodeStream = stream as NodeJS.ReadableStream;
		for await (const chunk of nodeStream as AsyncIterable<unknown>) {
			const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
			chunks.push(buf);
		}
	}
	const wavData = Buffer.concat(chunks.map(c => Buffer.from(c)));

	// Write to temp file.
	const tmpDir = mkdtempSync(join(tmpdir(), "vision-tts-"));
	const wavPath = join(tmpDir, "tts.wav");
	writeFileSync(wavPath, wavData);

	// Play the file.
	return new Promise<void>((resolve, reject) => {
		const proc = spawn(player.command, [...player.args, wavPath], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		proc.stderr?.on("data", (d) => { stderr += d.toString(); });
		const onAbort = () => proc.kill("SIGTERM");
		if (opts.signal) {
			if (opts.signal.aborted) proc.kill("SIGTERM");
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		proc.on("close", (code) => {
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			try { unlinkSync(wavPath); } catch {}
			if (opts.signal?.aborted || code === 0) resolve();
			else reject(new Error(`${player.command} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
		});
		proc.on("error", (err) => {
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			try { unlinkSync(wavPath); } catch {}
			reject(err);
		});
	});
}

const BACKENDS: TtsBackendDef[] = [
	{
		id: "openai",
		available: (opts) => Boolean(opts.apiKey),
		speak: async (text, opts) => {
			const base = "https://api.openai.com/v1/audio/speech";
			const response = await fetch(base, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${opts.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: opts.model,
					voice: opts.voice,
					input: text,
					response_format: "wav",
				}),
				signal: opts.signal,
			});
			if (!response.ok || !response.body) {
				const t = await response.text().catch(() => "");
				throw new Error(`TTS responded ${response.status}: ${t.slice(0, 200)}`);
			}
			await playWavStream(response.body, opts);
		},
	},
	{
		id: "espeak",
		available: () => commandAvailable("espeak"),
		speak: (text, opts) =>
			new Promise<void>((resolve, reject) => {
				const proc = spawn("espeak", [text], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
				let stderr = "";
				proc.stderr?.on("data", (d) => {
					stderr += d.toString();
				});
				const onAbort = () => proc.kill("SIGTERM");
				if (opts.signal) {
					if (opts.signal.aborted) proc.kill("SIGTERM");
					else opts.signal.addEventListener("abort", onAbort, { once: true });
				}
				proc.on("close", (code) => {
					if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
					if (opts.signal?.aborted || code === 0) resolve();
					else reject(new Error(`espeak exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
				});
				proc.on("error", reject);
			}),
	},
	{
		id: "say",
		available: () => process.platform === "darwin" && commandAvailable("say"),
		speak: (text, opts) =>
			new Promise<void>((resolve, reject) => {
				const proc = spawn("say", [text], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
				const onAbort = () => proc.kill("SIGTERM");
				if (opts.signal) {
					if (opts.signal.aborted) proc.kill("SIGTERM");
					else opts.signal.addEventListener("abort", onAbort, { once: true });
				}
				proc.on("close", (code) => {
					if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
					if (opts.signal?.aborted || code === 0) resolve();
					else reject(new Error(`say exited ${code}`));
				});
				proc.on("error", reject);
			}),
	},
];

/** Speak text aloud. */
export async function speak(text: string, opts: TtsOptions): Promise<void> {
	if (!text.trim()) return;
	let candidates = BACKENDS;
	if (opts.backend !== "auto") {
		candidates = BACKENDS.filter((b) => b.id === opts.backend);
		if (candidates.length === 0) throw new Error(`Unknown TTS backend "${opts.backend}".`);
	}
	const available = candidates.filter((b) => b.available(opts));
	if (available.length === 0) {
		const tried = candidates.map((b) => b.id).join(", ");
		const need = candidates.some((b) => b.id === "openai")
			? " Set OPENAI_API_KEY."
			: ' Install "espeak" (Linux) or run on macOS for "say".';
		throw new Error(`No available TTS backend (tried: ${tried}).${need}`);
	}
	let lastError: Error | undefined;
	for (const backend of available) {
		try {
			await backend.speak(text, opts);
			return;
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			continue;
		}
	}
	throw lastError ?? new Error("All TTS backends failed.");
}

export function listTtsBackends(opts: { openaiKey?: string }): TtsBackendInfo[] {
	return [
		{ id: "openai", available: Boolean(opts.openaiKey), label: "OpenAI TTS API" },
		{ id: "espeak", available: commandAvailable("espeak"), label: "espeak (local Linux)" },
		{ id: "say", available: process.platform === "darwin" && commandAvailable("say"), label: "say (macOS)" },
	];
}

/** Stop an in-flight TTS playback (caller holds the controller). */
export function stopTts(controller: AbortController | undefined): void {
	controller?.abort();
}
