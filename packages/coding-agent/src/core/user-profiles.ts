import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Model } from "@free/pi-ai";
import { getProfilesPath } from "../config.js";
import type { ResourceDisplayFilter, ToolInfo } from "./extensions/types.js";
import { parseSkillBlocks } from "./skill-picker-state.js";
import { applyToolPickerSelection, computeToolGroupFilterState, getToolPickerState } from "./tool-picker-groups.js";

export const USER_PROFILES_FILE_VERSION = 1 as const;
export const DEFAULT_PROFILE_ID = "default";

/** Provider + model id as stored in `profiles.json` (matches `Model.provider` / `Model.id`). */
export interface SerializedActiveModel {
	provider: string;
	id: string;
}

/** One saved profile (tools / skills / agents / theme / model). */
export interface SerializedUserProfile {
	/** Theme display name, or null to keep session default (no `setTheme`). */
	themeName: string | null;
	/** Selected RAG knowledge base for this profile, or null for no default KB. */
	ragKnowledgeBase: string | null;
	/** When set, session switches to this model after tools/filter; null = leave current model. */
	activeModel: SerializedActiveModel | null;
	enabledOptionalToolGroupKeys: string[];
	/** When true, every `<skill>` in the merged prompt is hidden for this profile. */
	hideAllSkills: boolean;
	/** Used when `hideAllSkills` is false: explicit hidden skill names. */
	hiddenSkillNames: string[];
	activeDiscoveredAgents: Array<{ name: string; path: string }>;
}

export interface UserProfilesFile {
	version: typeof USER_PROFILES_FILE_VERSION;
	activeProfile: string;
	profiles: Record<string, SerializedUserProfile>;
}

export interface ProfileApplyDeps {
	getAllTools: () => ToolInfo[];
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;
	setResourceDisplayFilter: (filter: ResourceDisplayFilter) => void;
	getSystemPrompt: () => string;
}

export interface ProfileCaptureDeps extends ProfileApplyDeps {
	getResourceDisplayFilter: () => ResourceDisplayFilter | undefined;
	getModel: () => Model<any> | undefined;
}

export interface ApplyUserProfileOptions {
	setTheme?: (name: string) => { success: boolean; error?: string };
	resolveModel?: (provider: string, modelId: string) => Model<any> | undefined;
	setModel?: (model: Model<any>) => Promise<boolean>;
}

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidProfileName(name: string): boolean {
	return PROFILE_NAME_RE.test(name.trim());
}

export function defaultSerializedProfile(): SerializedUserProfile {
	return {
		themeName: null,
		ragKnowledgeBase: null,
		activeModel: null,
		enabledOptionalToolGroupKeys: [],
		hideAllSkills: true,
		hiddenSkillNames: [],
		activeDiscoveredAgents: [],
	};
}

function emptyProfilesFile(): UserProfilesFile {
	return {
		version: USER_PROFILES_FILE_VERSION,
		activeProfile: DEFAULT_PROFILE_ID,
		profiles: {
			[DEFAULT_PROFILE_ID]: defaultSerializedProfile(),
		},
	};
}

