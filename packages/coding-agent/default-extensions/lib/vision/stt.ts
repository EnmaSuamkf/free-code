/**
 * Speech-to-text backends for the vision extension.
 *
 * Recording uses whichever CLI is available (pw-record on PipeWire, arecord on
 * ALSA, sox/rec, ffmpeg). Transcription backends: OpenAI Whisper API, Groq,
 * and local whisper.cpp. Configured via vision config / env / flags.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SttBackend } from "./config.ts";

export interface RecordResult {
	wavPath: string;
	/** Abort the recording and wait for the recorder to flush the WAV. */
	stop(): Promise<void>;
}

export interface TranscribeOptions {
	backend: SttBackend;
	language: string;
	model: string;
	/** OpenAI-compatible API base override (e.g. Groq). */
	apiBase?: string;
	/** API key (resolved by caller from env). */
	apiKey?: string;
}

export interface SttBackendInfo {
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

/** Pick a recording CLI and return its args for a mono 16kHz WAV. */
function recorder(): { command: string; args: (signal: AbortSignal) => string[] } | null {
	if (commandAvailable("pw-record")) {
		return {
			command: "pw-record",
			args: () => ["--rate", "16000", "--channels", "1", "--format", "s16"],
		};
	}
	if (commandAvailable("arecord")) {
		return {
			command: "arecord",
			args: () => ["-q", "-r", "16000", "-c", "1", "-f", "S16_LE", "-t", "wav"],
		};
	}
	if (commandAvailable("sox")) {
		return {
			command: "sox",
			args: () => ["-d", "-r", "16000", "-c", "1", "-t", "wav"],
		};
	}
	if (commandAvailable("ffmpeg")) {
		return {
			command: "ffmpeg",
			args: () => ["-hide_banner", "-loglevel", "quiet", "-f", "alsa", "-i", "default"],
		};
	}
	return null;
}

/**
 * Start recording microphone audio. Resolves once the recorder process is
 * alive and returns a handle with the WAV path and a `stop()` that aborts the
 * recording (via `signal`) and waits for the file to be flushed.
 *
 * On PipeWire/ALSA the output is 16kHz mono S16 LE — directly accepted by the
 * OpenAI /audio/transcriptions endpoint.
 */
export function recordMicrophone(signal: AbortSignal): Promise<RecordResult> {
	const rec = recorder();
	if (!rec) {
		return Promise.reject(
			new Error(
				'No audio recorder found. Install "pw-record" (PipeWire), "arecord" (ALSA), "sox", or "ffmpeg".',
			),
		);
	}
	const workDir = mkdtempSync(join(tmpdir(), "vision-voice-"));
	const wavPath = join(workDir, "voice.wav");

	return new Promise<RecordResult>((resolve, reject) => {
		const args = rec.args(signal);
		const proc = spawn(rec.command, [...args, wavPath], {
			shell: false,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});

		let closed = false;
		let closeCode: number | null = null;
		let spawnErr: Error | null = null;
		let stopResolve: (() => void) | null = null;

		const onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				// Process may already be gone.
			}
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		const finalizeStop = () => {
			if (stopResolve) {
				const fn = stopResolve;
				stopResolve = null;
				fn();
			}
		};

		proc.on("close", (code) => {
			closed = true;
			closeCode = code;
			finalizeStop();
		});
		proc.on("error", (err) => {
			spawnErr = err;
			finalizeStop();
		});

		// Resolve once the recorder has had a moment to either fail or confirm
		// it is alive. A short delay is more portable than relying on stdout/stderr
		// banners (pw-record prints nothing; arecord prints on stderr).
		const startup = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			if (spawnErr) {
				reject(spawnErr);
				return;
			}
			// Died on its own (e.g. no audio device) without an abort.
			if (closed && !signal.aborted) {
				reject(
					new Error(`${rec.command} exited ${closeCode}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`),
				);
				return;
			}
			resolve({
				wavPath,
				stop: () =>
					new Promise<void>((res) => {
						if (closed || spawnErr) {
							res();
							return;
						}
						stopResolve = res;
						onAbort();
					}),
			});
		}, 300);
		// If the caller aborts during the startup window, cancel the timer so we
		// don't resolve a handle for a dead process.
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(startup);
			},
			{ once: true },
		);
	});
}

export function cleanupRecord(result: RecordResult): void {
	try {
		rmSync(result.wavPath, { force: true });
	} catch {
		// Ignore.
	}
}

interface SttBackendDef {
	id: SttBackend;
	available: (opts: TranscribeOptions) => boolean;
	transcribe: (wavPath: string, opts: TranscribeOptions) => Promise<string>;
}

