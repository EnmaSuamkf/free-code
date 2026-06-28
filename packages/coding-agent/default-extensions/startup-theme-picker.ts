/**
 * Theme picker (`/pick-theme`)
 *
 * Lets you pick a theme with live preview and optionally persist it as the global default
 * in ~/.free-code/agent/settings.json.
 * Usage:
 *   free-code -e packages/coding-agent/examples/extensions/startup-theme-picker.ts
 *
 * Install globally:
 *   mkdir -p ~/.free-code/agent/extensions
 *   cp packages/coding-agent/examples/extensions/startup-theme-picker.ts ~/.free-code/agent/extensions/
 */

import type { ExtensionAPI, ExtensionContext } from "@free/pi-coding-agent";
import { SettingsManager } from "@free/pi-coding-agent";

function extractThemeName(selection: string): string {
	// Selection strings are rendered as: "<name> (active) — <path>" or "<name> — built-in"
	return selection.split(/\s/)[0] ?? selection;
}

export default function (pi: ExtensionAPI) {
	async function promptAndApplyTheme(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;

		const themes = ctx.ui.getAllThemes();
		if (themes.length === 0) {
			ctx.ui.notify("No themes available", "warning");
			return;
		}

		const originalTheme = ctx.ui.theme.name;
		const items = themes
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((t) => {
				const origin = t.path ? t.path : "built-in";
				const active = t.name === originalTheme ? " (active)" : "";
				return `${t.name}${active} — ${origin}`;
			});

		const selection = await ctx.ui.select("Select theme", items, {
			onNavigate: (item) => {
				const name = extractThemeName(item);
				ctx.ui.setTheme(name);
			},
		});

		if (!selection) {
			// Cancelled — restore the original theme
			ctx.ui.setTheme(originalTheme);
			return;
		}

		const name = extractThemeName(selection);
		const setResult = ctx.ui.setTheme(name);
		if (!setResult.success) {
			ctx.ui.setTheme(originalTheme);
			ctx.ui.notify(`Failed to set theme: ${setResult.error ?? "unknown error"}`, "error");
			return;
		}

		const persist = await ctx.ui.confirm(
			"Persist as default?",
			`Save theme "${name}" as your global default (written to settings.json)?`,
		);

		if (persist) {
			const settings = SettingsManager.create(ctx.cwd);
			settings.setTheme(name);
			await settings.flush();
			ctx.ui.notify(`Default theme saved: ${name}`, "info");
		} else {
			ctx.ui.notify(`Theme applied for this session: ${name}`, "info");
		}
	}

	pi.registerCommand("pick-theme", {
		description: "Pick a theme and optionally persist it as default",
		handler: async (_args, ctx) => {
			await promptAndApplyTheme(ctx);
		},
	});
}