function normalizeProfilesFile(raw: unknown): UserProfilesFile {
	const base = emptyProfilesFile();
	if (!raw || typeof raw !== "object") return base;
	const o = raw as Record<string, unknown>;
	if (typeof o.activeProfile === "string" && o.activeProfile) base.activeProfile = o.activeProfile;
	const profiles = o.profiles;
	if (profiles && typeof profiles === "object") {
		for (const [k, v] of Object.entries(profiles as Record<string, unknown>)) {
			if (!k || typeof v !== "object" || v === null) continue;
			const p = v as Record<string, unknown>;
			const themeName =
				p.themeName === null || p.themeName === undefined
					? null
					: typeof p.themeName === "string"
						? p.themeName
						: null;
			const ragKnowledgeBase =
				p.ragKnowledgeBase === null || p.ragKnowledgeBase === undefined
					? null
					: typeof p.ragKnowledgeBase === "string"
						? p.ragKnowledgeBase
						: null;
			let activeModel: SerializedActiveModel | null = null;
			const am = p.activeModel;
			if (am && typeof am === "object") {
				const r = am as Record<string, unknown>;
				const provider = typeof r.provider === "string" ? r.provider : "";
				const id = typeof r.id === "string" ? r.id : "";
				if (provider && id) activeModel = { provider, id };
			}
			const keys = Array.isArray(p.enabledOptionalToolGroupKeys)
				? p.enabledOptionalToolGroupKeys.filter((x): x is string => typeof x === "string")
				: [];
			const hideAllSkills = p.hideAllSkills === true;
			const hiddenSkillNames = Array.isArray(p.hiddenSkillNames)
				? p.hiddenSkillNames.filter((x): x is string => typeof x === "string")
				: [];
			const agents = Array.isArray(p.activeDiscoveredAgents)
				? p.activeDiscoveredAgents
						.filter((a) => a && typeof a === "object")
						.map((a) => {
							const r = a as Record<string, unknown>;
							const name = typeof r.name === "string" ? r.name : "";
							const path = typeof r.path === "string" ? r.path : "";
							return name && path ? { name, path } : null;
						})
						.filter((x): x is { name: string; path: string } => x !== null)
				: [];
			base.profiles[k] = {
				themeName,
				ragKnowledgeBase,
				activeModel,
				enabledOptionalToolGroupKeys: keys,
				hideAllSkills,
				hiddenSkillNames,
				activeDiscoveredAgents: agents,
			};
		}
	}
	if (!base.profiles[DEFAULT_PROFILE_ID]) {
		base.profiles[DEFAULT_PROFILE_ID] = defaultSerializedProfile();
	}
	base.profiles[DEFAULT_PROFILE_ID] = defaultSerializedProfile();
	if (!base.profiles[base.activeProfile]) {
		base.activeProfile = DEFAULT_PROFILE_ID;
	}
	return base;
}

export function readUserProfilesFile(): UserProfilesFile {
	const path = getProfilesPath();
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return normalizeProfilesFile(raw);
	} catch {
		return emptyProfilesFile();
	}
}

export function writeUserProfilesFile(data: UserProfilesFile): void {
	const path = getProfilesPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	const body = `${JSON.stringify(data, null, 2)}\n`;
	writeFileSync(tmp, body, "utf8");
	renameSync(tmp, path);
}

export function ensureProfilesFileOnDisk(): UserProfilesFile {
	const path = getProfilesPath();
	try {
		readFileSync(path, "utf8");
	} catch {
		const initial = emptyProfilesFile();
		writeUserProfilesFile(initial);
		return initial;
	}
	return readUserProfilesFile();
}

export function buildHiddenSkillNames(profile: SerializedUserProfile, systemPrompt: string): Set<string> {
	if (profile.hideAllSkills) {
		return new Set(parseSkillBlocks(systemPrompt).map((s) => s.name));
	}
	return new Set(profile.hiddenSkillNames);
}

/** `<skill>` names still present in the merged system prompt for this profile (not in the hidden set). */
export function visibleSkillNamesForPrompt(profile: SerializedUserProfile, systemPrompt: string): string[] {
	const hidden = buildHiddenSkillNames(profile, systemPrompt);
	return parseSkillBlocks(systemPrompt)
		.map((s) => s.name)
		.filter((name) => !hidden.has(name));
}

/**
 * Apply a profile: optional tool groups, resource filter (skills + MCP + agents), optional theme, optional model.
 */
export async function applyUserProfile(
	deps: ProfileApplyDeps,
	profile: SerializedUserProfile,
	options?: ApplyUserProfileOptions,
): Promise<{ themeError?: string; modelError?: string }> {
	const tools = deps.getAllTools();
	const currentActive = deps.getActiveTools();
	const enabled = new Set(profile.enabledOptionalToolGroupKeys);
	const nextActive = applyToolPickerSelection(tools, currentActive, enabled);
	deps.setActiveTools(nextActive);
	const { hiddenExtensionPaths, activeMcpServers } = computeToolGroupFilterState(tools, nextActive);
	const hiddenSkillNames = buildHiddenSkillNames(profile, deps.getSystemPrompt());
	deps.setResourceDisplayFilter({
		hiddenSkillNames,
		hiddenExtensionPaths,
		activeMcpServers,
		activeDiscoveredAgents: profile.activeDiscoveredAgents,
	});
	let themeError: string | undefined;
	if (profile.themeName && options?.setTheme) {
		const r = options.setTheme(profile.themeName);
		if (!r.success) themeError = r.error ?? "setTheme failed";
	}
	let modelError: string | undefined;
	if (profile.activeModel && options?.resolveModel && options?.setModel) {
		const m = options.resolveModel(profile.activeModel.provider, profile.activeModel.id);
		if (!m) {
			modelError = `Unknown model ${profile.activeModel.provider}/${profile.activeModel.id}`;
		} else {
			const ok = await options.setModel(m);
			if (!ok) modelError = "Could not activate model (missing credentials or invalid for session)";
		}
	}
	return { themeError, modelError };
}

