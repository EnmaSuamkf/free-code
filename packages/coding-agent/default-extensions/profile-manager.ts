/**
 * User profiles: `/profile` and a single startup profile picker (when UI is available).
 *
 * Persists to ~/.free-code/agent/profiles.json (see `getProfilesPath()`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@free/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	DEFAULT_PROFILE_ID,
	applyUserProfile,
	captureUserProfile,
	defaultSerializedProfile,
	ensureProfilesFileOnDisk,
	isValidProfileName,
	parseProfileArgs,
	readUserProfilesFile,
	visibleSkillNamesForPrompt,
	writeUserProfilesFile,
	type SerializedUserProfile,
	type UserProfilesFile,
} from "@free/pi-coding-agent";

interface AgentDef {
	name: string;
	description: string;
	path: string;
}

function parseRagKbFromEvent(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const kb = (data as Record<string, unknown>).kb;
	return typeof kb === "string" && kb.trim().length > 0 ? kb.trim() : null;
}

function parseAgentFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { fields: {}, body: raw };
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { fields, body: match[2] };
}

function discoverAgentsFromDir(dir: string, agents: AgentDef[]): void {
	if (!existsSync(dir)) return;
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const mdPath = join(dir, entry.name);
			const raw = readFileSync(mdPath, "utf-8");
			const { fields } = parseAgentFrontmatter(raw);
			const baseName = entry.name.replace(/\.md$/, "");
			agents.push({
				name: fields.name || baseName,
				description: fields.description || "",
				path: mdPath,
			});
		}
	} catch {
		/* ignore */
	}
}

function discoverAgents(): AgentDef[] {
	const agents: AgentDef[] = [];
	// Project-local agents first
	const projectDir = join(process.cwd(), ".free-code", "agents");
	discoverAgentsFromDir(projectDir, agents);
	// Global agents
	const globalDir = join(homedir(), ".free-code", "agents");
	discoverAgentsFromDir(globalDir, agents);
	return agents;
}

function filterProfileAgents(profile: SerializedUserProfile, ctx: ExtensionContext): SerializedUserProfile {
	const onDisk = discoverAgents();
	const paths = new Set(onDisk.map((a) => a.path));
	const next = profile.activeDiscoveredAgents.filter((a) => paths.has(a.path));
	if (next.length !== profile.activeDiscoveredAgents.length) {
		ctx.ui.notify("Some agents from this profile are no longer on disk and were skipped.", "warning");
	}
	return { ...profile, activeDiscoveredAgents: next };
}

function applyFromFile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	file: UserProfilesFile,
	profileId: string,
): Promise<{ themeError?: string; modelError?: string }> {
	const profile = file.profiles[profileId];
	if (!profile) {
		ctx.ui.notify(`Unknown profile "${profileId}"`, "error");
		return Promise.resolve({});
	}
	const adjusted = filterProfileAgents(profile, ctx);
	const deps = {
		getAllTools: () => pi.getAllTools(),
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names: string[]) => pi.setActiveTools(names),
		setResourceDisplayFilter: (f) => pi.setResourceDisplayFilter(f),
		getSystemPrompt: () => ctx.getSystemPrompt(),
	};
	return applyUserProfile(deps, adjusted, {
		setTheme: (name) => ctx.ui.setTheme(name),
		resolveModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
		setModel: (m) => pi.setModel(m),
	});
}

function captureDeps(pi: ExtensionAPI, ctx: ExtensionContext) {
	return {
		getAllTools: () => pi.getAllTools(),
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names: string[]) => pi.setActiveTools(names),
		setResourceDisplayFilter: (f) => pi.setResourceDisplayFilter(f),
		getSystemPrompt: () => ctx.getSystemPrompt(),
		getResourceDisplayFilter: () => pi.getResourceDisplayFilter(),
		getModel: () => ctx.model,
	};
}

