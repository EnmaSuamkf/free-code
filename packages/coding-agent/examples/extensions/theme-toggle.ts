/**
 * Theme toggle — Cycle or set any installed theme (same list as Settings → Themes)
 *
 * Shortcuts:
 *   Ctrl+Shift+T  — Next theme in the sorted list (wraps)
 *
 * Commands:
 *   /appearance              — Same as the shortcut (next theme)
 *   /appearance <themeName>  — e.g. /appearance tokyo-night, /appearance dark
 *
 * Usage: pi -e extensions/theme-toggle.ts -e extensions/minimal.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@free/pi-coding-agent";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

function themeNameList(ctx: ExtensionContext): string[] {
	if (!ctx.hasUI) return [];
	return ctx.ui.getAllThemes().map((t) => t.name);
}

function resolveThemeName(raw: string, names: string[]): string | undefined {
	const q = raw.trim().toLowerCase();
	if (!q) return undefined;
	return names.find((n) => n.toLowerCase() === q);
}

function nextThemeName(current: string, names: string[]): string {
	if (names.length === 0) return current;
	const sorted = [...names].sort((a, b) => a.localeCompare(b));
	const n = current.toLowerCase();
	const idx = sorted.findIndex((t) => t.toLowerCase() === n);
	if (idx === -1) return sorted[0] ?? current;
	return sorted[(idx + 1) % sorted.length] ?? sorted[0];
}

export default function (pi: ExtensionAPI) {
	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const name = ctx.ui.theme.name;
		ctx.ui.setStatus("appearance", `◐ ${name}`);
	}

	function applyTheme(ctx: ExtensionContext, name: string): void {
		const result = ctx.ui.setTheme(name);
		if (result.success) {
			updateStatus(ctx);
			ctx.ui.notify(`Theme: ${name}`, "info");
		} else {
			ctx.ui.notify(`Could not set theme: ${result.error ?? "unknown error"}`, "error");
		}
	}

	pi.registerShortcut("ctrl+shift+t", {
		description: "Next theme (cycles all installed themes)",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const names = themeNameList(ctx);
			applyTheme(ctx, nextThemeName(ctx.ui.theme.name, names));
		},
	});

	pi.registerCommand("appearance", {
		description: "Next theme or set by name: /appearance [themeName]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const arg = args.trim();
			const names = themeNameList(ctx);
			if (!arg) {
				applyTheme(ctx, nextThemeName(ctx.ui.theme.name, names));
				return;
			}
			const resolved = resolveThemeName(arg, names);
			if (resolved) {
				applyTheme(ctx, resolved);
				return;
			}
			ctx.ui.notify(
				`Unknown theme "${arg}". Use /settings to pick a theme, or /appearance with a valid name.`,
				"warning",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		updateStatus(ctx);
	});
}