const BACKENDS: SttBackendDef[] = [
	{
		id: "openai",
		available: (opts) => Boolean(opts.apiKey),
		transcribe: (wavPath, opts) =>
			transcribeViaOpenAi(wavPath, opts, "https://api.openai.com/v1/audio/transcriptions"),
	},
	{
		id: "groq",
		available: (opts) => Boolean(opts.apiKey),
		transcribe: (wavPath, opts) =>
			transcribeViaOpenAi(wavPath, opts, "https://api.groq.com/openai/v1/audio/transcriptions"),
	},
	{
		id: "whisper-cpp",
		available: () => commandAvailable("whisper") || commandAvailable("whisper-cpp"),
		transcribe: transcribeViaWhisperCpp,
	},
];

/**
 * Well-known Whisper hallucinations produced on silence or low-energy audio.
 * Compared case-insensitively after stripping punctuation and trimming.
 */
const WHISPER_HALLUCINATIONS = new Set([
	"thank you",
	"thanks",
	"you",
	"bye",
	"goodbye",
	"please",
	"uh",
	"um",
	"hmm",
	"hm",
	"ah",
	"oh",
	"okay",
	"right",
	"i see",
	"i know",
	"of course",
	"all right",
	"alright",
	"great",
	"good",
	"very good",
	"well done",
	"wow",
	"oh my god",
	"oh wow",
	"so",
]);

export function isWhisperHallucination(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[^a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1 ]/g, "")
		.trim();
	return WHISPER_HALLUCINATIONS.has(normalized);
}

/** Transcribe a WAV file to text. */
export async function transcribe(wavPath: string, opts: TranscribeOptions): Promise<string> {
	let candidates = BACKENDS;
	if (opts.backend !== "auto") {
		candidates = BACKENDS.filter((b) => b.id === opts.backend);
		if (candidates.length === 0) throw new Error(`Unknown STT backend "${opts.backend}".`);
	}
	const available = candidates.filter((b) => b.available(opts));
	if (available.length === 0) {
		const tried = candidates.map((b) => b.id).join(", ");
		const need = candidates.some((b) => b.id === "openai" || b.id === "groq")
			? " Set OPENAI_API_KEY (or GROQ_API_KEY for Groq)."
			: ' Install "whisper" or "whisper-cpp".';
		throw new Error(`No available STT backend (tried: ${tried}).${need}`);
	}
	let lastError: Error | undefined;
	for (const backend of available) {
		try {
			return await backend.transcribe(wavPath, opts);
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			continue;
		}
	}
	throw lastError ?? new Error("All STT backends failed.");
}

async function transcribeViaOpenAi(
	wavPath: string,
	opts: TranscribeOptions,
	defaultBase: string,
): Promise<string> {
	const base = opts.apiBase ?? defaultBase;
	const form = new FormData();
	const bytes = readFileSync(wavPath);
	form.append("file", new Blob([bytes], { type: "audio/wav" }), "voice.wav");
	form.append("model", opts.model);
	if (opts.language && opts.language !== "auto") form.append("language", opts.language);
	form.append("response_format", "text");

	const response = await fetch(base, {
		method: "POST",
		headers: { Authorization: `Bearer ${opts.apiKey}` },
		body: form,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`${base} responded ${response.status}: ${text.slice(0, 200)}`);
	}
	const text = (await response.text()).trim();
	return text;
}

async function transcribeViaWhisperCpp(wavPath: string, opts: TranscribeOptions): Promise<string> {
	const bin = commandAvailable("whisper") ? "whisper" : "whisper-cpp";
	const args = ["-f", wavPath, "-nt"];
	if (opts.language && opts.language !== "auto") args.push("-l", opts.language);
	return new Promise<string>((resolve, reject) => {
		const proc = spawn(bin, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => {
			if (code === 0) resolve(stdout.trim());
			else reject(new Error(`${bin} exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`));
		});
		proc.on("error", reject);
	});
}

export function listSttBackends(opts: {
	openaiKey?: string;
	groqKey?: string;
}): SttBackendInfo[] {
	return [
		{ id: "openai", available: Boolean(opts.openaiKey), label: "OpenAI Whisper API" },
		{ id: "groq", available: Boolean(opts.groqKey), label: "Groq Whisper API" },
		{
			id: "whisper-cpp",
			available: commandAvailable("whisper") || commandAvailable("whisper-cpp"),
			label: "whisper.cpp (local)",
		},
	];
}

export function listRecorders(): string[] {
	const found: string[] = [];
	for (const cmd of ["pw-record", "arecord", "sox", "ffmpeg"]) {
		if (commandAvailable(cmd)) found.push(cmd);
	}
	return found;
}
