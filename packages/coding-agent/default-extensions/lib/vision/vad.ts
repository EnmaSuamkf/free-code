/**
 * Voice Activity Detection (VAD) for the vision extension.
 *
 * Records audio by piping raw PCM to stdout, analyses energy in real time,
 * and stops automatically after a configurable silence window.
 *
 * How it works:
 *  1. Spawn a recorder that writes raw S16LE mono 16 kHz PCM to stdout.
 *  2. Pipe the stream through Node: compute RMS per chunk (100 ms).
 *  3. Track silence vs. voice transitions.
 *  4. After `silenceMs` of consecutive silence (post-voice), signal "done".
 *  5. Write the collected PCM as a proper WAV file for the STT backend.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface VadRecordResult {
	wavPath: string;
	/** Resolves when VAD auto-stops (silence) or when manually aborted. */
	done: Promise<void>;
	/** Force-stop the recording (e.g. user pressed a key). */
	stop(): Promise<void>;
}

export interface VadOptions {
	/** Silence duration (ms) before auto-stopping. Default: 2000 */
	silenceMs: number;
	/** Max recording duration (ms) — safety net. Default: 60000 */
	maxDurationMs: number;
	/** RMS energy threshold (0–1) to consider as voice. Default: 0.015 */
	energyThreshold: number;
	/** Minimum voice duration (ms) before silence timer starts. Default: 300 */
	minVoiceMs: number;
}

const DEFAULTS: VadOptions = {
	silenceMs: 2000,
	maxDurationMs: 60000,
	energyThreshold: 0.015,
	minVoiceMs: 300,
};

/* ------------------------------------------------------------------ */
/*  Recorder selection (raw PCM to stdout)                             */
/* ------------------------------------------------------------------ */

