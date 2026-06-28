/**
 * Theme toggle — Cycle any installed theme (same list as Settings → Themes)
 *
 * Shortcuts:
 *   Ctrl+Shift+T  — Next theme in the sorted list (wraps)
 *
 * Usage: pi -e extensions/theme-toggle.ts -e extensions/minimal.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@free/pi-coding-agent";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

function themeNameList(ctx: ExtensionContext): string[] {
	if (!ctx.hasUI) return [];
	return ctx.ui.getAllThemes().map((t) => t.name);
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

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		updateStatus(ctx);
	});
}
