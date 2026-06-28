/**
 * Usage Tracker - Persistent token consumption tracking across sessions
 *
 * This extension tracks and persists token usage:
 * - Global cumulative totals
 * - Per-session breakdown
 * - Updates automatically on every assistant message
 *
 * Data is stored in: ~/.free-code/agent/usage-stats.json
 *
 * Commands:
 * - /usage: Show cumulative usage statistics
 * - /usage-sessions: Show per-session breakdown
 * - /usage-reset confirm: Reset all stats
 */

import type { AssistantMessage } from "@free/pi-ai";
import type { ExtensionAPI } from "@free/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface SessionUsage {
	cwd: string;
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalTokens: number;
	totalCost: number;
	totalCalls: number;
	created: string;
	lastUpdated: string;
}

interface UsageStats {
	version: number;
	lastUpdated: string;
	globalTotal: {
		totalInput: number;
		totalOutput: number;
		totalCacheRead: number;
		totalCacheWrite: number;
		totalTokens: number;
		totalCost: number;
		totalCalls: number;
	};
	bySession: Record<string, SessionUsage>;
}

const STATS_FILE = join(homedir(), ".free-code", "agent", "usage-stats.json");

function ensureDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function loadStats(): UsageStats {
	try {
		if (existsSync(STATS_FILE)) {
			const content = readFileSync(STATS_FILE, "utf-8");
			return JSON.parse(content);
		}
	} catch {
		// If file is corrupted, start fresh
	}

	return {
		version: 1,
		lastUpdated: new Date().toISOString(),
		globalTotal: {
			totalInput: 0,
			totalOutput: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalTokens: 0,
			totalCost: 0,
			totalCalls: 0,
		},
		bySession: {},
	};
}

function saveStats(stats: UsageStats): void {
	ensureDir(STATS_FILE);
	stats.lastUpdated = new Date().toISOString();
	writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

function formatNum(n: number): string {
	return n.toLocaleString("en-US");
}

function formatCost(n: number): string {
	return `$${n.toFixed(4)}`;
}

function formatNumShort(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1000000).toFixed(2)}M`;
}

export default function (pi: ExtensionAPI) {
	let currentSessionId: string | null = null;
	let currentCwd: string | null = null;
	let sessionCreated: string | null = null;

	// Track session start to get session ID and cwd
	pi.on("session_start", (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		currentCwd = ctx.cwd;
		sessionCreated = new Date().toISOString();
	});

	// Track every assistant message to update usage stats
	pi.on("message_end", (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;

		const message = event.message;
		const usage = message.usage;
		if (!usage) return;

		// Get session ID (fallback if session_start wasn't captured)
		const sessionId = currentSessionId || ctx.sessionManager.getSessionId();
		const cwd = currentCwd || ctx.cwd;
		const created = sessionCreated || new Date().toISOString();

		// Load current stats
		const stats = loadStats();

		// Update global totals
		stats.globalTotal.totalInput += usage.input || 0;
		stats.globalTotal.totalOutput += usage.output || 0;
		stats.globalTotal.totalCacheRead += usage.cacheRead || 0;
		stats.globalTotal.totalCacheWrite += usage.cacheWrite || 0;
		stats.globalTotal.totalTokens += usage.totalTokens || 0;
		stats.globalTotal.totalCost += usage.cost?.total || 0;
		stats.globalTotal.totalCalls += 1;

		// Update session-specific stats
		if (!stats.bySession[sessionId]) {
			stats.bySession[sessionId] = {
				cwd,
				totalInput: 0,
				totalOutput: 0,
				totalCacheRead: 0,
				totalCacheWrite: 0,
				totalTokens: 0,
				totalCost: 0,
				totalCalls: 0,
				created,
				lastUpdated: new Date().toISOString(),
			};
		}

		const sessionStats = stats.bySession[sessionId];
		sessionStats.totalInput += usage.input || 0;
		sessionStats.totalOutput += usage.output || 0;
		sessionStats.totalCacheRead += usage.cacheRead || 0;
		sessionStats.totalCacheWrite += usage.cacheWrite || 0;
		sessionStats.totalTokens += usage.totalTokens || 0;
		sessionStats.totalCost += usage.cost?.total || 0;
		sessionStats.totalCalls += 1;
		sessionStats.lastUpdated = new Date().toISOString();

		// Save updated stats
		saveStats(stats);
	});

	// Register slash command to view stats
	pi.registerCommand("usage", {
		description: "Show cumulative token usage statistics",
		handler: async (_args, ctx) => {
			const stats = loadStats();
			const g = stats.globalTotal;
			const sessionCount = Object.keys(stats.bySession).length;

			const summary = [
				`📊 Cumulative Usage: ${formatNum(g.totalCalls)} calls | ${formatNumShort(g.totalTokens)} tokens | ${formatCost(g.totalCost)}`,
				`   Sessions: ${sessionCount} | In: ${formatNumShort(g.totalInput)} | Out: ${formatNumShort(g.totalOutput)} | Cache: ${formatNumShort(g.totalCacheRead)}/${formatNumShort(g.totalCacheWrite)}`,
			].join("\n");

			ctx.ui.notify(summary, "info");
		},
	});

	// Register command to show per-session breakdown
	pi.registerCommand("usage-sessions", {
		description: "Show token usage breakdown by session (last 10)",
		handler: async (_args, ctx) => {
			const stats = loadStats();

			const sessions = Object.entries(stats.bySession)
				.sort(([, a], [, b]) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
				.slice(0, 10);

			if (sessions.length === 0) {
				ctx.ui.notify("No session usage data yet.", "info");
				return;
			}

			const lines: string[] = ["📊 Usage by Session (last 10):"];

			for (const [sessionId, s] of sessions) {
				const shortId = sessionId.slice(0, 20);
				const shortCwd = s.cwd.replace(homedir(), "~").slice(-30);
				lines.push(
					`  ${shortId}... | ${shortCwd}`,
					`    ${s.totalCalls} calls | ${formatNumShort(s.totalTokens)} tok | ${formatCost(s.totalCost)}`,
				);
			}

			// Show as multiple notifications or a single one
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Register command to reset stats (with confirmation)
	pi.registerCommand("usage-reset", {
		description: "Reset all usage statistics (requires 'confirm' argument)",
		handler: async (args, ctx) => {
			const confirm = args?.trim().toLowerCase() === "confirm";

			if (!confirm) {
				ctx.ui.notify("⚠️ To reset all usage stats, run: /usage-reset confirm", "warning");
				return;
			}

			const freshStats: UsageStats = {
				version: 1,
				lastUpdated: new Date().toISOString(),
				globalTotal: {
					totalInput: 0,
					totalOutput: 0,
					totalCacheRead: 0,
					totalCacheWrite: 0,
					totalTokens: 0,
					totalCost: 0,
					totalCalls: 0,
				},
				bySession: {},
			};

			saveStats(freshStats);
			ctx.ui.notify("✅ Usage statistics have been reset.", "info");
		},
	});
}