/** Snapshot current session into a serializable profile. */
export function captureUserProfile(deps: ProfileCaptureDeps, themeName: string): SerializedUserProfile {
	const tools = deps.getAllTools();
	const active = deps.getActiveTools();
	const { groups } = getToolPickerState(tools, active);
	const enabledOptionalToolGroupKeys = groups.filter((g) => g.enabled).map((g) => g.key);
	const fil = deps.getResourceDisplayFilter();
	const hiddenFromHost = fil?.hiddenSkillNames ? [...fil.hiddenSkillNames] : [];
	const systemPrompt = deps.getSystemPrompt();
	const allSkills = parseSkillBlocks(systemPrompt);
	const hideAllSkills = allSkills.length > 0 && allSkills.every((s) => hiddenFromHost.includes(s.name));
	const hiddenSkillNames = hideAllSkills ? [] : hiddenFromHost;
	const activeDiscoveredAgents = fil?.activeDiscoveredAgents
		? fil.activeDiscoveredAgents.map((a) => ({ name: a.name, path: a.path }))
		: [];
	const m = deps.getModel();
	const activeModel = m ? { provider: m.provider, id: m.id } : null;
	return {
		themeName,
		ragKnowledgeBase: null,
		activeModel,
		enabledOptionalToolGroupKeys,
		hideAllSkills,
		hiddenSkillNames,
		activeDiscoveredAgents,
	};
}

export type ParsedProfileCli =
	| { kind: "list" }
	| { kind: "use"; name: string }
	| { kind: "info"; name: string }
	| { kind: "save"; name?: string }
	| { kind: "create"; name: string }
	| { kind: "delete"; name: string }
	| { kind: "interactive" }
	| { kind: "error"; message: string };

/** Parse `/profile` arguments (used by the profile extension and tests). */
export function parseProfileArgs(raw: string): ParsedProfileCli {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { kind: "interactive" };
	const [cmd, ...rest] = parts;
	switch (cmd) {
		case "list":
			return rest.length > 0 ? { kind: "error", message: "usage: /profile list" } : { kind: "list" };
		case "use": {
			const name = rest[0]?.trim();
			if (!name) return { kind: "error", message: "usage: /profile use <name>" };
			return rest.length > 1 ? { kind: "error", message: "usage: /profile use <name>" } : { kind: "use", name };
		}
		case "info": {
			const name = rest[0]?.trim();
			if (!name) return { kind: "error", message: "usage: /profile info <name>" };
			return rest.length > 1 ? { kind: "error", message: "usage: /profile info <name>" } : { kind: "info", name };
		}
		case "save": {
			if (rest.length > 1) return { kind: "error", message: "usage: /profile save [name]" };
			return { kind: "save", name: rest[0]?.trim() || undefined };
		}
		case "create": {
			const name = rest[0]?.trim();
			if (!name) return { kind: "error", message: "usage: /profile create <name>" };
			return rest.length > 1
				? { kind: "error", message: "usage: /profile create <name>" }
				: { kind: "create", name };
		}
		case "delete": {
			const name = rest[0]?.trim();
			if (!name) return { kind: "error", message: "usage: /profile delete <name>" };
			return rest.length > 1
				? { kind: "error", message: "usage: /profile delete <name>" }
				: { kind: "delete", name };
		}
		default:
			return { kind: "error", message: `unknown subcommand "${cmd}"` };
	}
}