function formatProfileApplyWarnings(r: { themeError?: string; modelError?: string }): string | undefined {
	const parts = [
		r.themeError ? `theme: ${r.themeError}` : "",
		r.modelError ? `model: ${r.modelError}` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join("; ") : undefined;
}

function setProfileFooterStatus(ctx: ExtensionContext, file: UserProfilesFile): void {
	const active = file.activeProfile || DEFAULT_PROFILE_ID;
	ctx.ui.setStatus("profile", `- profile:${active}`);
}

function formatProfileDetails(
	name: string,
	profile: SerializedUserProfile,
	isActive: boolean,
	systemPrompt: string,
): string {
	const model = profile.activeModel
		? `${profile.activeModel.provider}/${profile.activeModel.id}`
		: "(none)";
	const toolGroups =
		profile.enabledOptionalToolGroupKeys.length > 0
			? profile.enabledOptionalToolGroupKeys.join(", ")
			: "(none)";
	const visibleSkills = visibleSkillNamesForPrompt(profile, systemPrompt);
	const skillsLine =
		visibleSkills.length > 0
			? visibleSkills.join(", ")
			: profile.hideAllSkills
				? "(none — all hidden)"
				: "(none)";
	const agents =
		profile.activeDiscoveredAgents.length > 0
			? profile.activeDiscoveredAgents.map((a) => a.name).join(", ")
			: "(none)";
	return [
		`Profile: ${name}${isActive ? " *" : ""}`,
		`Theme: ${profile.themeName ?? "(none)"}`,
		`RAG KB: ${profile.ragKnowledgeBase ?? "(none)"}`,
		`Model: ${model}`,
		`Optional tool groups: ${toolGroups}`,
		`Skills (visible in prompt): ${skillsLine}`,
		`Agents: ${agents}`,
	].join("\n");
}

export default function profileManagerExtension(pi: ExtensionAPI) {
	let startupHandled = false;
	let activeRagKnowledgeBase: string | null = null;

	pi.events.on("rag-kb:selected", (data) => {
		activeRagKnowledgeBase = parseRagKbFromEvent(data);
	});

	const applyProfileRagKb = (profile: SerializedUserProfile) => {
		pi.events.emit("rag-kb:select", { kb: profile.ragKnowledgeBase ?? null });
		activeRagKnowledgeBase = profile.ragKnowledgeBase ?? null;
	};

	pi.registerTool({
		name: "get_active_profile",
		label: "Read active profile",
		promptSnippet:
			"get_active_profile(): return the currently active profile and full configuration (theme, rag kb, model, tool groups, skills, agents).",
		description:
			"Return the currently active session profile and its configuration (tools, skills, agents, theme, model, selected RAG knowledge base).",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const file = readUserProfilesFile();
			const activeName = file.activeProfile || DEFAULT_PROFILE_ID;
			const profile = file.profiles[activeName] ?? defaultSerializedProfile();
			const text = formatProfileDetails(activeName, profile, true, ctx.getSystemPrompt());
			return {
				content: [{ type: "text", text }],
				details: {
					name: activeName,
					profile,
				},
			};
		},
	});

	pi.registerTool({
		name: "set_active_profile",
		label: "Switch active profile",
		promptSnippet:
			"set_active_profile(name): apply and persist one saved profile immediately in this session.",
		description:
			"Apply one saved profile immediately in the current session (tools, skills, agents, theme, model, selected RAG knowledge base), and persist it as the active profile.",
		parameters: Type.Object({
			name: Type.String({
				description: "Exact profile name from /profile list.",
			}),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const name = params.name.trim();
			const file = readUserProfilesFile();
			if (!name || !file.profiles[name]) {
				const known = Object.keys(file.profiles).sort();
				throw new Error(
					`Unknown profile "${params.name}". Available profiles: ${known.join(", ") || "(none)"}`,
				);
			}
			const applyResult = await applyFromFile(pi, ctx, file, name);
			applyProfileRagKb(file.profiles[name]);
			file.activeProfile = name;
			writeUserProfilesFile(file);
			setProfileFooterStatus(ctx, file);
			const w = formatProfileApplyWarnings(applyResult);
			return {
				content: [
					{
						type: "text",
						text: w ? `Using profile "${name}" (${w})` : `Using profile "${name}"`,
					},
				],
				details: {
					name,
					themeError: applyResult.themeError ?? null,
					modelError: applyResult.modelError ?? null,
				},
			};
		},
	});

	async function runInteractiveProfileMenu(ctx: ExtensionContext): Promise<void> {
		let file = readUserProfilesFile();
		setProfileFooterStatus(ctx, file);
		const names = Object.keys(file.profiles).sort((a, b) => {
			if (a === DEFAULT_PROFILE_ID) return -1;
			if (b === DEFAULT_PROFILE_ID) return 1;
			return a.localeCompare(b);
		});
		const items = names.map((n) => {
			const mark = n === file.activeProfile ? " (active)" : "";
			return `${n}${mark}`;
		});
		const choice = await ctx.ui.select("Profile — choose an action or pick a profile", [
			"--- Actions ---",
			"List profiles (notify)",
			"Show profile info…",
			"Create new profile…",
			"Save current session as…",
			"Delete profile…",
			"--- Profiles ---",
			...items,
		]);
		if (!choice || choice.startsWith("---")) return;
		if (choice === "List profiles (notify)") {
			ctx.ui.notify(`Profiles: ${names.join(", ")}`, "info");
			return;
		}
		if (choice === "Show profile info…") {
			const victim = await ctx.ui.select("Profile info", names);
			if (!victim) return;
			const profileName = victim.replace(/\s+\(active\)$/, "");
			await handleProfileCommand(`info ${profileName}`, ctx);
			return;
		}
		if (choice === "Create new profile…") {
			const name = await ctx.ui.input("New profile name", "");
			if (!name?.trim()) return;
			await handleProfileCommand(`create ${name.trim()}`, ctx);
			return;
		}
		if (choice === "Save current session as…") {
			const name = await ctx.ui.input("Profile name (leave empty to update non-default active)", "");
			const arg = name?.trim() ? `save ${name.trim()}` : "save";
			await handleProfileCommand(arg, ctx);
			return;
		}
		if (choice === "Delete profile…") {
			const deletable = names.filter((n) => n !== DEFAULT_PROFILE_ID);
			if (deletable.length === 0) {
				ctx.ui.notify("No profiles can be deleted (only `default` exists).", "warning");
				return;
			}
			const victim = await ctx.ui.select("Delete profile", deletable);
			if (!victim) return;
			await handleProfileCommand(`delete ${victim}`, ctx);
			return;
		}
		const profileName = choice.replace(/\s+\(active\)$/, "");
		await handleProfileCommand(`use ${profileName}`, ctx);
	}

	async function handleProfileCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const parsed = parseProfileArgs(args);
		if (parsed.kind === "error") {
			ctx.ui.notify(parsed.message, "error");
			return;
		}
		if (parsed.kind === "interactive") {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive /profile requires a UI session.", "warning");
				return;
			}
			await runInteractiveProfileMenu(ctx);
			return;
		}

		let file = readUserProfilesFile();

		if (parsed.kind === "list") {
			const lines = Object.keys(file.profiles)
				.sort()
				.map((id) => {
					const mark = id === file.activeProfile ? " *" : "";
					return `${id}${mark}`;
				});
			ctx.ui.notify(lines.length ? lines.join("\n") : "(no profiles)", "info");
			return;
		}

		if (parsed.kind === "use") {
			if (!file.profiles[parsed.name]) {
				ctx.ui.notify(`Unknown profile "${parsed.name}"`, "error");
				return;
			}
			const applyResult = await applyFromFile(pi, ctx, file, parsed.name);
			applyProfileRagKb(file.profiles[parsed.name]);
			file.activeProfile = parsed.name;
			writeUserProfilesFile(file);
			setProfileFooterStatus(ctx, file);
			const w = formatProfileApplyWarnings(applyResult);
			if (w) ctx.ui.notify(`Using profile "${parsed.name}" (${w})`, "warning");
			else ctx.ui.notify(`Using profile "${parsed.name}"`, "info");
			return;
		}

		if (parsed.kind === "info") {
			const profile = file.profiles[parsed.name];
			if (!profile) {
				ctx.ui.notify(`Unknown profile "${parsed.name}"`, "error");
				return;
			}
			const details = formatProfileDetails(
				parsed.name,
				profile,
				parsed.name === file.activeProfile,
				ctx.getSystemPrompt(),
			);
			ctx.ui.notify(details, "info");
			const shouldUse = await ctx.ui.confirm("Apply profile", `Use profile "${parsed.name}" now?`);
			if (!shouldUse) return;
			const applyResult = await applyFromFile(pi, ctx, file, parsed.name);
			applyProfileRagKb(file.profiles[parsed.name]);
			file.activeProfile = parsed.name;
			writeUserProfilesFile(file);
			setProfileFooterStatus(ctx, file);
			const w = formatProfileApplyWarnings(applyResult);
			if (w) ctx.ui.notify(`Using profile "${parsed.name}" (${w})`, "warning");
			else ctx.ui.notify(`Using profile "${parsed.name}"`, "info");
			return;
		}

		if (parsed.kind === "create") {
			if (!isValidProfileName(parsed.name)) {
				ctx.ui.notify(
					"Invalid profile name (use letters, digits, ._- ; max 64 chars after first char).",
					"error",
				);
				return;
			}
			if (file.profiles[parsed.name]) {
				ctx.ui.notify(`Profile "${parsed.name}" already exists`, "error");
				return;
			}
			file.profiles[parsed.name] = defaultSerializedProfile();
			file.activeProfile = parsed.name;
			writeUserProfilesFile(file);
			setProfileFooterStatus(ctx, file);
			const ar = await applyFromFile(pi, ctx, file, parsed.name);
			applyProfileRagKb(file.profiles[parsed.name]);
			const w = formatProfileApplyWarnings(ar);
			if (w) ctx.ui.notify(`Created profile "${parsed.name}" (${w})`, "warning");
			else ctx.ui.notify(`Created and activated empty profile "${parsed.name}"`, "info");
			return;
		}

		if (parsed.kind === "delete") {
			if (parsed.name === DEFAULT_PROFILE_ID) {
				ctx.ui.notify("The `default` profile cannot be deleted.", "error");
				return;
			}
			if (!file.profiles[parsed.name]) {
				ctx.ui.notify(`Unknown profile "${parsed.name}"`, "error");
				return;
			}
			delete file.profiles[parsed.name];
			if (file.activeProfile === parsed.name) {
				file.activeProfile = DEFAULT_PROFILE_ID;
			}
			writeUserProfilesFile(file);
			setProfileFooterStatus(ctx, file);
			if (file.activeProfile === DEFAULT_PROFILE_ID) {
				const ar = await applyFromFile(pi, ctx, file, DEFAULT_PROFILE_ID);
				applyProfileRagKb(file.profiles[DEFAULT_PROFILE_ID]);
				const w = formatProfileApplyWarnings(ar);
				if (w) ctx.ui.notify(`Switched to default profile (${w})`, "warning");
			}
			ctx.ui.notify(`Deleted profile "${parsed.name}"`, "info");
			return;
		}

		if (parsed.kind === "save") {
			const targetName = parsed.name ?? file.activeProfile;
			if (targetName === DEFAULT_PROFILE_ID) {
				ctx.ui.notify("Refusing to save over `default` (it must stay empty). Use `/profile create …`.", "error");
				return;
			}
			if (!isValidProfileName(targetName)) {
				ctx.ui.notify("Invalid profile name.", "error");
				return;
			}
			const themeName = ctx.ui.theme.name;
			const snap = captureUserProfile(captureDeps(pi, ctx), themeName);
			snap.ragKnowledgeBase = activeRagKnowledgeBase;
			file.profiles[targetName] = snap;
			file.activeProfile = targetName;
			writeUserProfilesFile(file);
			setProfileFooterStatus(ctx, file);
			ctx.ui.notify(`Saved profile "${targetName}"`, "info");
			return;
		}
	}

	pi.registerCommand("profile", {
		description:
			"List, inspect, apply, create, save, or delete session profiles (tools, skills, agents, theme, model, selected RAG KB)",
		getArgumentCompletions: (prefix) => {
			const text = prefix.trimStart();
			const parts = text.split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				return ["list", "info", "use", "create", "save", "delete"].map((value) => ({
					value: `${value} `,
					label: value,
				}));
			}
			const [sub, ...restParts] = parts;
			if (parts.length === 1) {
				const subs = ["list", "info", "use", "create", "save", "delete"].filter((value) =>
					value.startsWith(sub),
				);
				if (subs.length > 0) {
					return subs.map((value) => ({ value: `${value} `, label: value }));
				}
				if (sub === "save") {
					const file = readUserProfilesFile();
					const names = Object.keys(file.profiles).sort();
					return names.map((name) => ({ value: `save ${name}`, label: name }));
				}
				return null;
			}
			if (sub === "use" || sub === "delete" || sub === "save" || sub === "info") {
				const file = readUserProfilesFile();
				const names = Object.keys(file.profiles).sort();
				const typed = restParts.join(" ");
				const filtered = typed ? names.filter((name) => name.startsWith(typed)) : names;
				return filtered.map((name) => ({ value: `${sub} ${name}`, label: name }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			await handleProfileCommand(args, ctx);
		},
	});

	pi.on("session_resources_ready", async (event, ctx) => {
		if (event.reason === "reload") {
			startupHandled = false;
		}
		if (startupHandled) return;
		if (event.reason !== "startup") return;
		startupHandled = true;

		ensureProfilesFileOnDisk();
		let file = readUserProfilesFile();
		setProfileFooterStatus(ctx, file);

		if (ctx.hasUI) {
			const ids = Object.keys(file.profiles).sort((a, b) => {
				if (a === DEFAULT_PROFILE_ID) return -1;
				if (b === DEFAULT_PROFILE_ID) return 1;
				return a.localeCompare(b);
			});
			const items = ids.map((id) => {
				const mark = id === file.activeProfile ? " (last used)" : "";
				return `${id}${mark}`;
			});
			const picked = await ctx.ui.select("Select session profile", items);
			if (!picked) {
				file.activeProfile = DEFAULT_PROFILE_ID;
				writeUserProfilesFile(file);
				setProfileFooterStatus(ctx, file);
				const ar = await applyFromFile(pi, ctx, file, DEFAULT_PROFILE_ID);
				applyProfileRagKb(file.profiles[DEFAULT_PROFILE_ID]);
				const w = formatProfileApplyWarnings(ar);
				if (w) ctx.ui.notify(`Using default profile (${w})`, "warning");
				else ctx.ui.notify("Using default profile (empty optional resources).", "info");
				return;
			}
			const id = picked.replace(/\s+\(last used\)$/, "");
			const applyResult = await applyFromFile(pi, ctx, file, id);
			applyProfileRagKb(file.profiles[id]);
			file.activeProfile = id;
			writeUserProfilesFile(file);
			setProfileFooterStatus(ctx, file);
			const w = formatProfileApplyWarnings(applyResult);
			if (w) ctx.ui.notify(`Profile "${id}" applied (${w})`, "warning");
			else ctx.ui.notify(`Profile "${id}" applied`, "info");
			return;
		}

		const headlessResult = await applyFromFile(pi, ctx, file, file.activeProfile);
		applyProfileRagKb(file.profiles[file.activeProfile] ?? defaultSerializedProfile());
		const w = formatProfileApplyWarnings(headlessResult);
		if (w) ctx.ui.notify(`Startup profile: ${w}`, "warning");
	});
}