function which(cmd: string): boolean {
	try {
		return spawnSync("which", [cmd], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
}

interface RawRecorder {
	command: string;
	args: string[];
}

/** Pick a recorder that outputs raw S16LE mono 16 kHz to stdout. */
function rawRecorder(): RawRecorder | null {
	if (which("pw-record")) {
		return {
			command: "pw-record",
			args: ["--rate", "16000", "--channels", "1", "--format", "s16", "-"],
		};
	}
	if (which("arecord")) {
		return {
			command: "arecord",
			args: ["-q", "-r", "16000", "-c", "1", "-f", "S16_LE", "-t", "raw", "-"],
		};
	}
	if (which("sox")) {
		return {
			command: "sox",
			args: ["-d", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"],
		};
	}
	if (which("ffmpeg")) {
		return {
			command: "ffmpeg",
			args: [
				"-hide_banner", "-loglevel", "quiet",
				"-f", "alsa", "-i", "default",
				"-ar", "16000", "-ac", "1", "-f", "s16le", "-",
			],
		};
	}
	return null;
}

/* ------------------------------------------------------------------ */
/*  Audio helpers                                                      */
/* ------------------------------------------------------------------ */

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // S16LE

/** RMS of signed-16-bit PCM samples. */
function rms(buf: Buffer, len: number): number {
	const samples = Math.floor(len / BYTES_PER_SAMPLE);
	if (samples === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples; i++) {
		const s = buf.readInt16LE(i * 2) / 32768;
		sum += s * s;
	}
	return Math.sqrt(sum / samples);
}

/** Build a 44-byte WAV header for raw S16LE mono 16 kHz. */
function wavHeader(pcmBytes: number): Buffer {
	const header = Buffer.alloc(44);
	const totalSize = 36 + pcmBytes;
	header.write("RIFF", 0);
	header.writeUInt32LE(totalSize, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);       // fmt chunk size
	header.writeUInt16LE(1, 20);        // PCM
	header.writeUInt16LE(1, 22);        // mono
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
	header.writeUInt16LE(BYTES_PER_SAMPLE, 32);               // block align
	header.writeUInt16LE(16, 34);       // bits per sample
	header.write("data", 36);
	header.writeUInt32LE(pcmBytes, 40);
	return header;
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Start a VAD-aware recording session.
 *
 * Returns immediately with a `VadRecordResult`. The `done` promise resolves
 * once VAD triggers (silence detected) or the recording is manually stopped.
 * The WAV file at `wavPath` is ready for transcription after `done` resolves.
 */
export function recordWithVAD(
	signal: AbortSignal,
	opts: Partial<VadOptions> = {},
): Promise<VadRecordResult> {
	const cfg = { ...DEFAULTS, ...opts };
	const rec = rawRecorder();

	if (!rec) {
		return Promise.reject(
			new Error(
				'No audio recorder found. Install "pw-record" (PipeWire), "arecord" (ALSA), "sox", or "ffmpeg".',
			),
		);
	}

	const workDir = mkdtempSync(join(tmpdir(), "vision-vad-"));
	const wavPath = join(workDir, "voice.wav");

	return new Promise<VadRecordResult>((resolve, reject) => {
		const proc = spawn(rec.command, rec.args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		/* ---- state ---- */
		const pcmChunks: Buffer[] = [];
		let totalPcmBytes = 0;
		let closed = false;
		let spawnErr: Error | null = null;

		// VAD state
		let hasDetectedVoice = false;
		let voiceStartTime = 0;
		let lastVoiceTime = 0;
		const startTime = Date.now();

		let doneResolve: (() => void) | null = null;
		let doneReject: ((err: Error) => void) | null = null;
		const donePromise = new Promise<void>((res, rej) => {
			doneResolve = res;
			doneReject = rej;
		});

		/* ---- kill helper ---- */
		const kill = () => {
			try {
				proc.kill("SIGTERM");
			} catch { /* gone */ }
		};

		const onAbort = () => kill();
		if (signal.aborted) {
			kill();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		/* ---- finalise: write WAV and resolve ---- */
		const finalise = () => {
			signal.removeEventListener("abort", onAbort);

			// Write WAV file
			try {
				const pcm = Buffer.concat(pcmChunks, totalPcmBytes);
				const header = wavHeader(pcm.length);
				writeFileSync(wavPath, Buffer.concat([header, pcm]));
			} catch (err) {
				doneReject?.(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			doneResolve?.();
		};

		/* ---- process events ---- */
		proc.on("close", () => {
			closed = true;
			finalise();
		});

		proc.on("error", (err) => {
			spawnErr = err;
			closed = true;
			doneReject?.(err);
		});

		/* ---- PCM stream: collect + analyse ---- */
		// Analyse in chunks of ~100 ms = 3200 bytes (16000 Hz * 2 bytes * 0.1 s)
		const CHUNK_ANALYSIS_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE / 10; // 3200
		let analysisBuffer = Buffer.alloc(CHUNK_ANALYSIS_SIZE);
		let analysisOffset = 0;

		proc.stdout?.on("data", (data: Buffer) => {
			// Collect raw PCM
			pcmChunks.push(Buffer.from(data));
			totalPcmBytes += data.length;

			// Feed analysis buffer
			let dataOffset = 0;
			while (dataOffset < data.length) {
				const needed = CHUNK_ANALYSIS_SIZE - analysisOffset;
				const available = data.length - dataOffset;
				const toCopy = Math.min(needed, available);

				data.copy(analysisBuffer, analysisOffset, dataOffset, dataOffset + toCopy);
				analysisOffset += toCopy;
				dataOffset += toCopy;

				if (analysisOffset >= CHUNK_ANALYSIS_SIZE) {
					// Full chunk ready — analyse
					processChunk(analysisBuffer, CHUNK_ANALYSIS_SIZE);
					analysisOffset = 0;
				}
			}
		});

		const processChunk = (buf: Buffer, len: number) => {
			const energy = rms(buf, len);
			const now = Date.now();
			const elapsed = now - startTime;

			if (energy > cfg.energyThreshold) {
				if (!hasDetectedVoice) {
					hasDetectedVoice = true;
					voiceStartTime = now;
				}
				lastVoiceTime = now;
			}

			// Only apply silence-stop after minimum voice duration
			if (hasDetectedVoice) {
				const voiceDuration = lastVoiceTime - voiceStartTime;
				const silenceDuration = now - lastVoiceTime;

				if (voiceDuration >= cfg.minVoiceMs && silenceDuration >= cfg.silenceMs) {
					// Silence threshold exceeded after meaningful voice — stop
					kill();
					return;
				}
			}

			// Safety net: max duration
			if (elapsed >= cfg.maxDurationMs) {
				kill();
			}
		};

		/* ---- startup: resolve the outer promise once recorder is alive ---- */
		const startupTimer = setTimeout(() => {
			if (spawnErr) {
				reject(spawnErr);
				return;
			}
			if (closed && !signal.aborted) {
				reject(
					new Error(
						`${rec.command} exited ${proc.exitCode}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
					),
				);
				return;
			}

			resolve({
				wavPath,
				done: donePromise,
				stop: () => {
					kill();
					return donePromise;
				},
			});
		}, 300);

		signal.addEventListener("abort", () => clearTimeout(startupTimer), { once: true });
	});
}

export function cleanupVadRecord(result: VadRecordResult): void {
	try {
		const dir = join(result.wavPath, "..");
		rmSync(dir, { force: true, recursive: true });
	} catch { /* ignore */ }
}
