import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getVscode } from "./vscode-api-binding.mjs";

const vscode = new Proxy(
  {},
  {
    get(_, prop) {
      const api = getVscode();
      return api[prop];
    },
  },
);

/**
 * Default session dir segment for a cwd (matches `getDefaultSessionDir` in coding-agent session-manager).
 * @param {string} cwdAbs
 */
function encodeDefaultSessionSubdir(cwdAbs) {
  const normalized = path.resolve(String(cwdAbs || ""));
  const stripped = normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${stripped}--`;
}

/**
 * Agent root directory (~/.free-code/agent or env override), for locating default session JSONL files.
 * @returns {string}
 */
function resolveCodingAgentAgentRoot() {
  const fromEnv =
    process.env.FREE_CODE_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    if (fromEnv === "~") return homedir();
    if (fromEnv.startsWith("~/")) return homedir() + fromEnv.slice(1);
    return fromEnv;
  }
  return path.join(homedir(), ".free-code", "agent");
}

/**
 * Prefer the built workspace CLI when the setting is still the default `free-code`, so the RPC child
 * matches a local `npm run build` and includes verbs like `get_tool_picker_state` (avoids an older
 * global install on PATH). Also runs explicit `.../dist/cli.js` paths via `node`.
 * @param {string} configuredPath
 * @param {string | undefined} workspaceRoot
 * @returns {{ command: string; spawnArgsPrefix: string[] }}
 * @description Also used so a local `packages/coding-agent/dist/cli.js` build is picked for RPC verbs like `get_skill_picker_state`.
 */
function resolveFreeCodeExecutable(configuredPath, workspaceRoot) {
  const trimmed = (configuredPath || "free-code").trim() || "free-code";

  const tryJs = (p) => {
    const abs = path.isAbsolute(p)
      ? p
      : workspaceRoot
        ? path.join(workspaceRoot, p)
        : p;
    if (abs.endsWith(".js") && existsSync(abs)) {
      return { command: "node", spawnArgsPrefix: [path.resolve(abs)] };
    }
    return null;
  };

  const fromUser = tryJs(trimmed);
  if (fromUser) return fromUser;

  if (trimmed === "free-code" && workspaceRoot) {
    const fromRepo = tryJs(
      path.join(workspaceRoot, "packages/coding-agent/dist/cli.js"),
    );
    if (fromRepo) return fromRepo;
  }

  return { command: trimmed, spawnArgsPrefix: [] };
}

/**
 * Mirror of `packages/coding-agent/src/modes/rpc/rpc-mode.ts` RPC_GET_COMMANDS_ALLOWLIST.
 * Filters `get_commands` RPC rows so an older global free-code cannot flood the webview slash menu.
 * `name` may omit the leading slash (RPC convention).
 */
const RPC_WEBVIEW_SLASH_ALLOWLIST = new Set([
  "session",
  "tools",
  "pick-tools",
  "files",
  "pick-agent",
  "pick-skill",
  "commands",
  "gemini",
  "addDrive",
  "sh",
  "pick-theme",
  "profile",
  "mode",
  "sub",
  "login",
  "logout",
  "codeGraph-index",
  "codeGraph-symbols",
  "codeGraph-callers",
  "codeGraph-context",
]);

const DEFAULT_RAG_BASE = "http://localhost:8085";
const DEFAULT_RAG_MAX_CHUNKS = 3;
const DEFAULT_RAG_MAX_CHARS = 3000;
const RAG_ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".md",
  ".txt",
]);
/** Stored in KB dir but not vector-indexed by free-code-rag (GET /discover only). */
const RAG_KNOWLEDGE_SIDECAR_SUFFIX = ".knowledge.md";
const RAG_SUBCOMMANDS = new Set([
  "addFile",
  "addGroup",
  "addGithubUrl",
  "addDrive",
  "search",
  "list",
  "remove",
  "refresh",
  "schedule",
]);
const RAG_KB_SUBCOMMANDS = new Set(["create", "delete", "use", "list"]);
const SOURCES_FILENAME = "sources.json";
const PRESET_SCHEDULES = {
  hourly: { cron: "7 * * * *",  label: "every hour" },
  daily:  { cron: "57 8 * * *", label: "every day at ~9am" },
  weekly: { cron: "57 8 * * 1", label: "every Monday at ~9am" },
};
const KB_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Walks up from `cwd` looking for `.git` (directory or worktree pointer file) and returns
 * the absolute path to the matching `HEAD` file plus the repo root used for the display name.
 * Mirrors `FooterDataProvider.findGitPaths` in `packages/coding-agent` so the webview footer
 * matches the CLI footer behavior in regular repos and worktrees.
 * @param {string} cwd
 * @returns {{ repoDir: string, headPath: string } | null}
 */
function findGitHeadPath(cwd) {
  let dir = cwd;
  while (true) {
    const gitPath = path.join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = path.resolve(dir, content.slice(8).trim());
            const headPath = path.join(gitDir, "HEAD");
            if (!existsSync(headPath)) return null;
            return { repoDir: dir, headPath };
          }
        } else if (stat.isDirectory()) {
          const headPath = path.join(gitPath, "HEAD");
          if (!existsSync(headPath)) return null;
          return { repoDir: dir, headPath };
        }
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read the current branch from a `.git/HEAD` file. Returns the branch name, `"detached"`
 * for a detached HEAD, or `null` if the file is unreadable. Same parsing as
 * `FooterDataProvider.resolveGitBranchSync`.
 * @param {string} headPath
 * @returns {string | null}
 */
function readGitBranch(headPath) {
  try {
    const content = readFileSync(headPath, "utf8").trim();
    if (content.startsWith("ref: refs/heads/")) {
      return content.slice("ref: refs/heads/".length) || "detached";
    }
    return "detached";
  } catch {
    return null;
  }
}

/**
 * Quote `absPath` for inclusion in a single-line shell-style prompt sent to the agent.
 * Mirrors the previous webview-side `toRawFileToken`: leaves unproblematic paths bare so
 * the agent's `read` / `edit` tools see exactly the same tokens the TUI sends, and falls
 * back to single-quote escaping (`'…'\''…'`) for paths with spaces, quotes, backticks,
 * backslashes, or `$`. Returns an empty string for non-string / empty inputs.
 * @param {unknown} absPath
 * @returns {string}
 */
function toShellTokenForPath(absPath) {
  if (typeof absPath !== "string" || absPath.length === 0) return "";
  if (!/[\s'"`\\$]/.test(absPath)) return absPath;
  return `'${absPath.replace(/'/g, "'\\''")}'`;
}

/**
 * Replace the leading user home directory in `absPath` with `~` so the indicator matches
 * the CLI footer style (`~/Documents/repositories/free-code`). Falls back to the absolute path.
 * @param {string} absPath
 * @returns {string}
 */
function formatHomePath(absPath) {
  if (!absPath) return absPath;
  const home = homedir();
  if (!home) return absPath;
  if (absPath === home) return "~";
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  if (absPath.startsWith(homeWithSep)) {
    return `~${path.sep}${absPath.slice(homeWithSep.length)}`;
  }
  return absPath;
}

/**
 * Normalize user input into an http(s) URL that `agent_browser` can open.
 * @param {string} raw
 * @returns {string}
 */
function normalizeAgentBrowserUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("Enter a URL to open.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Enter a valid URL, for example https://example.com.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "Only http and https URLs can be opened by the browser agent.",
    );
  }
  return url.toString();
}

/**
 * @param {string} url
 * @param {string} instruction
 * @returns {string}
 */
function buildAgentBrowserPrompt(url, instruction) {
  const extra = instruction.trim();
  return [
    `Open ${url} in a visible external browser window with the agent_browser tool.`,
    `Use a fresh headed session for the first tool call: call agent_browser with args ["--headed", "open", "${url}"] and sessionMode "fresh".`,
    'After the visible browser opens, call agent_browser again with args ["snapshot", "-i"] so you can inspect the page before interacting.',
    "Keep controlling that same visible browser session with agent_browser for clicks, typing, and navigation so the user can watch each action live.",
    extra
      ? `User goal: ${extra}`
      : "User goal: wait for my next instruction after the initial snapshot.",
    "If headed/visual launch is unsupported or agent_browser is unavailable, explain that agent-browser must be installed, available on PATH, and able to launch a headed browser on this machine.",
  ].join("\n");
}

/**
 * Prompt the agent uses to attach to the already-running Chrome instance
 * launched by `handleLaunchChromeDebug()` via CDP on port 9222, instead of
 * spawning a fresh headed browser. Keeps the same "open then snapshot" flow
 * as `buildAgentBrowserPrompt` so the agent has page context.
 * @param {string} url
 * @returns {string}
 */
function buildChromeDebugAttachPrompt(url) {
  return [
    `Attach to the already-running Chrome over CDP and inspect its active tab (it should be showing ${url}). Do NOT call "open" — Chrome already has the page in its single tab, and "open" over CDP creates a second tab and leaves an empty "New Tab" behind. Just snapshot the tab that is already there.`,
    "Execute agent_browser with exactly these params:",
    "```json",
    JSON.stringify(
      {
        args: ["--cdp", "http://127.0.0.1:9222", "snapshot", "-i"],
        sessionMode: "fresh",
      },
      null,
      2,
    ),
    "```",
    'CRITICAL: this browser is reached over CDP, and the connection does NOT persist between calls. You MUST include ["--cdp", "http://127.0.0.1:9222", ...] AND sessionMode "fresh" on EVERY agent_browser call (snapshot, navigate, click, type, tab). If you drop --cdp or use sessionMode "auto", you land on a blank about:blank session instead of this Chrome.',
    'To go to a different URL, use "navigate <url>" (it reuses the current tab), NOT "open" (which can leave an extra blank tab). Example: {"args":["--cdp","http://127.0.0.1:9222","navigate","https://example.com"],"sessionMode":"fresh"}.',
    'If a snapshot ever comes back empty or shows about:blank, you are on the wrong tab: run {"args":["--cdp","http://127.0.0.1:9222","tab","list"],"sessionMode":"fresh"}, then select the real page with {"args":["--cdp","http://127.0.0.1:9222","tab","<tID>"],"sessionMode":"fresh"} (e.g. t1), then snapshot -i again (also with --cdp + fresh).',
  ].join("\n");
}

/** Remote debugging port shared with `buildChromeDebugAttachPrompt` / Gemini CDP flows. */
const CHROME_DEBUG_PORT = 9222;

/**
 * Candidate Chrome/Chromium executable paths per platform, in preference order.
 * Google Chrome is preferred; Chromium / Edge / Brave are accepted fallbacks so
 * the feature works on stock Linux installs without Google Chrome.
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
function chromeExecutableCandidates(platform) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (platform === "win32") {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData =
      process.env["LOCALAPPDATA"] ||
      path.join(homedir(), "AppData", "Local");
    return [
      path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
    ];
  }
  // Linux and other unix-likes.
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/brave-browser",
  ];
}

/**
 * Resolve a Chrome/Chromium executable for the current platform, or `null` when
 * none is installed at a known location.
 * @returns {string | null}
 */
function resolveChromeExecutable() {
  for (const candidate of chromeExecutableCandidates(process.platform)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Single probe: true when something answers Chrome DevTools `GET /json/version` on the port.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isChromeDebuggerListening(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/json/version",
        family: 4,
        timeout: 900,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Poll until Chrome exposes the DevTools HTTP endpoint (after spawn) or time out.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForChromeRemoteDebugging(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      void isChromeDebuggerListening(port).then((ok) => {
        if (ok) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(
            new Error(
              `Chrome did not expose remote debugging on port ${port} within ${timeoutMs}ms`,
            ),
          );
          return;
        }
        setTimeout(poll, 200);
      });
    };
    poll();
  });
}

/**
 * @param {string} input
 * @returns {string}
 */
function stripWrappingQuotes(input) {
  const trimmed = input.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * @returns {Record<string, unknown>}
 */
function getFreeCodeEnvOverrides() {
  const config = vscode.workspace.getConfiguration("free-code");
  const raw = config.get("env");
  return raw && typeof raw === "object"
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
}

/**
 * @param {string} key
 * @returns {string | undefined}
 */
function readStringSettingOrEnv(key) {
  const fromConfig = getFreeCodeEnvOverrides()[key];
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

/**
 * @param {string} primaryKey
 * @param {string} legacyKey
 * @returns {string | undefined}
 */
function readStringSettingOrEnvWithLegacy(primaryKey, legacyKey) {
  return readStringSettingOrEnv(primaryKey) || readStringSettingOrEnv(legacyKey);
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveInt(raw, fallback) {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @returns {{ base: string, maxChunks: number, maxChars: number }}
 */
function getRagSettings() {
  const base =
    readStringSettingOrEnvWithLegacy("FREE_CODE_RAG_SERVER_URL", "EDO_RAG_SERVER_URL")?.replace(/\/$/, "") ||
    DEFAULT_RAG_BASE;
  const maxChunks = parsePositiveInt(
    readStringSettingOrEnvWithLegacy("FREE_CODE_RAG_MAX_CHUNKS", "EDO_RAG_MAX_CHUNKS"),
    DEFAULT_RAG_MAX_CHUNKS,
  );
  const maxChars = parsePositiveInt(
    readStringSettingOrEnvWithLegacy("FREE_CODE_RAG_MAX_CHARS", "EDO_RAG_MAX_CHARS"),
    DEFAULT_RAG_MAX_CHARS,
  );
  return { base, maxChunks, maxChars };
}

/**
 * @returns {string}
 */
function getKnowledgeBaseRootDir() {
  return path.join(homedir(), ".free-code", "knowledgeBase");
}

/**
 * @param {string} base
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function verifyRagServerKnowledgeBaseRootFromPlugin(base) {
  const expected = path.resolve(getKnowledgeBaseRootDir());
  try {
    const res = await fetch(`${base}/health`, { method: "GET" });
    if (!res.ok) {
      return {
        ok: false,
        error: `RAG server health check failed: ${res.status} ${res.statusText}`,
      };
    }
    const data = await res.json();
    const rawDir =
      data && typeof data === "object" && "knowledge_base_dir" in data
        ? /** @type {{ knowledge_base_dir?: unknown }} */ (data)
            .knowledge_base_dir
        : undefined;
    if (typeof rawDir !== "string" || rawDir.trim().length === 0) {
      return {
        ok: false,
        error:
          "RAG server health response is missing knowledge_base_dir. Start the current free-code-rag server.",
      };
    }
    const actual = path.resolve(rawDir);
    if (actual !== expected) {
      return {
        ok: false,
        error: `RAG server at ${base} is using ${actual}, but FreeCode stores KB files in ${expected}. Stop the old RAG server on port 8085 and start free-code-rag again.`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * Resolve the coding-agent global dir (same defaults as coding-agent getAgentDir()).
 * Respects env overrides if present in the extension host.
 * @returns {string}
 */
function getAgentDirForPlugin() {
  const envDir =
    process.env.FREE_CODE_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
  if (typeof envDir === "string" && envDir.trim().length > 0) {
    const trimmed = envDir.trim();
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2));
    return trimmed;
  }
  return path.join(homedir(), ".free-code", "agent");
}

/**
 * Best-effort read of profiles from ~/.free-code/agent/profiles.json.
 * @returns {{ names: string[]; activeProfile: string | null }}
 */
function loadProfileNamesForPlugin() {
  const profilesPath = path.join(getAgentDirForPlugin(), "profiles.json");
  try {
    const raw = JSON.parse(readFileSync(profilesPath, "utf8"));
    const activeProfile =
      raw && typeof raw === "object" && typeof raw.activeProfile === "string"
        ? raw.activeProfile
        : null;
    const profiles =
      raw &&
      typeof raw === "object" &&
      raw.profiles &&
      typeof raw.profiles === "object"
        ? /** @type {Record<string, unknown>} */ (raw.profiles)
        : {};
    const names = Object.keys(profiles).sort((a, b) => {
      if (a === "default") return -1;
      if (b === "default") return 1;
      return a.localeCompare(b);
    });
    return { names, activeProfile };
  } catch {
    return { names: [], activeProfile: null };
  }
}

/**
 * @typedef {{
 *   themeName: string | null,
 *   ragKnowledgeBase: string | null,
 *   activeModel: { provider: string, id: string } | null,
 *   enabledOptionalToolGroupKeys: string[],
 *   hideAllSkills: boolean,
 *   hiddenSkillNames: string[],
 *   activeDiscoveredAgents: Array<{ name: string, path: string }>,
 * }} PluginSerializedUserProfile
 */

/**
 * Skill names from the current merged prompt (RPC `get_skill_picker_state` rows) that
 * would stay visible if `profile` were applied. Matches coding-agent `visibleSkillNamesForPrompt`.
 * @param {Record<string, unknown> | null | undefined} skillPickerState
 * @param {PluginSerializedUserProfile} profile
 * @returns {string[]}
 */
function visibleSkillNamesForPluginProfile(skillPickerState, profile) {
  const skills =
    skillPickerState &&
    typeof skillPickerState === "object" &&
    Array.isArray(skillPickerState.skills)
      ? skillPickerState.skills
      : [];
  const allNames = [];
  for (const s of skills) {
    if (!s || typeof s !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (s);
    const n = typeof o.name === "string" ? o.name : "";
    if (n) allNames.push(n);
  }
  const hidden = profile.hideAllSkills
    ? new Set(allNames)
    : new Set(profile.hiddenSkillNames);
  return allNames.filter((name) => !hidden.has(name));
}

/**
 * Read `activeModel` from profiles.json (tolerant of `modelId`, numeric ids, extra whitespace).
 * @param {unknown} raw
 * @returns {{ provider: string, id: string } | null}
 */
function readProfileActiveModelFields(raw) {
  if (!raw || typeof raw !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const prov =
    typeof o.provider === "string"
      ? o.provider.trim()
      : typeof o.provider === "number" && Number.isFinite(o.provider)
        ? String(o.provider)
        : "";
  const rid = o.id !== undefined && o.id !== null ? o.id : o.modelId;
  const id =
    typeof rid === "string"
      ? rid.trim()
      : typeof rid === "number" && Number.isFinite(rid)
        ? String(rid)
        : "";
  if (prov && id) return { provider: prov, id };
  return null;
}

/**
 * Map a stored profile model to an entry from `get_available_models` (exact match, then
 * case-insensitive provider, then unique id-only) so `/profile use` still works if casing
 * drifted or the file used alternate keys.
 * @param {{ provider: string, id: string }} wanted
 * @param {unknown[]} models
 * @returns {{ provider: string, id: string } | null}
 */
function resolveProfileModelInAvailableModels(wanted, models) {
  if (!wanted || !Array.isArray(models)) return null;
  const wantP = String(wanted.provider ?? "").trim();
  const wantI = String(wanted.id ?? "").trim();
  if (!wantP || !wantI) return null;
  const low = (s) => s.toLowerCase();

  /** @param {unknown} m */
  const row = (m) => {
    if (!m || typeof m !== "object") return null;
    const o = /** @type {Record<string, unknown>} */ (m);
    const p =
      typeof o.provider === "string"
        ? o.provider
        : typeof o.provider === "number" && Number.isFinite(o.provider)
          ? String(o.provider)
          : "";
    const rawId = o.id !== undefined && o.id !== null ? o.id : o.modelId;
    const i =
      typeof rawId === "string"
        ? rawId
        : typeof rawId === "number" && Number.isFinite(rawId)
          ? String(rawId)
          : "";
    if (!p || !i) return null;
    return { provider: p, id: i };
  };

  for (const m of models) {
    const r = row(m);
    if (r && r.provider === wantP && r.id === wantI) return r;
  }
  for (const m of models) {
    const r = row(m);
    if (r && low(r.provider) === low(wantP) && r.id === wantI) return r;
  }
  const idMatches = [];
  for (const m of models) {
    const r = row(m);
    if (r && r.id === wantI) idMatches.push(r);
  }
  if (idMatches.length === 1) return idMatches[0];
  return null;
}

/**
 * @returns {{ path: string, raw: Record<string, unknown>, activeProfile: string | null, profiles: Record<string, PluginSerializedUserProfile> }}
 */
function loadProfilesDataForPlugin() {
  const profilesPath = path.join(getAgentDirForPlugin(), "profiles.json");
  /** @type {Record<string, unknown>} */
  let raw = {};
  try {
    const parsed = JSON.parse(readFileSync(profilesPath, "utf8"));
    if (parsed && typeof parsed === "object")
      raw = /** @type {Record<string, unknown>} */ (parsed);
  } catch {
    raw = {};
  }
  const activeProfile =
    typeof raw.activeProfile === "string" && raw.activeProfile.length > 0
      ? raw.activeProfile
      : null;
  const profilesRaw =
    raw.profiles && typeof raw.profiles === "object"
      ? /** @type {Record<string, unknown>} */ (raw.profiles)
      : {};
  /** @type {Record<string, PluginSerializedUserProfile>} */
  const profiles = {};
  for (const [name, value] of Object.entries(profilesRaw)) {
    if (!value || typeof value !== "object") continue;
    const p = /** @type {Record<string, unknown>} */ (value);
    const activeModelParsed = readProfileActiveModelFields(p.activeModel);
    profiles[name] = {
      themeName:
        p.themeName === null || p.themeName === undefined
          ? null
          : typeof p.themeName === "string"
            ? p.themeName
            : null,
      ragKnowledgeBase:
        p.ragKnowledgeBase === null || p.ragKnowledgeBase === undefined
          ? null
          : typeof p.ragKnowledgeBase === "string"
            ? p.ragKnowledgeBase
            : null,
      activeModel: activeModelParsed,
      enabledOptionalToolGroupKeys: Array.isArray(
        p.enabledOptionalToolGroupKeys,
      )
        ? p.enabledOptionalToolGroupKeys.filter((x) => typeof x === "string")
        : [],
      hideAllSkills: p.hideAllSkills === true,
      hiddenSkillNames: Array.isArray(p.hiddenSkillNames)
        ? p.hiddenSkillNames.filter((x) => typeof x === "string")
        : [],
      activeDiscoveredAgents: Array.isArray(p.activeDiscoveredAgents)
        ? p.activeDiscoveredAgents
            .filter((x) => x && typeof x === "object")
            .map((x) => {
              const a = /** @type {Record<string, unknown>} */ (x);
              const agentName = typeof a.name === "string" ? a.name : "";
              const agentPath = typeof a.path === "string" ? a.path : "";
              return agentName && agentPath
                ? { name: agentName, path: agentPath }
                : null;
            })
            .filter((x) => x !== null)
        : [],
    };
  }
  return { path: profilesPath, raw, activeProfile, profiles };
}

/**
 * @returns {PluginSerializedUserProfile}
 */
function defaultPluginSerializedProfile() {
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

/**
 * @param {{ path: string, raw: Record<string, unknown> }} data
 */
function persistProfilesDataForPlugin(data) {
  mkdirSync(path.dirname(data.path), { recursive: true });
  writeFileSync(data.path, `${JSON.stringify(data.raw, null, 2)}\n`, "utf8");
}

/**
 * @param {string} kb
 * @returns {string}
 */
function getKnowledgeBaseDir(kb) {
  return path.join(getKnowledgeBaseRootDir(), kb);
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeKbName(raw) {
  const kb = String(raw || "").trim();
  if (!KB_NAME_REGEX.test(kb)) {
    throw new Error("Invalid KB name. Use only letters, numbers, '-' or '_'.");
  }
  return kb;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isAllowedRagExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return RAG_ALLOWED_EXTENSIONS.has(ext);
}

/**
 * @param {string} destPath
 * @returns {boolean}
 */
function isRagKnowledgeSidecarDestPath(destPath) {
  return path
    .basename(destPath)
    .toLowerCase()
    .endsWith(RAG_KNOWLEDGE_SIDECAR_SUFFIX);
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeUserPathArg(raw) {
  const QUOTE_PAIRS = [
    ["'", "'"],
    ['"', '"'],
    ["\u2018", "\u2019"],
    ["\u201c", "\u201d"],
  ];
  let s = String(raw || "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    s = s.trim();
    if (s.length >= 2 && s[0] === "[" && s[s.length - 1] === "]") {
      s = s.slice(1, -1).trim();
      changed = true;
      continue;
    }
    for (const [open, close] of QUOTE_PAIRS) {
      if (
        s.length >= open.length + close.length &&
        s.startsWith(open) &&
        s.endsWith(close)
      ) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
        break;
      }
    }
  }
  while (s.length > 0 && (s[0] === "'" || s[0] === '"')) {
    s = s.slice(1).trim();
  }
  while (s.length > 0) {
    const last = s[s.length - 1];
    if (last === "'" || last === '"') {
      s = s.slice(0, -1).trim();
      continue;
    }
    break;
  }
  return s.trim();
}

/**
 * @param {string} trimmed
 * @returns {{ ok: true, subcommand: "addFile" | "addGroup" | "search" | "list" | "remove", value: string } | { ok: false, error: string }}
 */
function parseRagCommand(trimmed) {
  const rawArgs = trimmed.slice("/rag".length).trim();
  if (!rawArgs) {
    return {
      ok: false,
      error:
        "Usage: /rag addFile <path> | /rag addGroup <folder> | /rag addGithubUrl <url> [subpath] | /rag addDrive <google_drive_url> | /rag search <query> | /rag list | /rag remove <filename> | /rag refresh | /rag schedule [daily|weekly|hourly|<cron>|off]",
    };
  }
  const firstWhitespace = rawArgs.search(/\s/);
  const sub =
    firstWhitespace === -1 ? rawArgs : rawArgs.slice(0, firstWhitespace);
  const value =
    firstWhitespace === -1 ? "" : rawArgs.slice(firstWhitespace + 1).trim();
  if (!RAG_SUBCOMMANDS.has(sub)) {
    return {
      ok: false,
      error: `Unknown subcommand: ${sub}. Try: addFile, addGroup, addGithubUrl, drive, search, list, remove, refresh, schedule`,
    };
  }
  if (
    (sub === "addFile" ||
      sub === "addGroup" ||
      sub === "addGithubUrl" ||
      sub === "addDrive" ||
      sub === "search" ||
      sub === "remove") &&
    !value
  ) {
    return {
      ok: false,
      error:
        sub === "addFile"
          ? "Usage: /rag addFile <file_path>"
          : sub === "addGroup"
            ? "Usage: /rag addGroup <folder_with_files>"
            : sub === "addGithubUrl"
              ? "Usage: /rag addGithubUrl <github_url> [subpath]"
              : sub === "addDrive"
                ? "Usage: /rag addDrive <google_drive_url>"
                : sub === "search"
                  ? "Usage: /rag search <query>"
                  : "Usage: /rag remove <filename>",
    };
  }
  return {
    ok: true,
    subcommand:
      /** @type {"addFile" | "addGroup" | "addGithubUrl" | "addDrive" | "search" | "list" | "remove" | "refresh" | "schedule"} */ (
        sub
      ),
    value,
  };
}

/**
 * @param {string} trimmed
 * @returns {{ ok: true, subcommand: "create" | "delete" | "use" | "list", value: string } | { ok: false, error: string }}
 */
function parseRagKbCommand(trimmed) {
  const rawArgs = trimmed.slice("/rag-kb".length).trim();
  if (!rawArgs) {
    return {
      ok: false,
      error: "Usage: /rag-kb create|delete|use <kb_name> | /rag-kb list",
    };
  }
  const firstWhitespace = rawArgs.search(/\s/);
  const sub =
    firstWhitespace === -1 ? rawArgs : rawArgs.slice(0, firstWhitespace);
  const value =
    firstWhitespace === -1 ? "" : rawArgs.slice(firstWhitespace + 1).trim();
  if (!RAG_KB_SUBCOMMANDS.has(sub)) {
    return {
      ok: false,
      error: `Unknown subcommand: ${sub}. Try: create, delete, use, list`,
    };
  }
  if ((sub === "create" || sub === "delete" || sub === "use") && !value) {
    return {
      ok: false,
      error:
        sub === "create"
          ? "Usage: /rag-kb create <kb_name>"
          : sub === "delete"
            ? "Usage: /rag-kb delete <kb_name>"
            : "Usage: /rag-kb use <kb_name>",
    };
  }
  return {
    ok: true,
    subcommand: /** @type {"create" | "delete" | "use" | "list"} */ (sub),
    value,
  };
}

/**
 * @param {string} base
 * @returns {Promise<{ ok: true, kbs: string[] } | { ok: false, error: string }>}
 */
async function listKnowledgeBasesFromPlugin(base) {
  try {
    const compatible = await verifyRagServerKnowledgeBaseRootFromPlugin(base);
    if (!compatible.ok) return compatible;

    const res = await fetch(`${base}/kbs`, { method: "GET" });
    if (!res.ok)
      return {
        ok: false,
        error: `RAG server: ${res.status} ${res.statusText}`,
      };
    const data = await res.json();
    if (!data || typeof data !== "object" || !("knowledge_bases" in data)) {
      return {
        ok: false,
        error:
          "Invalid response from RAG server (expected { knowledge_bases: string[] }).",
      };
    }
    const kbs = /** @type {{ knowledge_bases: unknown }} */ (data)
      .knowledge_bases;
    if (!Array.isArray(kbs) || !kbs.every((x) => typeof x === "string")) {
      return {
        ok: false,
        error: "Invalid knowledge_bases list from RAG server.",
      };
    }
    return { ok: true, kbs };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {"createkb" | "deletekb"} action
 * @param {string} kb
 * @param {string} base
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function mutateKnowledgeBaseFromPlugin(action, kb, base) {
  try {
    const compatible = await verifyRagServerKnowledgeBaseRootFromPlugin(base);
    if (!compatible.ok) return compatible;

    const res = await fetch(`${base}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kb }),
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body && typeof body === "object" && "detail" in body) {
          const d = /** @type {{ detail?: unknown }} */ (body).detail;
          detail = typeof d === "string" ? d : JSON.stringify(d);
        }
      } catch {
        // ignore JSON parsing errors
      }
      // The plugin unlinks the file locally first. On older servers, /removekb may
      // return 404 if the file is already absent; treat that as successful removal.
      if (res.status === 404 && detail.toLowerCase().includes("not found")) {
        return { ok: true };
      }
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {string} filename
 * @param {string} kb
 * @param {string} base
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function notifyAddKb(filename, kb, base) {
  try {
    const compatible = await verifyRagServerKnowledgeBaseRootFromPlugin(base);
    if (!compatible.ok) return compatible;

    const res = await fetch(`${base}/addkb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, kb }),
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body && typeof body === "object" && "detail" in body) {
          const d = /** @type {{ detail?: unknown }} */ (body).detail;
          detail = typeof d === "string" ? d : JSON.stringify(d);
        }
      } catch {
        // ignore JSON parsing errors
      }
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {string} filename
 * @param {string} kb
 * @param {string} base
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function notifyRemoveKb(filename, kb, base) {
  try {
    const compatible = await verifyRagServerKnowledgeBaseRootFromPlugin(base);
    if (!compatible.ok) return compatible;

    const res = await fetch(`${base}/removekb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, kb }),
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body && typeof body === "object" && "detail" in body) {
          const d = /** @type {{ detail?: unknown }} */ (body).detail;
          detail = typeof d === "string" ? d : JSON.stringify(d);
        }
      } catch {
        // ignore JSON parsing errors
      }
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {string} sourcePath
 * @param {string} cwd
 * @param {string} kb
 * @param {string} base
 * @returns {Promise<{ ok: true, destPath: string } | { ok: false, error: string }>}
 */
async function ragAddFromPlugin(sourcePath, cwd, kb, base) {
  const cleaned = normalizeUserPathArg(sourcePath);
  const resolvedSource = path.resolve(cwd, cleaned);
  if (!existsSync(resolvedSource)) {
    return { ok: false, error: `File not found: ${sourcePath}` };
  }
  try {
    const st = await stat(resolvedSource);
    if (!st.isFile()) return { ok: false, error: `Not a file: ${sourcePath}` };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
  if (!isAllowedRagExtension(resolvedSource)) {
    return {
      ok: false,
      error: `Unsupported file type. Allowed extensions: ${[...RAG_ALLOWED_EXTENSIONS].sort().join(", ")}`,
    };
  }

  const baseName = path.basename(resolvedSource);
  const kbDir = getKnowledgeBaseDir(kb);
  await mkdir(kbDir, { recursive: true });
  const destPath = path.join(kbDir, baseName);

  if (existsSync(destPath)) {
    const removed = await notifyRemoveKb(baseName, kb, base);
    if (!removed.ok) {
      return {
        ok: false,
        error: `Could not replace existing file '${baseName}' in KB '${kb}': ${removed.error}`,
      };
    }
  }

  try {
    await copyFile(resolvedSource, destPath);
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }

  const notify = await notifyAddKb(baseName, kb, base);
  if (!notify.ok) {
    try {
      await unlink(destPath);
    } catch {
      // best-effort rollback
    }
    return {
      ok: false,
      error: `File copied to ${destPath}, but indexer failed: ${notify.error}`,
    };
  }

  return { ok: true, destPath };
}

/**
 * @param {string} folderPath
 * @param {string} cwd
 * @param {string} kb
 * @param {string} base
 * @returns {Promise<{ ok: true, added: string[], skipped: string[], failed: Array<{ file: string, error: string }> } | { ok: false, error: string }>}
 */
async function ragAddGroupFromPlugin(folderPath, cwd, kb, base) {
  const cleaned = normalizeUserPathArg(folderPath);
  const resolvedFolder = path.resolve(cwd, cleaned);
  if (!existsSync(resolvedFolder)) {
    return { ok: false, error: `Folder not found: ${folderPath}` };
  }
  try {
    const st = await stat(resolvedFolder);
    if (!st.isDirectory())
      return { ok: false, error: `Not a folder: ${folderPath}` };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }

  let names = [];
  try {
    names = await readdir(resolvedFolder);
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }

  const added = [];
  const skipped = [];
  const failed = [];

  for (const name of names.sort()) {
    const candidate = path.join(resolvedFolder, name);
    try {
      const st = await stat(candidate);
      if (!st.isFile()) {
        skipped.push(name);
        continue;
      }
    } catch {
      skipped.push(name);
      continue;
    }
    if (!isAllowedRagExtension(candidate)) {
      skipped.push(name);
      continue;
    }
    const r = await ragAddFromPlugin(candidate, cwd, kb, base);
    if (r.ok) added.push(name);
    else failed.push({ file: name, error: r.error });
  }

  return { ok: true, added, skipped, failed };
}

/**
 * @param {string} text
 * @param {string} kb
 * @param {string} base
 * @param {number} maxChunks
 * @param {number} maxChars
 * @returns {Promise<{ ok: true, chunks: string[] } | { ok: false, error: string }>}
 */
async function ragQueryFromPlugin(text, kb, base, maxChunks, maxChars) {
  const q = text.trim();
  if (!q) return { ok: false, error: "Query text is empty." };
  const compatible = await verifyRagServerKnowledgeBaseRootFromPlugin(base);
  if (!compatible.ok) return compatible;

  const url = `${base}/query?text=${encodeURIComponent(q)}&top_k=${maxChunks}&kb=${encodeURIComponent(kb)}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok)
      return {
        ok: false,
        error: `RAG server: ${res.status} ${res.statusText}`,
      };
    const data = await res.json();
    if (!data || typeof data !== "object" || !("results" in data)) {
      return {
        ok: false,
        error:
          "Invalid response from RAG server (expected { results: string[] }).",
      };
    }
    const results = /** @type {{ results: unknown }} */ (data).results;
    if (
      !Array.isArray(results) ||
      !results.every((x) => typeof x === "string")
    ) {
      return { ok: false, error: "Invalid results array from RAG server." };
    }
    const limited = results.slice(0, maxChunks);
    const truncated = [];
    let totalChars = 0;
    for (const chunk of limited) {
      const remaining = maxChars - totalChars;
      if (remaining <= 0) break;
      if (chunk.length <= remaining) {
        truncated.push(chunk);
        totalChars += chunk.length;
      } else {
        truncated.push(`${chunk.slice(0, remaining)}\n[…truncated]`);
        break;
      }
    }
    return { ok: true, chunks: truncated };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {string} kb
 * @returns {Promise<{ ok: true, files: string[] } | { ok: false, error: string }>}
 */
async function ragListFromPlugin(kb) {
  const kbDir = getKnowledgeBaseDir(kb);
  if (!existsSync(kbDir)) return { ok: true, files: [] };
  try {
    const names = await readdir(kbDir);
    const files = [];
    for (const name of names) {
      if (name === SOURCES_FILENAME) continue;
      const p = path.join(kbDir, name);
      try {
        const st = await stat(p);
        if (st.isFile()) files.push(name);
      } catch {
        // skip inaccessible entries
      }
    }
    files.sort();
    return { ok: true, files };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {string} filename
 * @param {string} kb
 * @param {string} base
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function ragRemoveFromPlugin(filename, kb, base) {
  const trimmed = filename.trim();
  if (!trimmed) return { ok: false, error: "Filename is required." };
  if (
    trimmed !== path.basename(trimmed) ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return {
      ok: false,
      error: "Invalid filename (use a base name only, no paths).",
    };
  }
  const kbRoot = path.resolve(getKnowledgeBaseDir(kb));
  const target = path.resolve(kbRoot, trimmed);
  const rel = path.relative(kbRoot, target);
  if (rel.startsWith("..") || rel.includes("..")) {
    return { ok: false, error: "Invalid path." };
  }
  if (!existsSync(target)) {
    return { ok: false, error: `Not found in knowledge base: ${trimmed}` };
  }
  try {
    await unlink(target);
    const notify = await notifyRemoveKb(trimmed, kb, base);
    if (!notify.ok) {
      // Local delete already succeeded. Keep remove UX successful even if the
      // backend is stale or races and reports "not found" during index rebuild.
      return { ok: true };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function spawnAsync(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}\n${stderr.slice(-500)}`));
    });
    proc.on("error", reject);
  });
}

/**
 * @param {string} kb
 * @returns {Array<{ type: string, url?: string, subPath?: string, sourcePath?: string, addedAt: string, lastRefreshedAt?: string }>}
 */
function loadSourcesFromPlugin(kb) {
  const p = path.join(getKnowledgeBaseDir(kb), SOURCES_FILENAME);
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(raw.sources) ? raw.sources : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} kb
 * @param {Array<object>} sources
 * @param {object | undefined} [schedule]
 */
function saveSourcesFromPlugin(kb, sources, schedule) {
  const p = path.join(getKnowledgeBaseDir(kb), SOURCES_FILENAME);
  let existing = {};
  try { existing = JSON.parse(readFileSync(p, "utf-8")); } catch { /* new file */ }
  const data = { ...existing, sources };
  if (schedule === null) delete data.schedule;
  else if (schedule !== undefined) data.schedule = schedule;
  mkdirSync(getKnowledgeBaseDir(kb), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * @param {string} kb
 * @param {string} url
 * @param {string | undefined} subPath
 */
function upsertGithubSourceFromPlugin(kb, url, subPath) {
  const sources = loadSourcesFromPlugin(kb);
  const now = new Date().toISOString();
  const idx = sources.findIndex((s) => s.type === "github" && s.url === url && s.subPath === subPath);
  if (idx >= 0) sources[idx].lastRefreshedAt = now;
  else {
    const entry = { type: "github", url, addedAt: now };
    if (subPath) entry.subPath = subPath;
    sources.push(entry);
  }
  saveSourcesFromPlugin(kb, sources);
}

/**
 * @param {string} kb
 * @param {string} sourcePath
 */
function upsertFileSourceFromPlugin(kb, sourcePath) {
  const sources = loadSourcesFromPlugin(kb);
  const now = new Date().toISOString();
  const idx = sources.findIndex((s) => s.type === "file" && s.sourcePath === sourcePath);
  if (idx >= 0) sources[idx].lastRefreshedAt = now;
  else sources.push({ type: "file", sourcePath, addedAt: now });
  saveSourcesFromPlugin(kb, sources);
}

/**
 * @param {string} kb
 * @returns {{ cron: string, preset?: string, cronJobId?: string, createdAt: string } | undefined}
 */
function loadScheduleConfigFromPlugin(kb) {
  const p = path.join(getKnowledgeBaseDir(kb), SOURCES_FILENAME);
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return raw.schedule;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} kb
 * @param {{ cron: string, preset?: string, cronJobId?: string, createdAt: string } | null} schedule
 */
function saveScheduleConfigFromPlugin(kb, schedule) {
  const sources = loadSourcesFromPlugin(kb);
  saveSourcesFromPlugin(kb, sources, schedule ?? null);
}

/**
 * @param {string} expr
 * @returns {boolean}
 */
function isValidCronExpression(expr) {
  return expr.trim().split(/\s+/).length === 5;
}

/**
 * @param {string} url
 * @param {string} kb
 * @param {string | undefined} subPath
 * @param {string} base
 * @returns {Promise<{ ok: true, added: string[], skipped: string[], failed: Array<{ file: string, error: string }> } | { ok: false, error: string }>}
 */
async function ragAddGithubUrlFromPlugin(url, kb, subPath, base) {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return { ok: false, error: "GitHub URL is required." };
  if (!trimmedUrl.startsWith("https://") && !trimmedUrl.startsWith("git@")) {
    return { ok: false, error: "Invalid URL. Must start with https:// or git@." };
  }
  const tmpBase = await mkdtemp(path.join(tmpdir(), "rag-github-"));
  const cloneTarget = path.join(tmpBase, "repo");
  try {
    try {
      await spawnAsync("git", ["clone", "--depth", "1", trimmedUrl, cloneTarget]);
    } catch (e) {
      return { ok: false, error: `git clone failed: ${toErrorMessage(e)}` };
    }
    const indexRoot = subPath ? path.join(cloneTarget, subPath) : cloneTarget;
    if (!existsSync(indexRoot)) {
      return { ok: false, error: `Path '${subPath}' not found in repository.` };
    }
    try {
      const st = await stat(indexRoot);
      if (!st.isDirectory()) return { ok: false, error: `Path '${subPath}' is not a directory.` };
    } catch (e) {
      return { ok: false, error: toErrorMessage(e) };
    }
    return await ragAddGroupFromPlugin(indexRoot, indexRoot, kb, base);
  } finally {
    try { await rm(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * @param {string} kb
 * @param {string} base
 * @returns {Promise<{ totalAdded: number, totalSkipped: number, errors: string[] }>}
 */
async function ragRefreshFromPlugin(kb, base) {
  const sources = loadSourcesFromPlugin(kb);
  let totalAdded = 0;
  let totalSkipped = 0;
  const errors = [];
  for (const source of sources) {
    if (source.type === "github") {
      const label = source.subPath ? `${source.url} (${source.subPath})` : source.url;
      const res = await ragAddGithubUrlFromPlugin(source.url, kb, source.subPath, base);
      if (!res.ok) { errors.push(`GitHub ${label}: ${res.error}`); }
      else {
        totalAdded += res.added.length;
        totalSkipped += res.skipped.length;
        res.failed.forEach((f) => errors.push(`${label}/${f.file}: ${f.error}`));
        upsertGithubSourceFromPlugin(kb, source.url, source.subPath);
      }
    } else if (source.type === "file") {
      if (!existsSync(source.sourcePath)) {
        errors.push(`File no longer exists: ${source.sourcePath}`);
        continue;
      }
      const res = await ragAddFromPlugin(source.sourcePath, "/", kb, base);
      if (!res.ok) { errors.push(`File ${source.sourcePath}: ${res.error}`); }
      else { totalAdded++; upsertFileSourceFromPlugin(kb, source.sourcePath); }
    }
  }
  return { totalAdded, totalSkipped, errors };
}

/**
 * @param {string} query
 * @param {string[]} chunks
 * @returns {string}
 */
function formatRagSearchPrompt(query, chunks) {
  const header =
    "The following excerpts were retrieved from the local knowledge base (RAG). Use them to ground your answer; if they are insufficient, say so.\n\n";
  const body = chunks
    .map((chunk, idx) => `[${idx + 1}] ${chunk}`)
    .join("\n\n---\n\n");
  return `${header}${body}\n\n---\n\nUser question: ${query.trim()}`;
}

/**
 * @param {string} base
 * @param {string} kb
 * @returns {Promise<{ ok: true, kb: string, files: Array<{ filename: string, content: string, truncated?: boolean }>, message?: string } | { ok: false, error: string, discoverUnsupported?: boolean }>}
 */
async function fetchRagDiscoverFromPlugin(base, kb) {
  try {
    const res = await fetch(`${base}/discover?kb=${encodeURIComponent(kb)}`, {
      method: "GET",
    });
    if (!res.ok) {
      if (res.status === 404) {
        return {
          ok: false,
          error: `RAG server: ${res.status} ${res.statusText}`,
          discoverUnsupported: true,
        };
      }
      return {
        ok: false,
        error: `RAG server: ${res.status} ${res.statusText}`,
      };
    }
    const data = await res.json();
    if (!data || typeof data !== "object" || !Array.isArray(data.files)) {
      return { ok: false, error: "Invalid discover response from RAG server." };
    }
    const files = data.files
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        const o = /** @type {Record<string, unknown>} */ (x);
        const filename = typeof o.filename === "string" ? o.filename : "";
        const content = typeof o.content === "string" ? o.content : "";
        return {
          filename,
          content,
          truncated: o.truncated === true,
        };
      })
      .filter((x) => x.filename && x.content !== undefined);
    const message =
      typeof data.message === "string" && data.message.length > 0
        ? data.message
        : undefined;
    return { ok: true, kb, files, message };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {string} kb
 * @param {{ ok: true, kb: string, files: Array<{ filename: string, content: string, truncated?: boolean }>, message?: string } | { ok: false, error: string, discoverUnsupported?: boolean }} disc
 * @returns {string}
 */
function formatRagDiscoverPromptForPlugin(kb, disc) {
  if (!disc.ok) {
    return `Knowledge base "${kb}" is selected. Metadata overview (GET /discover) could not be loaded: ${disc.error}`;
  }
  const header = `Knowledge base "${kb}" — overview from *.knowledge.md metadata files (these are not returned by /rag search / vector query). Use this to understand what the KB covers.\n\n`;
  if (disc.files.length === 0) {
    return `${header}${disc.message ?? "No *.knowledge.md metadata files in this KB."}`;
  }
  const blocks = disc.files
    .map((f) => {
      const t = f.truncated ? "\n[Truncated by server size limit]" : "";
      return `### ${f.filename}\n${f.content}${t}`;
    })
    .join("\n\n---\n\n");
  const tail = disc.message ? `\n\nNote: ${disc.message}` : "";
  return `${header}${blocks}${tail}`;
}

/**
 * @param {string} trimmed
 * @returns {{ ok: true, subcommand: "ask" | "download" | "open", value: string } | { ok: false, error: string }}
 */
function parseGeminiCommand(trimmed) {
  const rawArgs = trimmed.slice("/gemini".length).trim();
  if (!rawArgs) {
    return {
      ok: false,
      error:
        "Usage: /gemini ask <mensaje> | /gemini download <nombre_del_archivo> | /gemini open [chat_id]",
    };
  }
  const firstWhitespace = rawArgs.search(/\s/);
  const subcommand =
    firstWhitespace === -1 ? rawArgs : rawArgs.slice(0, firstWhitespace);
  const rest =
    firstWhitespace === -1 ? "" : rawArgs.slice(firstWhitespace + 1).trim();
  if (
    subcommand !== "ask" &&
    subcommand !== "download" &&
    subcommand !== "open"
  ) {
    return {
      ok: false,
      error:
        "Usage: /gemini ask <mensaje> | /gemini download <nombre_del_archivo> | /gemini open [chat_id]",
    };
  }
  const value = stripWrappingQuotes(rest);
  if ((subcommand === "ask" || subcommand === "download") && !value) {
    return {
      ok: false,
      error:
        "Usage: /gemini ask <mensaje> | /gemini download <nombre_del_archivo> | /gemini open [chat_id]",
    };
  }
  return { ok: true, subcommand, value };
}

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * @param {string} trimmed
 * @returns {{ kind: "interactive" | "list" } | { kind: "use" | "create" | "delete" | "info", name: string } | { kind: "save", name?: string } | { kind: "error", message: string }}
 */
function parseProfileCommandForPlugin(trimmed) {
  const rawArgs = trimmed.slice("/profile".length).trim();
  if (!rawArgs) return { kind: "interactive" };
  const parts = rawArgs.split(/\s+/).filter(Boolean);
  const sub = parts[0];
  if (sub === "list") {
    return parts.length === 1
      ? { kind: "list" }
      : { kind: "error", message: "usage: /profile list" };
  }
  if (sub === "use") {
    if (parts.length !== 2)
      return { kind: "error", message: "usage: /profile use <name>" };
    return { kind: "use", name: parts[1] };
  }
  if (sub === "info") {
    if (parts.length !== 2)
      return { kind: "error", message: "usage: /profile info <name>" };
    return { kind: "info", name: parts[1] };
  }
  if (sub === "create") {
    if (parts.length !== 2)
      return { kind: "error", message: "usage: /profile create <name>" };
    return { kind: "create", name: parts[1] };
  }
  if (sub === "save") {
    if (parts.length > 2)
      return { kind: "error", message: "usage: /profile save [name]" };
    return parts.length === 2
      ? { kind: "save", name: parts[1] }
      : { kind: "save" };
  }
  if (sub === "delete") {
    if (parts.length !== 2)
      return { kind: "error", message: "usage: /profile delete <name>" };
    return { kind: "delete", name: parts[1] };
  }
  return { kind: "error", message: `unknown subcommand "${sub}"` };
}

/**
 * @param {string} trimmed full prompt starting with /browse
 * @returns {{ ok: true, url: string, instruction: string } | { ok: false, error: string }}
 */
function parseBrowseCommand(trimmed) {
  const rawArgs = trimmed.slice("/browse".length).trim();
  let urlPart;
  let instruction = "";
  if (!rawArgs) {
    urlPart = "https://www.google.com";
  } else {
    const firstWhitespace = rawArgs.search(/\s/);
    if (firstWhitespace === -1) {
      urlPart = rawArgs;
    } else {
      urlPart = rawArgs.slice(0, firstWhitespace).trim();
      instruction = rawArgs.slice(firstWhitespace + 1).trim();
    }
  }
  try {
    const url = normalizeAgentBrowserUrl(urlPart);
    return { ok: true, url, instruction };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {string} message
 * @returns {string}
 */
function buildGeminiPluginPrompt(message) {
  return [
    "Use the gemini-browser skill for this combined write-and-send request.",
    "Do not use `agent_browser` batch. Do not use `agent_browser wait`.",
    "Write the exact message below into Gemini in one `agent_browser` call, verify the input with a separate `agent_browser` snapshot call, click the `Send message` control with another separate `agent_browser` call, then run the post-send blocking bash `sleep 20` plus `agent_browser snapshot -i` cycle described in the skill until Gemini answers or the attempt limit is reached.",
    'Gemini is still answering while `fonticon="stop"` is present. Do not finish until a post-send snapshot shows that the stop icon has disappeared and the response is visible.',
    "Do not finish with a sent/confirmed response until after at least one post-send `sleep 20` and `snapshot -i` check.",
    "",
    "Exact message:",
    "```text",
    message,
    "```",
  ].join("\n");
}

/**
 * @param {string} filename
 * @returns {string}
 */
function buildGeminiDownloadPluginPrompt(filename) {
  return [
    "Use the gemini-download skill for this request.",
    "Use `agent_browser` only and follow the workflow from the skill: snapshot, open the attachment, snapshot, then click `Download` in the viewer dialog.",
    "Do not reuse stale refs from previous snapshots.",
    "",
    "Target filename:",
    "```text",
    filename,
    "```",
  ].join("\n");
}

/**
 * @param {string} chatId
 * @returns {string}
 */
function buildGeminiOpenPluginPrompt(chatId) {
  const normalizedChatId = chatId.replace(/^\/+|\/+$/g, "");
  const targetUrl = normalizedChatId
    ? `https://gemini.google.com/app/${normalizedChatId}`
    : "https://gemini.google.com/app";
  return [
    "Execute agent_browser with exactly these params:",
    "```json",
    JSON.stringify(
      {
        args: ["--cdp", "http://127.0.0.1:9222", "open", targetUrl],
        sessionMode: "fresh",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/**
 * @param {string} trimmed
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function parseDriveCommand(trimmed) {
  const rawArgs = trimmed.slice("/drive".length).trim();
  if (!rawArgs) {
    return { ok: false, error: "Usage: /drive download <url>" };
  }
  const firstWhitespace = rawArgs.search(/\s/);
  const subcommand =
    firstWhitespace === -1 ? rawArgs : rawArgs.slice(0, firstWhitespace);
  const rest =
    firstWhitespace === -1 ? "" : rawArgs.slice(firstWhitespace + 1).trim();
  if (subcommand !== "download") {
    return { ok: false, error: "Usage: /drive download <url>" };
  }
  const value = stripWrappingQuotes(rest);
  if (!value) {
    return { ok: false, error: "Usage: /drive download <url>" };
  }
  try {
    const url = normalizeAgentBrowserUrl(value);
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/**
 * @param {string} trimmed
 * @returns {{ ok: true, subcommand: "plan" | "agent" } | { ok: false, error: string }}
 */
function parseModeCommand(trimmed) {
  const rawArgs = trimmed.slice("/mode".length).trim();
  if (!rawArgs) {
    return { ok: false, error: "Usage: /mode plan | /mode agent" };
  }
  const firstWhitespace = rawArgs.search(/\s/);
  const subcommand =
    firstWhitespace === -1 ? rawArgs : rawArgs.slice(0, firstWhitespace);
  if (subcommand !== "plan" && subcommand !== "agent") {
    return { ok: false, error: "Usage: /mode plan | /mode agent" };
  }
  return { ok: true, subcommand };
}

/**
 * @param {string} url
 * @param {string} projectDir
 * @returns {string}
 */
function buildDriveDownloadPluginPrompt(url, projectDir) {
  return [
    "Execute the following Google Drive download workflow using agent_browser only. Follow each step in order and do not skip steps.",
    "",
    "## Step 1 — Ask the user which format to download",
    "Before opening the browser, use AskUserQuestion to ask the user:",
    '  Question: "Which format would you like to download?"',
    "  Options:",
    '    - label: "PDF (.pdf)",   description: "Download as PDF Document"',
    '    - label: "Word (.docx)", description: "Download as Microsoft Word"',
    '    - label: "Text (.txt)",  description: "Download as plain text"',
    "Wait for the answer and record it as CHOSEN_FORMAT before doing anything else.",
    "",
    "## Step 2 — Open the document",
    "Open this URL in the existing Chrome debug session (already logged in to Google):",
    `  ${url}`,
    `Call agent_browser with args ["--cdp", "http://127.0.0.1:9222", "open", "${url}"] and sessionMode "fresh".`,
    "Wait for the page to fully load.",
    "",
    "## Step 3 — Snapshot the page",
    'Call agent_browser with args ["snapshot", "-i"] to inspect the loaded document.',
    "Verify the document is open and the toolbar is visible before proceeding.",
    "",
    "## Step 4 — Open the File menu",
    'Click the element with id="docs-file-menu" to open the File menu.',
    'Call agent_browser with args ["click", "#docs-file-menu"].',
    'Then snapshot again with args ["snapshot", "-i"] to confirm the menu opened.',
    "",
    "## Step 5 — Click the Download menu item",
    'Find the element whose aria-label contains "Download" (it may appear as "Download d" or similar with a shortcut indicator).',
    "Click it using its ref from the snapshot.",
    'Then snapshot again with args ["snapshot", "-i"] to see the format submenu.',
    "",
    "## Step 6 — Click the chosen format",
    "Based on CHOSEN_FORMAT, find the submenu item whose aria-label CONTAINS the corresponding extension string and click it:",
    '  - PDF (.pdf)   → find element where aria-label contains ".pdf",  e.g. aria-label="PDF Document (.pdf)"',
    '  - Word (.docx) → find element where aria-label contains ".docx", e.g. aria-label="Microsoft Word (.docx)"',
    '  - Text (.txt)  → find element where aria-label contains ".txt",  e.g. aria-label="Plain text (.txt)"',
    "Use the CSS attribute-contains selector to target it, for example:",
    '  agent_browser click [aria-label*=".pdf"]',
    "If the CSS selector does not match, fall back to the ref from the snapshot for the item whose label visually shows the chosen extension.",
    "After clicking the format, do NOT assume the download started — always go to Step 7 and snapshot first to check for the multi-tab export dialog.",
    "",
    "## Step 7 — Switch to All Tabs and export (REQUIRED after every format click)",
    "Take a snapshot with args [\"snapshot\", \"-i\"]. This snapshot is MANDATORY — never assume the download already started without inspecting it first.",
    "In the snapshot, a multi-tab export dialog appears as a heading \"Download\" together with a combobox labeled \"Tab\" (shown like: combobox \"Tab\" ...: Current Tab) and a button \"Export\". Multi-tab Google Docs ALWAYS show this dialog, and you MUST switch the tab selector to \"All Tabs\" before exporting. Target elements by their snapshot ref, not by CSS.",
    "  1. Click the ref of the combobox labeled \"Tab\" (its value reads \"Current Tab\") to open it.",
    "  2. Snapshot again with args [\"snapshot\", \"-i\"]. The opened listbox now lists option \"Current Tab\" and option \"All Tabs\".",
    "  3. Click the ref of the option \"All Tabs\".",
    "  4. Snapshot once more and confirm the \"Tab\" combobox now reads \"All Tabs\" (not \"Current Tab\") before continuing.",
    "  5. Click the ref of the button \"Export\" to start the download.",
    "Only if the snapshot has NO \"Download\" dialog (no combobox labeled \"Tab\" and no \"Export\" button) does the document have a single tab and the download already started — in that case skip to Step 8.",
    "",
    "## Step 8 — Wait for the download to complete",
    "Run this bash command to wait up to 30 seconds for a new file to appear in ~/Downloads:",
    "```bash",
    `DEST="$HOME/Downloads"`,
    `BEFORE=$(ls -t "$DEST" | head -5)`,
    `sleep 5`,
    `for i in $(seq 1 5); do`,
    `  AFTER=$(ls -t "$DEST" | head -5)`,
    `  if [ "$BEFORE" != "$AFTER" ]; then break; fi`,
    `  sleep 3`,
    `done`,
    "```",
    "",
    "## Step 9 — Identify the downloaded file",
    "Run this bash command to find the most recently downloaded file:",
    "```bash",
    `find "$HOME/Downloads" -maxdepth 1 -newer /tmp/.drive_dl_ref -type f 2>/dev/null | head -5`,
    "```",
    "If that does not work, fall back to:",
    "```bash",
    `ls -t "$HOME/Downloads" | head -3`,
    "```",
    "Record the full absolute path of the downloaded file as DOWNLOADED_FILE.",
    "",
    "## Step 10 — Copy the file to the project",
    `Copy the downloaded file to the project directory: ${projectDir}`,
    "Run:",
    "```bash",
    `cp "$DOWNLOADED_FILE" "${projectDir}/"`,
    "```",
    "Confirm the copy succeeded by listing the file in the project directory.",
    "",
    "## Step 11 — Close the browser",
    'Call agent_browser with args ["close"] to close the browser session.',
    "",
    "## Hard rules",
    "- Use agent_browser for all browser actions. Do not use AppleScript or other automation.",
    "- Do not retry failed downloads. If a step fails, report what was observed and stop.",
    "- Never mutate DOM attributes (no setAttribute calls).",
    "- Resolve all paths to absolute paths — never use ~ in agent_browser download calls.",
    "- Report the final destination path of the copied file when done.",
  ].join("\n");
}

/**
 * @param {string} url
 * @param {string} kb
 * @param {string} kbDir
 * @param {string} ragBase
 * @returns {string}
 */
function buildRagDrivePluginPrompt(url, kb, kbDir, ragBase) {
  return [
    "Execute the following workflow using agent_browser only. Follow each step in order and do not skip steps.",
    "Goal: download a Google Drive document and index it into the RAG knowledge base.",
    "",
    "## Step 1 — Ask the user which format to download",
    "Before opening the browser, use AskUserQuestion to ask the user:",
    '  Question: "Which format would you like to download?"',
    "  Options:",
    '    - label: "PDF (.pdf)",   description: "Download as PDF Document"',
    '    - label: "Word (.docx)", description: "Download as Microsoft Word"',
    '    - label: "Text (.txt)",  description: "Download as plain text"',
    "Wait for the answer and record it as CHOSEN_FORMAT before doing anything else.",
    "",
    "## Step 2 — Open the document",
    "Open this URL in the existing Chrome debug session (already logged in to Google):",
    `  ${url}`,
    `Call agent_browser with args ["--cdp", "http://127.0.0.1:9222", "open", "${url}"] and sessionMode "fresh".`,
    "Wait for the page to fully load.",
    "",
    "## Step 3 — Snapshot the page",
    'Call agent_browser with args ["snapshot", "-i"] to inspect the loaded document.',
    "Verify the document is open and the toolbar is visible before proceeding.",
    "",
    "## Step 4 — Open the File menu",
    'Click the element with id="docs-file-menu" to open the File menu.',
    'Call agent_browser with args ["click", "#docs-file-menu"].',
    'Then snapshot again with args ["snapshot", "-i"] to confirm the menu opened.',
    "",
    "## Step 5 — Click the Download menu item",
    'Find the element whose aria-label contains "Download" (it may appear as "Download d" or similar with a shortcut indicator).',
    "Click it using its ref from the snapshot.",
    'Then snapshot again with args ["snapshot", "-i"] to see the format submenu.',
    "",
    "## Step 6 — Click the chosen format",
    "Based on CHOSEN_FORMAT, find the submenu item whose aria-label CONTAINS the corresponding extension string and click it:",
    '  - PDF (.pdf)   → find element where aria-label contains ".pdf",  e.g. aria-label="PDF Document (.pdf)"',
    '  - Word (.docx) → find element where aria-label contains ".docx", e.g. aria-label="Microsoft Word (.docx)"',
    '  - Text (.txt)  → find element where aria-label contains ".txt",  e.g. aria-label="Plain text (.txt)"',
    "Use the CSS attribute-contains selector, for example:",
    '  agent_browser click [aria-label*=".pdf"]',
    "If the CSS selector does not match, fall back to the ref from the snapshot.",
    "After clicking the format, do NOT assume the download started — always go to Step 7 and snapshot first to check for the multi-tab export dialog.",
    "",
    "## Step 7 — Switch to All Tabs and export (REQUIRED after every format click)",
    "Take a snapshot with args [\"snapshot\", \"-i\"]. This snapshot is MANDATORY — never assume the download already started without inspecting it first.",
    "In the snapshot, a multi-tab export dialog appears as a heading \"Download\" together with a combobox labeled \"Tab\" (shown like: combobox \"Tab\" ...: Current Tab) and a button \"Export\". Multi-tab Google Docs ALWAYS show this dialog, and you MUST switch the tab selector to \"All Tabs\" before exporting. Target elements by their snapshot ref, not by CSS.",
    "  1. Click the ref of the combobox labeled \"Tab\" (its value reads \"Current Tab\") to open it.",
    "  2. Snapshot again with args [\"snapshot\", \"-i\"]. The opened listbox now lists option \"Current Tab\" and option \"All Tabs\".",
    "  3. Click the ref of the option \"All Tabs\".",
    "  4. Snapshot once more and confirm the \"Tab\" combobox now reads \"All Tabs\" (not \"Current Tab\") before continuing.",
    "  5. Click the ref of the button \"Export\" to start the download.",
    "Only if the snapshot has NO \"Download\" dialog (no combobox labeled \"Tab\" and no \"Export\" button) does the document have a single tab and the download already started — in that case skip to Step 8.",
    "",
    "## Step 8 — Wait for the download to complete",
    "Run this bash command to wait up to 30 seconds for a new file to appear in ~/Downloads:",
    "```bash",
    `DEST="$HOME/Downloads"`,
    `BEFORE=$(ls -t "$DEST" | head -5)`,
    `sleep 5`,
    `for i in $(seq 1 5); do`,
    `  AFTER=$(ls -t "$DEST" | head -5)`,
    `  if [ "$BEFORE" != "$AFTER" ]; then break; fi`,
    `  sleep 3`,
    `done`,
    "```",
    "",
    "## Step 9 — Identify the downloaded file",
    "Run this bash command to find the most recently downloaded file:",
    "```bash",
    `find "$HOME/Downloads" -maxdepth 1 -newer /tmp/.drive_dl_ref -type f 2>/dev/null | head -5`,
    "```",
    "If that does not work, fall back to:",
    "```bash",
    `ls -t "$HOME/Downloads" | head -3`,
    "```",
    "Record the full absolute path as DOWNLOADED_FILE and its basename as BASENAME.",
    "",
    "## Step 10 — Copy the file to the RAG knowledge base directory",
    `Copy the downloaded file directly into the KB directory: ${kbDir}`,
    "Run:",
    "```bash",
    `mkdir -p "${kbDir}"`,
    `cp "$DOWNLOADED_FILE" "${kbDir}/"`,
    "```",
    "Confirm the copy succeeded:",
    "```bash",
    `ls "${kbDir}/$BASENAME"`,
    "```",
    "",
    "## Step 11 — Index the file in the RAG server",
    `Call POST ${ragBase}/addkb with body { "filename": "<BASENAME>", "kb": "${kb}" }`,
    "Run:",
    "```bash",
    `curl -s -X POST ${ragBase}/addkb \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d "{\\"filename\\":\\"$BASENAME\\",\\"kb\\":\\"${kb}\\"}"`,
    "```",
    "If the server returns an error, report it but note the file is already saved to the KB directory.",
    "",
    "## Step 12 — Close the browser",
    'Call agent_browser with args ["close"] to close the browser session.',
    "",
    "## Hard rules",
    "- Use agent_browser for all browser actions. Do not use AppleScript or other automation.",
    "- Do not retry failed downloads. If a step fails, report what was observed and stop.",
    "- Never mutate DOM attributes (no setAttribute calls).",
    "- Resolve all paths to absolute paths — never use ~ in agent_browser or cp calls.",
    `- Report the final destination: ${kbDir}/<BASENAME> indexed into KB '${kb}'.`,
  ].join("\n");
}

/**
 * Fallback export when RPC session export is unavailable: serialize persisted sidebar history.
 * @param {{ role: string, text: string, attachments?: string[] }[]} messages
 * @param {string} [tabLabel]
 */
function formatWebviewTranscriptMarkdown(messages, tabLabel) {
  const lines = ["# Free Code conversation export", ""];
  lines.push(
    `_Exported ${new Date().toISOString()}. Sidebar transcript${tabLabel ? ` (${tabLabel})` : ""}. Prefer **Export** when the RPC session is active for full fidelity (thinking/tools match the session file)._`,
  );
  lines.push("");
  for (const m of messages) {
    if (!m || typeof m.role !== "string") continue;
    const role = m.role;
    const text = typeof m.text === "string" ? m.text : "";
    const att = Array.isArray(m.attachments)
      ? m.attachments.filter((p) => typeof p === "string" && p.length > 0)
      : [];
    lines.push(`## ${role}`);
    lines.push("");
    if (att.length > 0) {
      lines.push("Attachments:");
      for (const p of att) {
        lines.push(`- \`${p}\``);
      }
      lines.push("");
    }
    if (
      role === "tool_call" ||
      role === "tool_result" ||
      role === "subagent_widget"
    ) {
      lines.push("```json");
      lines.push(text || "{}");
      lines.push("```");
    } else {
      lines.push(text.length > 0 ? text : "_empty_");
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Attempt to start the local RAG server before spawning the RPC agent.
 * Errors are silently ignored to not block agent startup.
 * @param {string} agentDir Agent root directory (~/.free-code/agent)
 */
async function maybeStartRagServerForRpc(agentDir) {
  try {
    const { maybeStartRagServer } = await import("@free/pi-coding-agent");
    const result = await maybeStartRagServer({ agentDir });
    if (result.outcome === "ok") {
      // RAG server is ready
    } else if (result.outcome === "timeout") {
      // Server didn't start in time, but agent can still run without RAG
    }
    // "skipped" outcomes are silent (no config, auto-disabled, etc.)
  } catch {
    // Silently ignore errors - RAG is optional and shouldn't block agent startup
  }
}

class RpcClient {
  constructor(options = {}) {
    this.options = options;
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.listeners = [];
    this.stopReader = null;
    this.stderr = "";
  }

  onEvent(listener) {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  async start() {
    if (this.process) return;
    const {
      command = "free-code",
      spawnArgsPrefix = [],
      cwd,
      provider,
      model,
      childEnv,
      noExtensions = false,
      noAgentsFiles = false,
    } = this.options;

    // Start RAG server before spawning agent (best-effort, won't block if fails)
    const agentDir = resolveCodingAgentAgentRoot();
    await maybeStartRagServerForRpc(agentDir);

    const args = [...spawnArgsPrefix, "--mode", "rpc"];
    if (noExtensions) args.push("--no-extensions");
    if (noAgentsFiles) args.push("--no-agents-files");
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);

    this.process = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv || process.env,
    });

    this.process.stderr?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      this.stderr += text;
      // Keep stderr attached to extension host output for diagnostics.
    });

    this.stopReader = attachJsonlReader(this.process.stdout, (line) =>
      this.handleLine(line),
    );

    await delay(120);
    if (this.process.exitCode !== null) {
      throw new Error(
        `free-code exited immediately with code ${this.process.exitCode}`,
      );
    }
  }

  async stop() {
    if (!this.process) return;
    this.stopReader?.();
    this.stopReader = null;
    this.process.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => this.process?.once("exit", resolve)),
      delay(1000).then(() => this.process?.kill("SIGKILL")),
    ]);
    this.process = null;
    this.pending.clear();
  }

  /**
   * Send a prompt to the agent. Always passes `streamingBehavior: "followUp"`
   * so that, if the agent is still streaming the previous turn (UI/host busy
   * state can desync from the backend), the message is queued instead of
   * throwing "Agent is already processing".
   * @param {string} message
   */
  async prompt(message) {
    await this.send({ type: "prompt", message, streamingBehavior: "followUp" });
  }

  /**
   * Best-effort cancellation signal to the agent. We intentionally do **not**
   * register a pending request and do **not** wait for the agent to acknowledge:
   * server-side `session.abort()` calls `agent.waitForIdle()` which can take
   * longer than the normal 30 s RPC timeout while a slow tool / MCP call / HTTP
   * stream is still cancelling. Awaiting the response made the host surface
   * spurious `RPC timeout for command abort` errors in the chat — and pressing
   * Escape multiple times piled up one error per press. The host already does
   * its local cleanup (clearing the pending assistant bubble, etc.) before
   * calling abort; the agent will stop when it can. Any late `response` from
   * the server is harmlessly ignored by `handleLine` because it has no entry
   * in `this.pending`.
   * @returns {Promise<void>}
   */
  async abort() {
    const stdin = this.process?.stdin;
    if (!stdin) return;
    const id = `req_${++this.requestId}`;
    const payload = { type: "abort", id };
    try {
      stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // best-effort signal — never block or throw into the chat.
    }
  }

  /** New agent session; clears backend conversation context. */
  async newSession() {
    await this.send({ type: "new_session" });
  }

  /** @returns {Promise<{ sessionFile?: string } & Record<string, unknown>>} */
  async getState() {
    const r = await this.send({ type: "get_state" });
    return (r && typeof r === "object" && "data" in r && r.data) || {};
  }

  /** @param {string} sessionPath */
  async switchSession(sessionPath) {
    const r = await this.send({ type: "switch_session", sessionPath });
    return r.data;
  }

  /** @returns {Promise<{ name: string, description?: string, source: string }[]>} */
  async getCommands() {
    const r = await this.send({ type: "get_commands" });
    const data = r && typeof r === "object" && "data" in r ? r.data : null;
    const commands =
      data && typeof data === "object" && "commands" in data
        ? data.commands
        : null;
    return Array.isArray(commands) ? commands : [];
  }

  /** @returns {Promise<Record<string, unknown> | null>} */
  async getSessionStats() {
    const r = await this.send({ type: "get_session_stats" });
    const data = r && typeof r === "object" && "data" in r ? r.data : null;
    return data && typeof data === "object" ? data : null;
  }

  /** @returns {Promise<{ path: string }>} */
  async exportMarkdown(outputPath) {
    const r = await this.send({ type: "export_markdown", outputPath });
    const data = r && typeof r === "object" && "data" in r ? r.data : null;
    if (!data || typeof data !== "object" || typeof data.path !== "string") {
      throw new Error("Invalid export_markdown response");
    }
    return /** @type {{ path: string }} */ (data);
  }

  /** @returns {Promise<Record<string, unknown> | null>} */
  async getToolPickerState() {
    const r = await this.send({ type: "get_tool_picker_state" });
    const data = r && typeof r === "object" && "data" in r ? r.data : null;
    return data && typeof data === "object" ? data : null;
  }

  /** @param {string[]} keys */
  async setToolPicker(keys) {
    await this.send({ type: "set_tool_picker", enabledGroupKeys: keys });
  }

  /** @returns {Promise<Record<string, unknown> | null>} */
  async getSkillPickerState() {
    const r = await this.send({ type: "get_skill_picker_state" });
    const data = r && typeof r === "object" && "data" in r ? r.data : null;
    return data && typeof data === "object" ? data : null;
  }

  /** @returns {Promise<Record<string, unknown> | null>} */
  async getAgentPickerState() {
    const r = await this.send({ type: "get_agent_picker_state" });
    const data = r && typeof r === "object" && "data" in r ? r.data : null;
    return data && typeof data === "object" ? data : null;
  }

  /** @param {string[]} names */
  async setAgentPicker(names) {
    await this.send({ type: "set_agent_picker", enabledAgentNames: names });
  }

  /** @param {string[]} names */
  async setSkillPicker(names) {
    await this.send({ type: "set_skill_picker", enabledSkillNames: names });
  }

  /**
   * Fetch the list of models the local free-code can use right now (only those with
   * configured auth, same as the CLI `/model` selector). Used by the webview model picker.
   * @returns {Promise<unknown[]>}
   */
  async getAvailableModels() {
    const r = await this.send({ type: "get_available_models" });
    const data = r && typeof r === "object" && "data" in r ? r.data : null;
    const models =
      data && typeof data === "object" && "models" in data ? data.models : null;
    return Array.isArray(models) ? models : [];
  }

  /**
   * Switch the active session model. Mirrors selecting an entry in the CLI `/model` UI.
   * @param {string} provider
   * @param {string} modelId
   * @returns {Promise<unknown>}
   */
  async setModel(provider, modelId) {
    const r = await this.send({ type: "set_model", provider, modelId });
    return r && typeof r === "object" && "data" in r ? r.data : null;
  }

  /**
   * Send an extension_ui_response back to the agent for a matching extension_ui_request.
   * Fire-and-forget; no correlation is tracked here because the agent-side promise is keyed by `id`.
   * @param {string} id
   * @param {Record<string, unknown>} payload
   */
  sendExtensionUIResponse(id, payload) {
    if (!this.process?.stdin) return;
    const msg = { type: "extension_ui_response", id, ...payload };
    this.process.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  async send(command) {
    if (!this.process?.stdin) throw new Error("RPC client is not started");
    const id = `req_${++this.requestId}`;
    const payload = { ...command, id };

    return new Promise((resolve, reject) => {
      // Session operations reconnect MCP servers and can take up to 90 s.
      const isSessionOp =
        command.type === "new_session" || command.type === "switch_session";
      const timeout = setTimeout(
        () => {
          this.pending.delete(id);
          const stderr = this.stderr.trim();
          const details = stderr ? ` | stderr: ${stderr.slice(-500)}` : "";
          reject(
            new Error(`RPC timeout for command ${command.type}${details}`),
          );
        },
        isSessionOp ? 90000 : 120000,
      );

      this.pending.set(id, {
        commandType: command.type,
        resolve: (response) => {
          clearTimeout(timeout);
          if (!response.success) {
            reject(
              new Error(
                response.error || `RPC command failed: ${command.type}`,
              ),
            );
            return;
          }
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  handleLine(line) {
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }

    if (data?.type === "response" && data?.id && this.pending.has(data.id)) {
      const pending = this.pending.get(data.id);
      this.pending.delete(data.id);
      pending?.resolve(data);
      return;
    }

    // Legacy servers: unknown-command path used to omit `id` on error responses, so clients never
    // matched the pending request and timed out. Match by `command` when a single in-flight type matches.
    if (data?.type === "response" && data?.command && !data.id) {
      /** @type {string|undefined} */
      const cmd = data.command;
      for (const [pendingId, pending] of this.pending) {
        if (cmd && pending.commandType === cmd) {
          this.pending.delete(pendingId);
          pending.resolve(data);
          return;
        }
      }
    }

    if (isAgentProgressEvent(data)) {
      for (const [pendingId, pending] of this.pending) {
        if (pending.commandType === "prompt") {
          this.pending.delete(pendingId);
          pending.resolve({
            type: "response",
            id: pendingId,
            command: "prompt",
            success: true,
          });
          break;
        }
      }
    }

    for (const listener of this.listeners) {
      listener(data);
    }
  }
}

const CHAT_HISTORY_KEY = "freeCode.chatView.history";
const TABS_STORAGE_KEY = "freeCode.chatView.tabs.v1";
const CHAT_HISTORY_MAX = 200;
const AUTO_RECOVERY_IDLE_MS = 60000;
const AUTO_RECOVERY_POLL_MS = 5000;
const AUTO_RECOVERY_STREAMING_STALL_MS = 180000;

/**
 * @param {unknown} t
 * @returns {{ id: string, label: string, sessionPath: string | null, ragKnowledgeBase: string | null, kind?: string, parentTabId?: string, subagentKey?: string, messages: { role: string, text: string, attachments?: string[] }[] }}
 */
function normalizeTab(t) {
  if (!t || typeof t !== "object") {
    return {
      id: randomUUID(),
      label: "New chat",
      sessionPath: null,
      ragKnowledgeBase: null,
      messages: [],
    };
  }
  const o = /** @type {Record<string, unknown>} */ (t);
  const messages = Array.isArray(o.messages)
    ? o.messages
        .filter((e) => e && typeof e === "object")
        .map((e) => {
          const m = /** @type {Record<string, unknown>} */ (e);
          /** @type {{ role: string, text: string, attachments?: string[] }} */
          const entry = {
            role: String(m.role ?? ""),
            text: String(m.text ?? ""),
          };
          if (Array.isArray(m.attachments)) {
            const paths = m.attachments
              .filter((p) => typeof p === "string" && p.length > 0)
              .map((p) => /** @type {string} */ (p));
            if (paths.length > 0) entry.attachments = paths;
          }
          return entry;
        })
        .filter(
          (e) =>
            e.role &&
            (e.text.length > 0 ||
              (Array.isArray(e.attachments) && e.attachments.length > 0)),
        )
        .slice(-CHAT_HISTORY_MAX)
    : [];
  return {
    id: typeof o.id === "string" ? o.id : randomUUID(),
    label: typeof o.label === "string" ? o.label : "New chat",
    sessionPath: typeof o.sessionPath === "string" ? o.sessionPath : null,
    ragKnowledgeBase:
      typeof o.ragKnowledgeBase === "string" && o.ragKnowledgeBase.length > 0
        ? o.ragKnowledgeBase
        : null,
    kind: typeof o.kind === "string" ? o.kind : undefined,
    parentTabId: typeof o.parentTabId === "string" ? o.parentTabId : undefined,
    subagentKey: typeof o.subagentKey === "string" ? o.subagentKey : undefined,
    messages,
  };
}

/**
 * @param {import("vscode").ExtensionContext} context
 * @returns {{ activeId: string, tabs: ReturnType<typeof normalizeTab>[] }}
 */
function loadTabsFromStorage(context) {
  const raw = context.workspaceState.get(TABS_STORAGE_KEY);
  if (
    raw &&
    typeof raw === "object" &&
    /** @type {{ version?: number, tabs?: unknown }} */ (raw).version === 1
  ) {
    const t = /** @type {{ activeId?: string, tabs?: unknown }} */ (raw);
    if (Array.isArray(t.tabs) && t.tabs.length > 0) {
      const tabs = t.tabs.map((x) => normalizeTab(x));
      const activeId =
        typeof t.activeId === "string" && tabs.some((x) => x.id === t.activeId)
          ? t.activeId
          : tabs[0].id;
      return { activeId, tabs };
    }
  }
  const old = context.workspaceState.get(CHAT_HISTORY_KEY);
  if (Array.isArray(old) && old.length > 0) {
    const id = randomUUID();
    const messages = old
      .filter((e) => e && typeof e === "object")
      .map((e) => {
        const m = /** @type {Record<string, unknown>} */ (e);
        return { role: String(m.role ?? ""), text: String(m.text ?? "") };
      })
      .filter((e) => e.role && e.text)
      .slice(-CHAT_HISTORY_MAX);
    return {
      activeId: id,
      tabs: [
        {
          id,
          label: "Chat",
          sessionPath: null,
          ragKnowledgeBase: null,
          messages,
        },
      ],
    };
  }
  const id = randomUUID();
  return {
    activeId: id,
    tabs: [
      {
        id,
        label: "New chat",
        sessionPath: null,
        ragKnowledgeBase: null,
        messages: [],
      },
    ],
  };
}

/**
 * Runtime state that belongs to one chat tab and one RPC child process.
 * Keeping this per tab lets conversations stream independently without sharing
 * session state or "agent busy" state.
 * @param {string} tabId
 */
function createTabRuntime(tabId) {
  return {
    tabId,
    rpcClient: null,
    rpcUnsubscribe: null,
    rpcSessionSynced: false,
    rpcSpawnKey: "",
    currentAssistantMessageId: null,
    pendingAssistantText: "",
    currentThinkingMessageId: null,
    pendingThinkingText: "",
    pendingEditPaths: new Map(),
    subagentWidgets: new Map(),
    subagentResultKeys: new Set(),
    /**
     * Open `extension_ui_request` questionnaires keyed by request id. The webview
     * resolves them via `questionnaire_response` messages; we forward the answers
     * back to the agent over RPC.
     * @type {Map<string, { rpcClient: RpcClient }>}
     */
    pendingQuestionnaires: new Map(),
    agentBusy: false,
    agentTurnId: 0,
    agentLastProgressAt: 0,
    autoRecoverySentForTurn: false,
    autoRecoveryChecking: false,
    autoRecoveryTimer: null,
    /** True while the background warm-up prompt is in flight — suppresses all UI events. */
    warmingUp: false,
    /** @type {(() => void) | null} */
    _warmupResolve: null,
  };
}

export class FreeCodeChatViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    /** @type {Map<string, ReturnType<typeof createTabRuntime>>} */
    this.tabRuntimes = new Map();
    /** @type {ReturnType<typeof normalizeTab>[]} */
    this.tabs = [];
    /** @type {string} */
    this.activeTabId = "";
    /**
     * Workspace folder cwd whose `.git/HEAD` we currently watch for branch changes.
     * Used so we only rebuild the watcher when the workspace folder actually changes.
     * @type {string | null}
     */
    this._gitWatchedCwd = null;
    /**
     * Active fs.watch handle on the directory containing `.git/HEAD` (or `.git/HEAD` itself
     * for worktree git-dirs). Closed and recreated when the workspace cwd changes.
     * @type {import("node:fs").FSWatcher | null}
     */
    this._gitHeadWatcher = null;
    /**
     * Debounce timer for git branch refreshes. Same 500ms cadence as the CLI's
     * `FooterDataProvider.WATCH_DEBOUNCE_MS` so atomic HEAD updates (write-then-rename)
     * are coalesced into a single webview update instead of one per inode change.
     * @type {ReturnType<typeof setTimeout> | null}
     */
    this._gitRefreshTimer = null;
    /** @type {vscode.Disposable | null} */
    this._workspaceFolderListener = null;
    /**
     * Decoration type for added lines (green gutter + background).
     * Created lazily and reused across edits.
     * @type {vscode.TextEditorDecorationType | null}
     */
    this._editAddedDecorationType = null;
    /**
     * Active decoration disposables per editor (cleared on agent_end or new agent_start).
     * @type {Array<{ editor: vscode.TextEditor, type: vscode.TextEditorDecorationType }>}
     */
    this._activeEditorDecorations = [];
    const { activeId, tabs } = loadTabsFromStorage(context);
    this.activeTabId = activeId;
    this.tabs = tabs;
    /**
     * Webview-native questionnaires initiated by the host (not by agent extension_ui_request).
     * requestId -> resolver for a single selected value or null when cancelled.
     * @type {Map<string, (value: string | null) => void>}
     */
    this.pendingHostQuestionnaires = new Map();
    /**
     * Session monitor panel: periodic `get_session_stats` for the active tab.
     * @type {ReturnType<typeof setInterval> | null}
     */
    this._sessionStatsPollTimer = null;
    /** @type {Map<string, Promise<ReturnType<typeof createTabRuntime>>>} */
    this._ensureByTab = new Map();
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(
      (msg) => void this.handleIncomingWebviewMessage(msg),
    );

    webviewView.onDidDispose(() => {
      this.view = null;
      this._workspaceFolderListener?.dispose();
      this._workspaceFolderListener = null;
      this._teardownGitWatcher();
    });

    // Re-emit the workspace indicator (folder name + git branch) whenever VS Code
    // adds/removes a workspace folder, so opening a different repo updates the footer
    // without needing to reload the webview.
    this._workspaceFolderListener?.dispose();
    this._workspaceFolderListener =
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.postWorkspaceIndicator();
      });
  }

  async handleIncomingWebviewMessage(message) {
    if (message?.type === "prompt") {
      const text = typeof message.text === "string" ? message.text : "";
      const attachments = Array.isArray(message.attachments)
        ? message.attachments.filter(
            (p) => typeof p === "string" && p.length > 0,
          )
        : [];
      await this.handlePrompt(text, attachments);
      return;
    }
    if (message?.type === "open_agent_browser") {
      const url = typeof message.url === "string" ? message.url : "";
      const instruction =
        typeof message.instruction === "string" ? message.instruction : "";
      await this.handleOpenAgentBrowser(url, instruction);
      return;
    }
    if (message?.type === "launch_chrome_debug") {
      await this.handleLaunchChromeDebug();
      return;
    }
    if (message?.type === "abort") {
      const tabId = this.activeTabId;
      const runtime = this.getTabRuntime(tabId);
      const tab = this.getTabById(tabId) ?? this.getActiveTab();
      if (tab && tab.messages.length > 0) {
        const last = tab.messages[tab.messages.length - 1];
        if (last.role === "user") {
          tab.messages.pop();
          this.persistTabs();
          if (tab.id === this.activeTabId) {
            this.postToWebview({
              type: "abort_undo",
              text: last.text,
              attachments: Array.isArray(last.attachments)
                ? last.attachments
                : [],
            });
          }
        }
      }
      runtime.pendingAssistantText = "";
      runtime.currentAssistantMessageId = null;
      runtime.pendingThinkingText = "";
      runtime.currentThinkingMessageId = null;
      this._stopAutoRecoveryWatchdog(runtime);
      await runtime.rpcClient?.abort();
      return;
    }
    if (message?.type === "webview_ready") {
      this.postToWebview({
        type: "set_tabs",
        tabs: this.getTabsForWebview(),
        activeId: this.activeTabId,
      });
      this.postToWebview({
        type: "restore_history",
        messages: this.getActiveTab()?.messages ?? [],
      });
      this.postInFlightTurnForActiveTab();
      const runtime = this.getActiveRuntime();
      this.postToWebview({
        type: "busy",
        busy: runtime.agentBusy,
        showWorking: runtime.agentBusy,
      });
      void (async () => {
        try {
          await this.postSlashCommandCatalog();
        } finally {
          void this.postModelIndicator();
        }
      })();
      this.postProfileIndicator();
      this.postWorkspaceIndicator();
      return;
    }
    if (message?.type === "workspace_indicator_click") {
      void this.handleWorkspaceIndicatorClick();
      return;
    }
    if (message?.type === "export_conversation") {
      void this.handleExportConversation();
      return;
    }
    if (message?.type === "request_slash_commands") {
      void this.postSlashCommandCatalog();
      return;
    }
    if (message?.type === "request_session_stats") {
      void (async () => {
        try {
          await this.ensureClientStarted();
          const runtime = this.getActiveRuntime();
          const tab = this.getActiveTab();
          if (!runtime?.rpcClient || !tab) {
            this.postToWebview({
              type: "session_stats_update",
              unavailable: true,
              hint:
                "No RPC agent is connected for this tab yet. Click Load to start free-code and fetch live session stats (same warm-up as sending a message).",
            });
            return;
          }
          await this.waitForSessionMonitorHydration(runtime, tab);
          await this.pushSessionStatsToWebview();
          void this.postModelIndicator();
        } catch {
          this.postToWebview({
            type: "session_stats_update",
            unavailable: true,
            hint:
              "Could not start the free-code RPC agent. Check Free Code: Executable path and your shell PATH, then try Load again.",
          });
        }
      })();
      return;
    }
    if (message?.type === "session_polling") {
      this.clearSessionStatsPolling();
      if (message.enabled === true) {
        this._sessionStatsPollTimer = setInterval(() => {
          void this.pushSessionStatsToWebview();
        }, 5000);
      }
      return;
    }
    if (
      message?.type === "tool_picker_apply" &&
      Array.isArray(message.enabledGroupKeys)
    ) {
      void this.handleToolPickerApply(message.enabledGroupKeys);
      return;
    }
    if (message?.type === "tool_picker_cancel") {
      this.postToWebview({ type: "tool_picker_close" });
      this.postToWebview({ type: "busy", busy: false });
      return;
    }
    if (
      message?.type === "skill_picker_apply" &&
      Array.isArray(message.enabledSkillNames)
    ) {
      void this.handleSkillPickerApply(message.enabledSkillNames);
      return;
    }
    if (message?.type === "skill_picker_cancel") {
      this.postToWebview({ type: "skill_picker_close" });
      this.postToWebview({ type: "busy", busy: false });
      return;
    }
    if (
      message?.type === "agent_picker_apply" &&
      Array.isArray(message.enabledAgentNames)
    ) {
      void this.handleAgentPickerApply(message.enabledAgentNames);
      return;
    }
    if (message?.type === "agent_picker_cancel") {
      this.postToWebview({ type: "agent_picker_close" });
      this.postToWebview({ type: "busy", busy: false });
      return;
    }
    if (
      message?.type === "model_picker_apply" &&
      typeof message.provider === "string" &&
      typeof message.modelId === "string"
    ) {
      void this.handleModelPickerApply(message.provider, message.modelId);
      return;
    }
    if (message?.type === "model_picker_cancel") {
      this.postToWebview({ type: "model_picker_close" });
      this.postToWebview({ type: "busy", busy: false });
      return;
    }
    if (message?.type === "open_model") {
      void (async () => {
        try {
          await this.ensureClientStarted();
          await this._openModelPickerFlow();
        } catch (error) {
          const errText = rpcToolPickerErrorMessage(error);
          this.postToWebview({ type: "error", text: errText });
          this.postToWebview({ type: "busy", busy: false });
        }
      })();
      return;
    }
    if (message?.type === "new_tab") {
      await this.handleAddTab();
      return;
    }
    if (message?.type === "select_tab" && typeof message.tabId === "string") {
      await this.handleSelectTab(message.tabId);
      return;
    }
    if (message?.type === "close_tab" && typeof message.tabId === "string") {
      await this.handleCloseTab(message.tabId);
      return;
    }
    if (
      message?.type === "rename_tab" &&
      typeof message.tabId === "string" &&
      typeof message.label === "string"
    ) {
      const tab = this.tabs.find((t) => t.id === message.tabId);
      if (tab && message.label.trim()) {
        tab.label = message.label.trim();
        this.persistTabs();
        this.postToWebview({
          type: "set_tabs",
          tabs: this.getTabsForWebview(),
          activeId: this.activeTabId,
        });
      }
      return;
    }
    if (message?.type === "open_file" && typeof message.path === "string") {
      vscode.window.showTextDocument(vscode.Uri.file(message.path)).then(
        () => {},
        () => {},
      );
      return;
    }
    if (message?.type === "drop_request") {
      vscode.window
        .showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: true,
        })
        .then(async (res) => {
          if (!res || res.length === 0) return;
          const paths = await resolveSelectionPaths(res);
          if (paths.length > 0)
            this.postToWebview({ type: "insert_paths", paths });
        });
      return;
    }
    if (
      message?.type === "questionnaire_response" &&
      typeof message.requestId === "string"
    ) {
      if (this.handleHostQuestionnaireResponse(message)) return;
      this.handleQuestionnaireResponse(message);
      return;
    }
  }

  dispatchWebviewMessage(message) {
    return this.handleIncomingWebviewMessage(message);
  }

  clearSessionStatsPolling() {
    if (this._sessionStatsPollTimer) {
      clearInterval(this._sessionStatsPollTimer);
      this._sessionStatsPollTimer = null;
    }
  }

  /** Stats shape expected by `media/chat.js` `updateSessionMonitor` when RPC is unavailable. */
  emptySessionMonitorStats() {
    return {
      totalMessages: 0,
      toolCalls: 0,
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      contextUsage: { tokens: 0, contextWindow: 0, percent: 0 },
    };
  }

  async pushSessionStatsToWebview() {
    const runtime = this.getActiveRuntime();
    if (!runtime.rpcClient) {
      this.postToWebview({
        type: "session_stats_update",
        unavailable: true,
        hint:
          "No RPC agent is connected for this tab yet. Click Load to start free-code and fetch live session stats (same warm-up as sending a message).",
      });
      return;
    }
    try {
      const stats = await runtime.rpcClient.getSessionStats();
      this.postToWebview({
        type: "session_stats_update",
        stats,
        unavailable: false,
      });
    } catch {
      this.postToWebview({
        type: "session_stats_update",
        unavailable: true,
        hint:
          "Session stats could not be read right now (try again after the current turn finishes, or click Load).",
      });
    }
  }

  /**
   * After spawn + sync, the child can still be loading the session JSONL or resolving the
   * model while `get_session_stats` already returns zeros. Poll `get_state` briefly so the
   * Session monitor keeps showing "Loading…" instead of an empty grid for many seconds.
   * @param {ReturnType<typeof createTabRuntime>} runtime
   * @param {ReturnType<typeof normalizeTab>} tab
   */
  async waitForSessionMonitorHydration(runtime, tab) {
    if (!runtime?.rpcClient || !tab) return;
    const stepMs = 350;
    const maxMs = 45000;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      try {
        const st = await runtime.rpcClient.getState();
        if (this.sessionMonitorRpcLooksHydrated(tab, st)) return;
      } catch {
        /* RPC may be restarting; keep polling until deadline */
      }
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  /**
   * @param {ReturnType<typeof normalizeTab>} tab
   * @param {Record<string, unknown>} st
   */
  sessionMonitorRpcLooksHydrated(tab, st) {
    if (!st || typeof st.messageCount !== "number") return false;
    if (!st.model) return false;

    if (tab.sessionPath && String(tab.sessionPath).trim()) {
      if (typeof st.sessionFile !== "string" || !st.sessionFile.trim()) {
        return false;
      }
      try {
        if (
          path.resolve(String(tab.sessionPath)) !==
          path.resolve(String(st.sessionFile))
        ) {
          return false;
        }
      } catch {
        if (String(tab.sessionPath) !== String(st.sessionFile)) return false;
      }
    }

    const restoredUiRows = Array.isArray(tab.messages) ? tab.messages.length : 0;
    if (restoredUiRows > 0 && st.messageCount === 0) return false;

    return true;
  }

  /** Cwd passed to the spawned `free-code` RPC process (matches `ensureClientStarted`). */
  getFreeCodeSpawnCwd() {
    const config = vscode.workspace.getConfiguration("free-code");
    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    const configuredCwd = config.get("cwd", "");
    return configuredCwd || workspaceCwd || process.cwd();
  }

  /**
   * When the UI tab has restored messages but no `sessionPath` (e.g. legacy storage),
   * attach the newest workspace session JSONL so `get_session_stats` matches the conversation.
   * @param {ReturnType<typeof createTabRuntime>} runtime
   * @param {ReturnType<typeof normalizeTab>} tab
   */
  async tryRecoverTabSessionFromDisk(runtime, tab) {
    if (!runtime.rpcClient || tab.sessionPath) return;
    if (!Array.isArray(tab.messages) || tab.messages.length === 0) return;
    const cwd = this.getFreeCodeSpawnCwd();
    const sessionDir = path.join(
      resolveCodingAgentAgentRoot(),
      "sessions",
      encodeDefaultSessionSubdir(cwd),
    );
    if (!existsSync(sessionDir)) return;
    let names;
    try {
      names = await readdir(sessionDir);
    } catch {
      return;
    }
    /** @type {{ full: string; mtime: number }[]} */
    const ranked = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(sessionDir, name);
      try {
        const st = await stat(full);
        ranked.push({ full, mtime: st.mtimeMs });
      } catch {
        // skip
      }
    }
    ranked.sort((a, b) => b.mtime - a.mtime);
    const best = ranked[0]?.full;
    if (!best) return;
    try {
      await runtime.rpcClient.switchSession(best);
      tab.sessionPath = best;
      this.persistTabs();
    } catch {
      // incompatible or unreadable session file
    }
  }

  getActiveTab() {
    const t = this.tabs.find((x) => x.id === this.activeTabId);
    return t ?? this.tabs[0];
  }

  /** @param {string | null | undefined} tabId */
  getTabById(tabId) {
    return tabId ? (this.tabs.find((x) => x.id === tabId) ?? null) : null;
  }

  /** @param {string | null | undefined} tabId */
  getTabRuntime(tabId) {
    const id = tabId || this.activeTabId;
    let runtime = this.tabRuntimes.get(id);
    if (!runtime) {
      runtime = createTabRuntime(id);
      this.tabRuntimes.set(id, runtime);
    }
    return runtime;
  }

  getActiveRuntime() {
    return this.getTabRuntime(this.activeTabId);
  }

  getTabsForWebview() {
    return this.tabs.map((x) => ({ id: x.id, label: x.label }));
  }

  persistTabs() {
    void this.context.workspaceState.update(TABS_STORAGE_KEY, {
      version: 1,
      activeId: this.activeTabId,
      tabs: this.tabs,
    });
  }

  /**
   * @param {string | null | undefined} tabId
   * @param {Record<string, unknown>} payload
   */
  postToWebviewForTab(tabId, payload) {
    if (!tabId || tabId === this.activeTabId) {
      this.postToWebview(payload);
    }
  }

  /**
   * @param {ReturnType<typeof createTabRuntime>} runtime
   * @param {Record<string, unknown>} payload
   */
  postToWebviewForRuntime(runtime, payload) {
    this.postToWebviewForTab(runtime.tabId, payload);
  }

  /** @param {ReturnType<typeof createTabRuntime>} runtime */
  _startAutoRecoveryWatchdog(runtime) {
    this._stopAutoRecoveryWatchdog(runtime);
    runtime.agentBusy = true;
    runtime.agentTurnId += 1;
    runtime.agentLastProgressAt = Date.now();
    runtime.autoRecoverySentForTurn = false;
    runtime.autoRecoveryTimer = setInterval(() => {
      void this._checkAutoRecovery(runtime);
    }, AUTO_RECOVERY_POLL_MS);
  }

  /** @param {ReturnType<typeof createTabRuntime>} runtime */
  _markAgentProgress(runtime) {
    if (!runtime.agentBusy) return;
    runtime.agentLastProgressAt = Date.now();
  }

  /** @param {ReturnType<typeof createTabRuntime>} runtime */
  _stopAutoRecoveryWatchdog(runtime) {
    runtime.agentBusy = false;
    if (runtime.autoRecoveryTimer) {
      clearInterval(runtime.autoRecoveryTimer);
      runtime.autoRecoveryTimer = null;
    }
    runtime.autoRecoveryChecking = false;
  }

  /**
   * Force recovery when the backend reports `isStreaming=true` for too long
   * without emitting any visible progress events.
   * @param {ReturnType<typeof createTabRuntime>} runtime
   * @param {number} idleMs
   */
  async _forceAutoRecoveryForStreamingStall(runtime, idleMs) {
    runtime.autoRecoverySentForTurn = true;
    const idleSeconds = Math.max(1, Math.floor(idleMs / 1000));
    this.postToWebviewForRuntime(runtime, {
      type: "hint",
      text: `Recovered from stalled streaming state after ${idleSeconds}s without progress. Restarting RPC for this tab.`,
    });
    this.postToWebviewForRuntime(runtime, { type: "status", text: "" });
    this.postToWebviewForRuntime(runtime, { type: "agent_end" });
    this.postToWebviewForTab(runtime.tabId, { type: "busy", busy: false });
    this._stopAutoRecoveryWatchdog(runtime);
    try {
      await this.disposeRpcProcess(runtime.tabId);
    } catch (error) {
      console.error("Free Code: auto-recovery disposeRpcProcess failed", error);
    }
  }

  /** @param {ReturnType<typeof createTabRuntime>} runtime */
  async _checkAutoRecovery(runtime) {
    if (
      !runtime.agentBusy ||
      runtime.autoRecoverySentForTurn ||
      runtime.autoRecoveryChecking ||
      !runtime.rpcClient
    ) {
      return;
    }
    const turnId = runtime.agentTurnId;
    const idleMs = Date.now() - runtime.agentLastProgressAt;
    if (idleMs < AUTO_RECOVERY_IDLE_MS) return;
    runtime.autoRecoveryChecking = true;
    try {
      const state = await runtime.rpcClient.getState();
      if (
        !runtime.agentBusy ||
        turnId !== runtime.agentTurnId ||
        runtime.autoRecoverySentForTurn
      )
        return;
      if (state.isStreaming === true) {
        if (idleMs >= AUTO_RECOVERY_STREAMING_STALL_MS) {
          await this._forceAutoRecoveryForStreamingStall(runtime, idleMs);
          return;
        }
        this.postToWebviewForRuntime(runtime, {
          type: "status",
          text: "Still waiting for model output…",
        });
        return;
      }
      if (runtime.pendingQuestionnaires.size > 0) {
        this.postToWebviewForRuntime(runtime, {
          type: "status",
          text: "Waiting for input…",
        });
        return;
      }
      this.postToWebviewForRuntime(runtime, {
        type: "hint",
        text: "Recovered from stale busy state (agent was no longer streaming).",
      });
      this.postToWebviewForRuntime(runtime, { type: "status", text: "" });
      this.postToWebviewForRuntime(runtime, { type: "agent_end" });
      this.postToWebviewForTab(runtime.tabId, { type: "busy", busy: false });
      this._stopAutoRecoveryWatchdog(runtime);
    } catch (error) {
      if (runtime.agentBusy && turnId === runtime.agentTurnId) {
        const errText = `Auto-recovery failed: ${toErrorMessage(error)}`;
        this.pushHistory("error", errText, undefined, runtime.tabId);
        this.postToWebviewForRuntime(runtime, { type: "error", text: errText });
        this.postToWebviewForTab(runtime.tabId, { type: "busy", busy: false });
        this._stopAutoRecoveryWatchdog(runtime);
      }
    } finally {
      runtime.autoRecoveryChecking = false;
    }
  }

  /**
   * Built-in `/…` entries for the RPC UI (merged with get_commands; always include these for the webview).
   * @returns {{ label: string, slash: string, description: string }[]}
   */
  _pluginSlashCommandBuiltins() {
    return [
      {
        label: "/session",
        slash: "/session",
        description:
          "Session file, id, message counts, tokens, and cost (this tab)",
      },
      {
        label: "/tools",
        slash: "/tools",
        description:
          "List active tools and optional MCP/extension groups (this chat)",
      },
      {
        label: "/pick-tools",
        slash: "/pick-tools",
        description:
          "Toggle optional tool groups to reduce tool definitions in context",
      },
      {
        label: "/files",
        slash: "/files",
        description: "Show files read/written/edited in this session",
      },
      {
        label: "/pick-agent",
        slash: "/pick-agent",
        description: "Enable/disable agent personas in the catalog",
      },
      {
        label: "/pick-skill",
        slash: "/pick-skill",
        description:
          "Enable/disable skills in the system prompt to save tokens",
      },
      {
        label: "/commands",
        slash: "/commands",
        description: "List available slash commands",
      },
      {
        label: "/browse",
        slash: "/browse",
        description:
          "Visible browser (agent_browser): /browse [url] [goal] — optional URL defaults to Google (same flow as the globe button)",
      },
      {
        label: "/gemini",
        slash: "/gemini",
        description:
          "Gemini commands: /gemini ask <mensaje> | /gemini download <archivo> | /gemini open [chat_id]",
      },
      {
        label: "/drive",
        slash: "/drive",
        description:
          "Google Drive download: /drive download <url> — opens the doc in the browser, asks for format (PDF/DOCX/TXT), and copies the file to the project",
      },
      {
        label: "/rag",
        slash: "/rag",
        description:
          "RAG commands: /rag addFile <path> | /rag addGroup <folder> | /rag addGithubUrl <url> [subpath] | /rag addDrive <google_drive_url> | /rag search <query> | /rag list | /rag remove <filename> | /rag refresh | /rag schedule [daily|weekly|hourly|<cron>|off]",
      },
      {
        label: "/rag-kb",
        slash: "/rag-kb",
        description:
          "RAG KB commands: /rag-kb create <name> | /rag-kb delete <name> | /rag-kb use <name> | /rag-kb list",
      },
      {
        label: "/sh",
        slash: "/sh",
        description:
          "Run a shell command directly (not sent to the agent): /sh <command> | /sh reset",
      },
      {
        label: "/pick-theme",
        slash: "/pick-theme",
        description: "Pick a theme and optionally persist it as default",
      },
      {
        label: "/profile",
        slash: "/profile",
        description:
          "Session profiles: /profile list | info <name> | use <name> | create <name> | save [name] | delete <name> | /profile (menu). Saves tools, skills, agents, theme, active model, and selected RAG KB.",
      },
      {
        label: "/mode",
        slash: "/mode",
        description:
          "Switch behavior mode: /mode plan (read-only planning workflow) | /mode agent (normal editing mode).",
      },
      {
        label: "/model",
        slash: "/model",
        description:
          "Select the active model (or `/model <id> [<provider>]` to set it directly, e.g. `/model gemini-2.5-flash [google-vertex]`)",
      },
      {
        label: "/sub",
        slash: "/sub",
        description: "Spawn a subagent with live widget: /sub <task>",
      },
      {
        label: "/login",
        slash: "/login",
        description:
          "OAuth login: /login (pick provider) or /login <providerId> — opens the system browser when required",
      },
      {
        label: "/logout",
        slash: "/logout",
        description:
          "OAuth logout: /logout (pick provider) or /logout <providerId> — removes tokens from auth.json",
      },
      {
        label: "/codeGraph-index",
        slash: "/codeGraph-index",
        description:
          "Index the project code graph. Use --force to re-index all files.",
      },
      {
        label: "/codeGraph-symbols",
        slash: "/codeGraph-symbols",
        description:
          "Search symbols by name. Usage: /codeGraph-symbols <query> [--kind function|class|...] [--limit n]",
      },
      {
        label: "/codeGraph-callers",
        slash: "/codeGraph-callers",
        description:
          "Find all callers of a function or method. Usage: /codeGraph-callers <name> [--limit n]",
      },
      {
        label: "/codeGraph-context",
        slash: "/codeGraph-context",
        description:
          "Get source and callees of a symbol. Usage: /codeGraph-context <name> [--file <partial-path>]",
      },
    ];
  }

  /** Fetches get_commands from free-code and merges plugin builtins for the webview slash menu. */
  async postSlashCommandCatalog() {
    const fallback = {
      type: "slash_commands",
      commands: this._pluginSlashCommandBuiltins(),
      skills: [],
    };
    try {
      const runtime = await this.ensureClientStarted(this.activeTabId);
      if (!runtime.rpcClient) {
        this.postToWebview(fallback);
        return;
      }
      const fromRpc = await runtime.rpcClient.getCommands();
      /** @type {typeof fallback.commands} */
      const skills = [];
      /** @type {typeof fallback.commands} */
      const commands = [...this._pluginSlashCommandBuiltins()];
      const seen = new Set(commands.map((c) => c.slash));
      for (const c of fromRpc) {
        if (!c || typeof c.name !== "string") continue;
        const rawName = c.name.trim().replace(/^\//, "");
        if (!rawName || !RPC_WEBVIEW_SLASH_ALLOWLIST.has(rawName)) continue;
        const slash = c.name.startsWith("/") ? c.name : `/${c.name}`;
        if (seen.has(slash)) continue;
        seen.add(slash);
        const item = {
          label: slash,
          slash,
          description: typeof c.description === "string" ? c.description : "",
        };
        if (c.source === "skill") skills.push(item);
        else commands.push(item);
      }
      this.postToWebview({ type: "slash_commands", commands, skills });
    } catch {
      this.postToWebview(fallback);
    }
  }

  async syncSessionAfterRpcStart(runtime) {
    if (!runtime.rpcClient || runtime.rpcSessionSynced) return;
    runtime.rpcSessionSynced = true;
    const active = this.getTabById(runtime.tabId);
    if (!active) return;
    try {
      const st = await runtime.rpcClient.getState();
      if (
        active.sessionPath &&
        st.sessionFile &&
        active.sessionPath !== st.sessionFile
      ) {
        try {
          await runtime.rpcClient.switchSession(active.sessionPath);
        } catch {
          await runtime.rpcClient.newSession();
          const st2 = await runtime.rpcClient.getState();
          if (st2.sessionFile) active.sessionPath = st2.sessionFile;
        }
      } else if (!active.sessionPath && st.sessionFile) {
        if (!Array.isArray(active.messages) || active.messages.length === 0) {
          active.sessionPath = st.sessionFile;
        }
      }
      if (
        !active.sessionPath &&
        Array.isArray(active.messages) &&
        active.messages.length > 0
      ) {
        await this.tryRecoverTabSessionFromDisk(runtime, active);
      }
      this.persistTabs();
      if (active.id === this.activeTabId) await this.postModelIndicator();
    } catch (e) {
      console.error("Free Code: syncSessionAfterRpcStart", e);
    }
  }

  /**
   * Persist the buffered thinking text (if any) into `tab.messages` as a `thinking`
   * entry, then clear the per-turn thinking state. Called at the same boundaries
   * the assistant bubble is flushed (`tool_execution_start`, `agent_end`) so the
   * stored history preserves the visual order: `[…, thinking, assistant, tool, …]`
   * exactly as the chat was rendered. Without this, `restore_history` (window/tab
   * reload, sidebar hide/show fallback) would re-render the chat without the
   * thinking blocks even though the user already saw them stream.
   * @param {ReturnType<typeof createTabRuntime>} runtime
   */
  flushThinking(runtime) {
    if (runtime.pendingThinkingText) {
      this.pushHistory(
        "thinking",
        runtime.pendingThinkingText,
        undefined,
        runtime.tabId,
      );
    }
    runtime.pendingThinkingText = "";
    runtime.currentThinkingMessageId = null;
  }

  postInFlightTurnForActiveTab() {
    const runtime = this.getActiveRuntime();
    if (!runtime.agentBusy) return;
    if (runtime.currentThinkingMessageId && runtime.pendingThinkingText) {
      this.postToWebview({
        type: "thinking_start",
        messageId: runtime.currentThinkingMessageId,
      });
      this.postToWebview({
        type: "thinking_delta",
        messageId: runtime.currentThinkingMessageId,
        text: runtime.pendingThinkingText,
      });
    }
    if (runtime.currentAssistantMessageId) {
      this.postToWebview({
        type: "assistant_message_start",
        messageId: runtime.currentAssistantMessageId,
      });
      if (runtime.pendingAssistantText) {
        this.postToWebview({
          type: "assistant_message_delta",
          messageId: runtime.currentAssistantMessageId,
          text: runtime.pendingAssistantText,
        });
      }
    }
  }

  /**
   * @param {string} role
   * @param {string} text
   * @param {string[]} [attachments]
   * @param {string | null} [tabId]
   */
  pushHistory(role, text, attachments, tabId = null) {
    const tab = tabId ? this.getTabById(tabId) : this.getActiveTab();
    if (!tab) return;
    const paths = Array.isArray(attachments)
      ? attachments.filter((p) => typeof p === "string" && p.length > 0)
      : [];
    if (!text && paths.length === 0) return;
    /** @type {{ role: string, text: string, attachments?: string[] }} */
    const entry = { role, text };
    if (paths.length > 0) entry.attachments = paths;
    tab.messages.push(entry);
    if (tab.messages.length > CHAT_HISTORY_MAX) {
      tab.messages = tab.messages.slice(-CHAT_HISTORY_MAX);
    }
    this.persistTabs();
  }

  /**
   * @param {ReturnType<typeof createTabRuntime>} runtime
   * @param {string} widgetKey
   * @param {string[]} lines
   */
  upsertSubagentWidget(runtime, widgetKey, lines) {
    const match = widgetKey.match(/^sub-(.+)$/);
    if (!match) return;
    const subagentId = getSubagentDisplayId(lines) ?? match[1];
    let meta = runtime.subagentWidgets.get(widgetKey);
    if (!meta) {
      const subTabId = randomUUID();
      meta = {
        widgetKey,
        subagentId,
        tabId: subTabId,
        parentTabId: runtime.tabId,
      };
      runtime.subagentWidgets.set(widgetKey, meta);
      this.tabs.push({
        id: subTabId,
        label: `Subagent #${subagentId}`,
        sessionPath: null,
        ragKnowledgeBase: null,
        kind: "subagent",
        parentTabId: runtime.tabId,
        subagentKey: widgetKey,
        messages: [],
      });
      this.postToWebview({
        type: "set_tabs",
        tabs: this.getTabsForWebview(),
        activeId: this.activeTabId,
      });
    }
    const parentPayload = JSON.stringify({
      widgetKey,
      tabId: meta.tabId,
      lines,
      expanded: false,
    });
    const subagentPayload = JSON.stringify({
      widgetKey,
      tabId: meta.tabId,
      lines,
      expanded: true,
    });
    this.upsertHistoryEntry(
      runtime.tabId,
      "subagent_widget",
      parentPayload,
      (entry) => {
        const data = parseJsonObject(entry.text);
        return data?.widgetKey === widgetKey;
      },
    );
    this.upsertHistoryEntry(
      meta.tabId,
      "subagent_widget",
      subagentPayload,
      (entry) => {
        const data = parseJsonObject(entry.text);
        return data?.widgetKey === widgetKey;
      },
    );
    this.persistTabs();
    this.postToWebviewForTab(runtime.tabId, {
      type: "subagent_widget",
      widgetKey,
      tabId: meta.tabId,
      lines,
      expanded: false,
    });
    this.postToWebviewForTab(meta.tabId, {
      type: "subagent_widget",
      widgetKey,
      tabId: meta.tabId,
      lines,
      expanded: true,
    });
    this.renderSubagentResultFromWidget(runtime, meta, lines);
  }

  /**
   * @param {ReturnType<typeof createTabRuntime>} runtime
   * @param {string} widgetKey
   */
  removeSubagentWidget(runtime, widgetKey) {
    const meta = runtime.subagentWidgets.get(widgetKey);
    if (!meta) return;
    runtime.subagentWidgets.delete(widgetKey);
    const parent = this.getTabById(runtime.tabId);
    if (parent)
      parent.messages = parent.messages.filter((entry) => {
        if (entry.role !== "subagent_widget") return true;
        return parseJsonObject(entry.text)?.widgetKey !== widgetKey;
      });
    this.tabs = this.tabs.filter((tab) => tab.id !== meta.tabId);
    if (this.activeTabId === meta.tabId) {
      this.activeTabId = runtime.tabId;
    }
    this.persistTabs();
    this.postToWebview({
      type: "set_tabs",
      tabs: this.getTabsForWebview(),
      activeId: this.activeTabId,
    });
    this.postToWebviewForTab(runtime.tabId, {
      type: "restore_history",
      messages: parent?.messages ?? [],
    });
  }

  /**
   * @param {ReturnType<typeof createTabRuntime>} runtime
   * @param {{ widgetKey: string, subagentId: string, tabId: string, parentTabId: string }} meta
   * @param {string[]} lines
   */
  renderSubagentResultFromWidget(runtime, meta, lines) {
    const header = lines[0]?.trim() || "";
    if (!header.startsWith("✓") && !header.startsWith("✗")) return;
    if (runtime.subagentResultKeys.has(meta.widgetKey)) return;
    const detailStart = lines.findIndex((line) =>
      line.startsWith(`Subagent #${meta.subagentId}`),
    );
    if (detailStart === -1) return;
    runtime.subagentResultKeys.add(meta.widgetKey);
    const text = `[subagent-result]\n\n${lines.slice(detailStart).join("\n").trimEnd()}`;
    this.pushHistory("custom", text, undefined, runtime.tabId);
    this.postToWebviewForTab(runtime.tabId, { type: "custom_message", text });
    this.pushHistory("custom", text, undefined, meta.tabId);
    this.postToWebviewForTab(meta.tabId, { type: "custom_message", text });
  }

  /**
   * @param {string} tabId
   * @param {string} role
   * @param {string} text
   * @param {(entry: { role: string, text: string, attachments?: string[] }) => boolean} predicate
   */
  upsertHistoryEntry(tabId, role, text, predicate) {
    const tab = this.getTabById(tabId);
    if (!tab) return;
    const existing = tab.messages.findIndex(
      (entry) => entry.role === role && predicate(entry),
    );
    if (existing === -1) {
      tab.messages.push({ role, text });
    } else {
      tab.messages[existing] = { role, text };
    }
    if (tab.messages.length > CHAT_HISTORY_MAX) {
      tab.messages = tab.messages.slice(-CHAT_HISTORY_MAX);
    }
  }

  /**
   * @param {ReturnType<typeof createTabRuntime>} runtime
   * @param {string} text
   */
  appendSubagentResultToTab(runtime, text) {
    const match = text.match(/Subagent #(\d+)/);
    if (!match) return;
    const meta = [...runtime.subagentWidgets.values()].find(
      (value) => value.subagentId === match[1],
    );
    if (!meta) return;
    this.pushHistory("custom", text, undefined, meta.tabId);
    this.postToWebviewForTab(meta.tabId, { type: "custom_message", text });
  }

  handleAddTab() {
    // Pure UI operation — backend session is created lazily on first prompt.
    const id = randomUUID();
    this.tabs.push({
      id,
      label: "New chat",
      sessionPath: null,
      ragKnowledgeBase: null,
      messages: [],
    });
    this.activeTabId = id;
    this.persistTabs();
    this.postToWebview({
      type: "set_tabs",
      tabs: this.getTabsForWebview(),
      activeId: this.activeTabId,
    });
    this.postToWebview({ type: "clear" });
    this.postToWebview({ type: "busy", busy: false });
    void this.postModelIndicator();
    void this.promptProfileOnNewChat(id);
  }

  /**
   * Resolve host-owned questionnaire responses sent from the webview.
   * Returns true when the request id belonged to a host questionnaire.
   * @param {Record<string, unknown>} message
   * @returns {boolean}
   */
  handleHostQuestionnaireResponse(message) {
    const requestId =
      typeof message.requestId === "string" ? message.requestId : "";
    if (!requestId) return false;
    const resolve = this.pendingHostQuestionnaires.get(requestId);
    if (!resolve) return false;
    this.pendingHostQuestionnaires.delete(requestId);
    if (message.cancelled === true) {
      resolve(null);
      return true;
    }
    const answers = Array.isArray(message.answers) ? message.answers : [];
    const first = answers.find((a) => a && typeof a === "object");
    const value =
      first &&
      typeof (/** @type {Record<string, unknown>} */ (first).value) === "string"
        ? /** @type {string} */ (
            /** @type {Record<string, unknown>} */ (first).value
          )
        : null;
    resolve(value);
    return true;
  }

  /**
   * Render profile selection in-chat via the existing questionnaire card.
   * @param {string} tabId
   * @param {string[]} names
   * @param {string | null} activeProfile
   * @returns {Promise<string | null>}
   */
  promptProfileSelectionQuestionnaire(tabId, names, activeProfile) {
    const requestId = `host-profile-${randomUUID()}`;
    const options = names.map((name) => ({
      value: name,
      label: name,
      description: name === activeProfile ? "last used" : undefined,
    }));
    return new Promise((resolve) => {
      this.pendingHostQuestionnaires.set(requestId, resolve);
      this.postToWebviewForTab(tabId, {
        type: "questionnaire_request",
        requestId,
        questions: [
          {
            id: "profile",
            label: "Profile",
            prompt: "Choose a profile to apply in this chat",
            options,
            allowOther: false,
          },
        ],
      });
    });
  }

  /**
   * @param {string} tabId
   * @param {string} profileName
   * @returns {Promise<boolean>}
   */
  promptProfileUseConfirmation(tabId, profileName) {
    const requestId = `host-profile-confirm-${randomUUID()}`;
    return new Promise((resolve) => {
      this.pendingHostQuestionnaires.set(requestId, (value) => {
        resolve(value === "yes");
      });
      this.postToWebviewForTab(tabId, {
        type: "questionnaire_request",
        requestId,
        questions: [
          {
            id: "profile_apply",
            label: "Apply profile",
            prompt: `Use profile "${profileName}" in this chat?`,
            options: [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ],
            allowOther: false,
          },
        ],
      });
    });
  }

  /**
   * @param {string} name
   * @param {PluginSerializedUserProfile} profile
   * @param {string | null} activeProfile
   * @param {Record<string, unknown> | null | undefined} skillPickerState from `get_skill_picker_state`
   * @returns {string}
   */
  formatProfileDetailsForPlugin(
    name,
    profile,
    activeProfile,
    skillPickerState,
  ) {
    const model = profile.activeModel
      ? `${profile.activeModel.provider}/${profile.activeModel.id}`
      : "(none)";
    const toolGroups =
      profile.enabledOptionalToolGroupKeys.length > 0
        ? profile.enabledOptionalToolGroupKeys.join(", ")
        : "(none)";
    const visibleSkills = visibleSkillNamesForPluginProfile(
      skillPickerState,
      profile,
    );
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
      `Profile: ${name}${name === activeProfile ? " *" : ""}`,
      `Theme: ${profile.themeName ?? "(none)"}`,
      `RAG KB: ${profile.ragKnowledgeBase ?? "(none)"}`,
      `Model: ${model}`,
      `Optional tool groups: ${toolGroups}`,
      `Skills (visible in prompt): ${skillsLine}`,
      `Agents: ${agents}`,
    ].join("\n");
  }

  /**
   * Ask which saved profile to load when a new chat tab is created, then apply it with `/profile use`.
   * @param {string} tabId
   */
  async promptProfileOnNewChat(tabId) {
    const tab = this.getTabById(tabId);
    if (!tab) return;
    const { names, activeProfile } = loadProfileNamesForPlugin();
    if (names.length === 0) return;
    const pickedProfile = await this.promptProfileSelectionQuestionnaire(
      tabId,
      names,
      activeProfile,
    );
    if (!pickedProfile) return;

    await this.applyProfileWithoutPrompt(tabId, pickedProfile);
  }

  /**
   * Snapshot current RPC session resources into a serializable profile.
   * @param {RpcClient} rpcClient
   * @param {string} tabId
   * @returns {Promise<PluginSerializedUserProfile>}
   */
  async captureCurrentProfileForPlugin(rpcClient, tabId) {
    const [toolState, skillState, state] = await Promise.all([
      rpcClient.getToolPickerState(),
      rpcClient.getSkillPickerState(),
      rpcClient.getState(),
    ]);
    const enabledOptionalToolGroupKeys =
      toolState && Array.isArray(toolState.groups)
        ? toolState.groups
            .filter(
              (g) =>
                g &&
                typeof g === "object" &&
                /** @type {Record<string, unknown>} */ (g).enabled === true,
            )
            .map((g) =>
              typeof (/** @type {Record<string, unknown>} */ (g).key) ===
              "string"
                ? /** @type {string} */ (
                    /** @type {Record<string, unknown>} */ (g).key
                  )
                : "",
            )
            .filter((key) => key.length > 0)
        : [];
    const allSkills =
      skillState && Array.isArray(skillState.skills)
        ? skillState.skills
            .map((s) => {
              if (!s || typeof s !== "object") return null;
              const o = /** @type {Record<string, unknown>} */ (s);
              const name = typeof o.name === "string" ? o.name : "";
              if (!name) return null;
              return { name, enabled: o.enabled === true };
            })
            .filter((s) => s !== null)
        : [];
    const hiddenSkillNames = allSkills
      .filter((s) => !s.enabled)
      .map((s) => s.name);
    const hideAllSkills =
      allSkills.length > 0 && hiddenSkillNames.length === allSkills.length;
    const modelRaw =
      state &&
      typeof state === "object" &&
      state.model &&
      typeof state.model === "object"
        ? /** @type {Record<string, unknown>} */ (state.model)
        : null;
    const modelProvider =
      modelRaw && typeof modelRaw.provider === "string"
        ? modelRaw.provider
        : "";
    const modelId =
      modelRaw && typeof modelRaw.id === "string" ? modelRaw.id : "";
    const tab = this.getTabById(tabId);
    return {
      themeName: null,
      ragKnowledgeBase:
        tab && typeof tab.ragKnowledgeBase === "string"
          ? tab.ragKnowledgeBase
          : null,
      activeModel:
        modelProvider && modelId
          ? { provider: modelProvider, id: modelId }
          : null,
      enabledOptionalToolGroupKeys,
      hideAllSkills,
      hiddenSkillNames: hideAllSkills ? [] : hiddenSkillNames,
      activeDiscoveredAgents: [],
    };
  }

  /**
   * Apply a profile's default RAG KB for one tab (same effect as `/rag-kb use <name>`).
   * @param {string} tabId
   * @param {PluginSerializedUserProfile} profile
   * @param {string[]} warnings
   */
  async applyProfileRagKnowledgeBase(tabId, profile, warnings) {
    const tab = this.getTabById(tabId) ?? this.getActiveTab();
    if (!tab) return;
    const configuredKb =
      typeof profile.ragKnowledgeBase === "string" &&
      profile.ragKnowledgeBase.trim().length > 0
        ? profile.ragKnowledgeBase.trim()
        : null;
    if (!configuredKb) {
      tab.ragKnowledgeBase = null;
      this.persistTabs();
      return;
    }
    const { base } = getRagSettings();
    const listed = await listKnowledgeBasesFromPlugin(base);
    if (!listed.ok) {
      warnings.push(
        `could not verify RAG KB '${configuredKb}': ${listed.error}`,
      );
      tab.ragKnowledgeBase = null;
      this.persistTabs();
      return;
    }
    if (!listed.kbs.includes(configuredKb)) {
      warnings.push(`RAG KB '${configuredKb}' is not available`);
      tab.ragKnowledgeBase = null;
      this.persistTabs();
      return;
    }
    tab.ragKnowledgeBase = configuredKb;
    this.persistTabs();
    try {
      const disc = await fetchRagDiscoverFromPlugin(base, configuredKb);
      if (disc.ok) {
        const prompt = formatRagDiscoverPromptForPlugin(configuredKb, disc);
        const runtime = await this.ensureClientStarted(tabId);
        if (runtime.rpcClient && prompt.trim().length > 0) {
          await this._ensureBackendOnActiveTab(tabId);
          this._startAutoRecoveryWatchdog(runtime);
          await runtime.rpcClient.prompt(prompt);
        }
      } else if (!disc.discoverUnsupported) {
        warnings.push(`Could not load KB metadata overview: ${disc.error}`);
      } else {
        warnings.push(
          `${configuredKb}: RAG server has no GET /discover (404); *.knowledge.md under ${getKnowledgeBaseDir(configuredKb)} are not injected until free-code-rag is updated.`,
        );
      }
    } catch (error) {
      warnings.push(
        `RAG KB metadata overview was not injected: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Apply a stored profile via RPC control commands (no conversational prompt).
   * @param {string} tabId
   * @param {string} profileName
   */
  async applyProfileWithoutPrompt(tabId, profileName) {
    const data = loadProfilesDataForPlugin();
    const profile = data.profiles[profileName];
    if (!profile) {
      const msg = `Unknown profile "${profileName}"`;
      this.pushHistory("error", msg, undefined, tabId);
      this.postToWebviewForTab(tabId, { type: "error", text: msg });
      this.postToWebviewForTab(tabId, { type: "busy", busy: false });
      return;
    }
    try {
      const runtime = await this.ensureClientStarted(tabId);
      if (!runtime.rpcClient) throw new Error("RPC client not available");

      /** @type {string[]} */
      const warnings = [];
      if (profile.themeName) {
        warnings.push(
          `theme '${profile.themeName}' is not applied by RPC mode`,
        );
      }
      if (profile.activeDiscoveredAgents.length > 0) {
        warnings.push("agent selection is not applied by RPC mode");
      }

      if (profile.activeModel) {
        const models = await runtime.rpcClient.getAvailableModels();
        const resolved = resolveProfileModelInAvailableModels(
          profile.activeModel,
          models,
        );
        if (resolved) {
          try {
            await runtime.rpcClient.setModel(resolved.provider, resolved.id);
            if (tabId === this.activeTabId) await this.postModelIndicator();
          } catch (e) {
            warnings.push(
              `could not set model ${resolved.provider}/${resolved.id}: ${toErrorMessage(e)}`,
            );
          }
        } else {
          warnings.push(
            `model ${profile.activeModel.provider}/${profile.activeModel.id} not in available list (try /profile save after picking the model in /model)`,
          );
        }
      }

      await runtime.rpcClient.setToolPicker(
        profile.enabledOptionalToolGroupKeys,
      );
      const skillState = await runtime.rpcClient.getSkillPickerState();
      const allSkillNames =
        skillState && Array.isArray(skillState.skills)
          ? skillState.skills
              .map((s) =>
                s &&
                typeof s === "object" &&
                typeof (/** @type {Record<string, unknown>} */ (s).name) ===
                  "string"
                  ? /** @type {string} */ (
                      /** @type {Record<string, unknown>} */ (s).name
                    )
                  : "",
              )
              .filter((name) => name.length > 0)
          : [];
      const hidden = new Set(profile.hiddenSkillNames);
      const enabledSkills = profile.hideAllSkills
        ? []
        : allSkillNames.filter((name) => !hidden.has(name));
      await runtime.rpcClient.setSkillPicker(enabledSkills);

      await this.applyProfileRagKnowledgeBase(tabId, profile, warnings);

      data.raw.activeProfile = profileName;
      try {
        persistProfilesDataForPlugin(data);
      } catch {
        warnings.push("could not persist activeProfile on disk");
      }
      this.postProfileIndicator();

      const body =
        warnings.length > 0
          ? `Using profile "${profileName}" (${warnings.join("; ")})`
          : `Using profile "${profileName}"`;
      this.pushHistory("tools", body, undefined, tabId);
      this.postToWebviewForTab(tabId, { type: "tools_info", text: body });
      this.postToWebviewForTab(tabId, { type: "status", text: "" });
      this.postToWebviewForTab(tabId, { type: "busy", busy: false });
    } catch (error) {
      const errText = `Could not load profile: ${toErrorMessage(error)}`;
      this.pushHistory("error", errText, undefined, tabId);
      this.postToWebviewForTab(tabId, { type: "error", text: errText });
      this.postToWebviewForTab(tabId, { type: "busy", busy: false });
    }
  }

  handleSelectTab(tabId) {
    if (tabId === this.activeTabId) return;
    const next = this.tabs.find((t) => t.id === tabId);
    if (!next) return;
    // Pure UI operation — backend session switch happens lazily on next prompt.
    this.activeTabId = tabId;
    this.persistTabs();
    this.postToWebview({
      type: "set_tabs",
      tabs: this.getTabsForWebview(),
      activeId: this.activeTabId,
    });
    this.postToWebview({ type: "restore_history", messages: next.messages });
    this.postInFlightTurnForActiveTab();
    const runtime = this.getActiveRuntime();
    this.postToWebview({
      type: "busy",
      busy: runtime.agentBusy,
      showWorking: runtime.agentBusy,
    });
    void this.postModelIndicator();
    if (this._sessionStatsPollTimer) {
      void this.pushSessionStatsToWebview();
    }
  }

  handleCloseTab(tabId) {
    if (this.tabs.length <= 1) {
      const t = this.getActiveTab();
      if (t) {
        const runtime = this.getActiveRuntime();
        t.messages = [];
        t.label = "New chat";
        t.sessionPath = null;
        t.ragKnowledgeBase = null;
        runtime.pendingAssistantText = "";
        runtime.currentAssistantMessageId = null;
        runtime.pendingThinkingText = "";
        runtime.currentThinkingMessageId = null;
        this._stopAutoRecoveryWatchdog(runtime);
        void this.disposeRpcProcess(t.id);
        this.persistTabs();
        this.postToWebview({
          type: "set_tabs",
          tabs: this.getTabsForWebview(),
          activeId: this.activeTabId,
        });
        this.postToWebview({ type: "clear" });
        this.postToWebview({ type: "busy", busy: false });
        void this.promptProfileOnNewChat(t.id);
      }
      return;
    }
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const wasActive = this.activeTabId === tabId;
    this.tabs.splice(idx, 1);
    if (wasActive) {
      const newIdx = Math.min(idx, this.tabs.length - 1);
      this.activeTabId = this.tabs[newIdx].id;
    }
    this.persistTabs();
    this.postToWebview({
      type: "set_tabs",
      tabs: this.getTabsForWebview(),
      activeId: this.activeTabId,
    });
    if (wasActive) {
      const next = this.getActiveTab();
      this.postToWebview({
        type: "restore_history",
        messages: next?.messages ?? [],
      });
      this.postInFlightTurnForActiveTab();
      const runtime = this.getActiveRuntime();
      this.postToWebview({
        type: "busy",
        busy: runtime.agentBusy,
        showWorking: runtime.agentBusy,
      });
    }
    void this.disposeRpcProcess(tabId);
  }

  /**
   * Ensure the backend is running the session that corresponds to the requested tab.
   * Called lazily before the first prompt in a tab to avoid slow backend work on every tab switch.
   * @param {string | null} [tabId]
   */
  async _ensureBackendOnActiveTab(tabId = null) {
    await this.ensureClientStarted(tabId ?? this.activeTabId);
  }

  /**
   * @param {string} rawUrl
   * @param {string} [instruction]
   */
  async handleOpenAgentBrowser(rawUrl, instruction = "") {
    let url;
    try {
      url = normalizeAgentBrowserUrl(rawUrl);
    } catch (error) {
      const errText = toErrorMessage(error);
      this.pushHistory("error", errText);
      this.postToWebview({ type: "error", text: errText });
      return;
    }
    await this.handlePrompt(buildAgentBrowserPrompt(url, instruction), []);
  }

  /**
   * Launch a real Chrome instance with `--remote-debugging-port` (default 9222) and a
   * dedicated `--user-data-dir` so it can be controlled over CDP without
   * touching the user's main profile. The process is spawned detached and
   * with `stdio: "ignore"` so it keeps running even if the webview reloads
   * or the extension host restarts.
   *
   * If the debugging port already responds (e.g. Chrome left running from a prior click),
   * skips spawning a second process to avoid Chrome's "profile could not be opened" race.
   * After spawn, waits until `GET /json/version` succeeds so `agent_browser --cdp` does not
   * run before CDP is up (which could otherwise launch a second visible browser).
   *
   * After Chrome is ready, sends a structured prompt so the agent attaches over CDP
   * and opens a default landing page (`https://www.google.com`).
   *
   * Works on macOS, Linux, and Windows: resolves an installed Chrome/Chromium
   * (or Edge/Brave) binary for the current platform via `resolveChromeExecutable()`.
   */
  async handleLaunchChromeDebug() {
    const port = CHROME_DEBUG_PORT;
    const landingUrl = "https://www.google.com";
    const alreadyListening = await isChromeDebuggerListening(port);
    if (!alreadyListening) {
      const chromeBinary = resolveChromeExecutable();
      if (!chromeBinary) {
        const msg = `Could not find a Chrome/Chromium binary to launch with remote debugging (platform=${process.platform}). Install Google Chrome or Chromium, or start a browser manually with --remote-debugging-port=${port}.`;
        this.postToWebview({ type: "error", text: msg });
        void vscode.window.showWarningMessage(msg);
        return;
      }
      // Spawn the binary directly with an args array so paths containing spaces
      // work without shell quoting across macOS, Linux, and Windows.
      // Passing `landingUrl` as the start URL means Chrome's single startup tab is
      // already the landing page, so the agent can attach with `snapshot` instead of
      // `open` (which would create a second tab and leave a blank "New Tab" behind).
      const userDataDir = path.join(homedir(), ".free-code", "chrome-debug-profile");
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--disable-default-browser-check",
        landingUrl,
      ];
      try {
        const child = spawn(chromeBinary, args, {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", (error) => {
          const errText = `Failed to launch Chrome debug: ${toErrorMessage(error)}`;
          this.postToWebview({ type: "error", text: errText });
          void vscode.window.showErrorMessage(errText);
        });
        child.unref();
      } catch (error) {
        const errText = `Failed to launch Chrome debug: ${toErrorMessage(error)}`;
        this.postToWebview({ type: "error", text: errText });
        void vscode.window.showErrorMessage(errText);
        return;
      }
      try {
        await waitForChromeRemoteDebugging(port, 25_000);
      } catch (error) {
        const errText = `Chrome did not become ready for remote debugging: ${toErrorMessage(error)}`;
        this.postToWebview({ type: "error", text: errText });
        void vscode.window.showErrorMessage(errText);
        return;
      }
      void vscode.window.setStatusBarMessage(
        `Chrome launched with remote debugging on port ${port}`,
        4000,
      );
    } else {
      void vscode.window.setStatusBarMessage(
        `Using existing Chrome remote debugging on port ${port}`,
        4000,
      );
    }
    void this.handlePrompt(buildChromeDebugAttachPrompt(landingUrl), [], {
      showInChat: false,
    });
  }

  /**
   * @param {string} text typed by the user (no embedded attachment paths)
   * @param {string[]} [attachments] absolute paths of attached files (chips in the input)
   * @param {{ showInChat?: boolean }} [options] When `showInChat` is `false`, the prompt is sent over RPC but is not persisted in the sidebar user bubble (used for the Browser / CDP attach helper).
   */
  async handlePrompt(text, attachments = [], options = {}) {
    const showInChat = options.showInChat !== false;
    const rawText = typeof text === "string" ? text : "";
    const paths = Array.isArray(attachments)
      ? attachments.filter((p) => typeof p === "string" && p.length > 0)
      : [];
    if (!rawText.trim() && paths.length === 0) return;
    const promptTabId = this.activeTabId;
    const promptTab = this.getTabById(promptTabId) ?? this.getActiveTab();
    // On the first message of a chat, `ensureClientStarted` below can block for
    // 10-30s (MCP load + provider warm-up). Without feedback the input clears
    // and nothing appears until the agent is ready, so the message looks lost.
    // If the agent is still warming up, echo the user's message and show a
    // "waiting" indicator now; the prompt is sent once the await resolves.
    // Slash commands render their own UI, so only plain prompts are echoed early.
    const startingRuntime = this.getTabRuntime(promptTabId);
    const agentLoading =
      !startingRuntime.rpcClient || this._ensureByTab.has(promptTabId);
    const isSlashCommand = rawText.trim().startsWith("/");
    let earlyEchoed = false;
    if (showInChat && agentLoading && !isSlashCommand) {
      this.pushHistory("user", rawText, paths, promptTabId);
      this.postToWebviewForTab(promptTabId, {
        type: "user_message",
        text: rawText,
        attachments: paths,
      });
      this.postToWebview({
        type: "busy",
        busy: true,
        showWorking: promptTabId === this.activeTabId,
      });
      this.postToWebviewForTab(promptTabId, {
        type: "status",
        text: "Waiting for agent to finish loading…",
      });
      earlyEchoed = true;
    }
    const runtime = await this.ensureClientStarted(promptTabId);
    const trimmed = rawText.trim();
    if (
      paths.length === 0 &&
      (trimmed === "/profile" ||
        trimmed.startsWith("/profile ") ||
        trimmed.startsWith("/profile\t"))
    ) {
      const parsedProfile = parseProfileCommandForPlugin(trimmed);
      if (parsedProfile.kind === "error") {
        this.pushHistory(
          "error",
          parsedProfile.message,
          undefined,
          promptTabId,
        );
        this.postToWebviewForTab(promptTabId, {
          type: "error",
          text: parsedProfile.message,
        });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (parsedProfile.kind === "list") {
        const data = loadProfilesDataForPlugin();
        const names = Object.keys(data.profiles).sort((a, b) => {
          if (a === "default") return -1;
          if (b === "default") return 1;
          return a.localeCompare(b);
        });
        const body =
          names.length > 0
            ? names
                .map((name) =>
                  name === data.activeProfile ? `${name} *` : name,
                )
                .join("\n")
            : "(no profiles)";
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (parsedProfile.kind === "info") {
        const data = loadProfilesDataForPlugin();
        const profile = data.profiles[parsedProfile.name];
        if (!profile) {
          const errText = `Unknown profile "${parsedProfile.name}"`;
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        let skillPickerState = null;
        try {
          skillPickerState = await runtime.rpcClient.getSkillPickerState();
        } catch {
          /* keep null; formatProfileDetailsForPlugin shows (none) for skills */
        }
        const details = this.formatProfileDetailsForPlugin(
          parsedProfile.name,
          profile,
          data.activeProfile,
          skillPickerState,
        );
        this.pushHistory("tools", details, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: details,
        });
        const shouldUse = await this.promptProfileUseConfirmation(
          promptTabId,
          parsedProfile.name,
        );
        if (shouldUse) {
          await this.applyProfileWithoutPrompt(promptTabId, parsedProfile.name);
        } else {
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        }
        return;
      }
      if (parsedProfile.kind === "interactive") {
        const { names, activeProfile } = loadProfileNamesForPlugin();
        if (names.length === 0) {
          const body = "(no profiles)";
          this.pushHistory("tools", body, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "tools_info",
            text: body,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const pickedProfile = await this.promptProfileSelectionQuestionnaire(
          promptTabId,
          names,
          activeProfile,
        );
        if (pickedProfile) {
          await this.applyProfileWithoutPrompt(promptTabId, pickedProfile);
        } else {
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        }
        return;
      }
      if (parsedProfile.kind === "create") {
        if (!PROFILE_NAME_RE.test(parsedProfile.name)) {
          const errText =
            "Invalid profile name (use letters, digits, ._- ; max 64 chars after first char).";
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const data = loadProfilesDataForPlugin();
        if (data.profiles[parsedProfile.name]) {
          const errText = `Profile "${parsedProfile.name}" already exists`;
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const profilesRaw =
          data.raw.profiles && typeof data.raw.profiles === "object"
            ? /** @type {Record<string, unknown>} */ (data.raw.profiles)
            : {};
        profilesRaw[parsedProfile.name] = defaultPluginSerializedProfile();
        data.raw.profiles = profilesRaw;
        data.raw.activeProfile = parsedProfile.name;
        persistProfilesDataForPlugin(data);
        this.postProfileIndicator();
        await this.applyProfileWithoutPrompt(promptTabId, parsedProfile.name);
        this.pushHistory(
          "tools",
          `Created profile "${parsedProfile.name}"`,
          undefined,
          promptTabId,
        );
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: `Created profile "${parsedProfile.name}"`,
        });
        return;
      }
      if (parsedProfile.kind === "save") {
        const data = loadProfilesDataForPlugin();
        const targetName = parsedProfile.name ?? data.activeProfile;
        if (!targetName) {
          const errText =
            "No active profile to update. Use /profile save <name>.";
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        if (targetName === "default") {
          const errText =
            "Refusing to save over `default` (it must stay empty). Use /profile create <name>.";
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        if (!PROFILE_NAME_RE.test(targetName)) {
          const errText =
            "Invalid profile name (use letters, digits, ._- ; max 64 chars after first char).";
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const profilesRaw =
          data.raw.profiles && typeof data.raw.profiles === "object"
            ? /** @type {Record<string, unknown>} */ (data.raw.profiles)
            : {};
        if (!runtime.rpcClient) {
          const errText = "RPC client not available";
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const snapshot = await this.captureCurrentProfileForPlugin(
          runtime.rpcClient,
          promptTabId,
        );
        profilesRaw[targetName] = snapshot;
        data.raw.profiles = profilesRaw;
        data.raw.activeProfile = targetName;
        persistProfilesDataForPlugin(data);
        this.postProfileIndicator();
        const body = `Saved profile "${targetName}"`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (parsedProfile.kind === "delete") {
        if (parsedProfile.name === "default") {
          const errText = "The `default` profile cannot be deleted.";
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const data = loadProfilesDataForPlugin();
        if (!data.profiles[parsedProfile.name]) {
          const errText = `Unknown profile "${parsedProfile.name}"`;
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const profilesRaw =
          data.raw.profiles && typeof data.raw.profiles === "object"
            ? /** @type {Record<string, unknown>} */ (data.raw.profiles)
            : {};
        delete profilesRaw[parsedProfile.name];
        if (!profilesRaw.default)
          profilesRaw.default = defaultPluginSerializedProfile();
        data.raw.profiles = profilesRaw;
        const nextActive =
          data.activeProfile === parsedProfile.name
            ? "default"
            : (data.activeProfile ?? "default");
        data.raw.activeProfile = nextActive;
        persistProfilesDataForPlugin(data);
        this.postProfileIndicator();
        const body = `Deleted profile "${parsedProfile.name}"`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        if (nextActive === "default") {
          await this.applyProfileWithoutPrompt(promptTabId, "default");
        } else {
          this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        }
        return;
      }
      await this.applyProfileWithoutPrompt(promptTabId, parsedProfile.name);
      return;
    }
    // LLM prompt re-attaches the absolute paths the same way the TUI does so
    // the agent's `read` / `edit` tools can see them. The chat bubble shows
    // only the file basename via `user_message.attachments` chips.
    const filePart = paths.map(toShellTokenForPath).filter(Boolean).join(" ");
    let llmText = filePart
      ? trimmed
        ? `${trimmed} ${filePart}`
        : filePart
      : trimmed;
    const active = promptTab;
    if (
      showInChat &&
      active &&
      (active.label === "New chat" || active.label === "Chat")
    ) {
      const previewSrc =
        trimmed || paths.map((p) => p.split(/[/\\]/).pop() || p).join(" ");
      const preview = previewSrc.replace(/\s+/g, " ");
      active.label =
        preview.length > 32 ? `${preview.slice(0, 32)}...` : preview;
      this.persistTabs();
      this.postToWebview({
        type: "set_tabs",
        tabs: this.getTabsForWebview(),
        activeId: this.activeTabId,
      });
    }
    runtime.currentAssistantMessageId = null;
    runtime.pendingAssistantText = "";
    runtime.pendingThinkingText = "";
    runtime.currentThinkingMessageId = null;
    if (showInChat && !earlyEchoed) {
      this.pushHistory("user", rawText, paths, promptTabId);
      this.postToWebviewForTab(promptTabId, {
        type: "user_message",
        text: rawText,
        attachments: paths,
      });
    } else if (!showInChat) {
      this.postToWebviewForTab(promptTabId, {
        type: "hint",
        text: "Chrome is ready with remote debugging; attaching the agent over CDP.",
      });
    }
    this.postToWebview({
      type: "busy",
      busy: true,
      showWorking: promptTabId === this.activeTabId,
    });

    // Do not send `/session` to the model: stats come from the RPC session JSONL (same as terminal / TUI).
    if (trimmed === "/session") {
      try {
        if (!runtime.rpcClient) throw new Error("RPC client not available");
        const stats = await runtime.rpcClient.getSessionStats();
        const st = await runtime.rpcClient.getState();
        if (!stats) throw new Error("get_session_stats returned no data");
        const name =
          typeof st.sessionName === "string" ? st.sessionName : undefined;
        let toolGroups;
        let skillEntries;
        let agentEntries;
        try {
          const toolPickerState = await runtime.rpcClient.getToolPickerState();
          if (toolPickerState && Array.isArray(toolPickerState.groups)) {
            toolGroups = toolPickerState.groups;
          }
          const skillPickerState = await runtime.rpcClient.getSkillPickerState();
          if (skillPickerState && Array.isArray(skillPickerState.skills)) {
            skillEntries = skillPickerState.skills;
          }
          const agentPickerState = await runtime.rpcClient.getAgentPickerState();
          if (agentPickerState && Array.isArray(agentPickerState.agents)) {
            agentEntries = agentPickerState.agents;
          }
        } catch (_) {}
        this.showSessionInfoInChat(stats, name, promptTabId, toolGroups, skillEntries, agentEntries);
      } catch (error) {
        const errText = toErrorMessage(error);
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      }
      return;
    }

    if (
      trimmed === "/gemini" ||
      trimmed.startsWith("/gemini ") ||
      trimmed.startsWith("/gemini\t")
    ) {
      const parsedGemini = parseGeminiCommand(trimmed);
      if (!parsedGemini.ok) {
        const errText = parsedGemini.error;
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      llmText =
        parsedGemini.subcommand === "ask"
          ? buildGeminiPluginPrompt(parsedGemini.value)
          : parsedGemini.subcommand === "download"
            ? buildGeminiDownloadPluginPrompt(parsedGemini.value)
            : buildGeminiOpenPluginPrompt(parsedGemini.value);
    }

    if (
      trimmed === "/browse" ||
      trimmed.startsWith("/browse ") ||
      trimmed.startsWith("/browse\t")
    ) {
      const parsedBrowse = parseBrowseCommand(trimmed);
      if (!parsedBrowse.ok) {
        const errText = parsedBrowse.error;
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      llmText = buildAgentBrowserPrompt(
        parsedBrowse.url,
        parsedBrowse.instruction,
      );
    }

    if (
      trimmed === "/drive" ||
      trimmed.startsWith("/drive ") ||
      trimmed.startsWith("/drive\t")
    ) {
      const parsedDrive = parseDriveCommand(trimmed);
      if (!parsedDrive.ok) {
        const errText = parsedDrive.error;
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      llmText = buildDriveDownloadPluginPrompt(parsedDrive.url, this.getFreeCodeSpawnCwd());
    }

    if (
      trimmed === "/mode" ||
      trimmed.startsWith("/mode ") ||
      trimmed.startsWith("/mode\t")
    ) {
      const parsedMode = parseModeCommand(trimmed);
      if (!parsedMode.ok) {
        const errText = parsedMode.error;
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      try {
        if (!runtime.rpcClient) throw new Error("RPC client not available");
        const commands = await runtime.rpcClient.getCommands();
        const hasModeCommand = commands.some((cmd) => {
          if (!cmd || typeof cmd !== "object") return false;
          const name =
            typeof cmd.name === "string"
              ? cmd.name.trim().replace(/^\//, "")
              : "";
          return name === "mode";
        });
        if (!hasModeCommand) {
          const errText =
            "The connected free-code runtime does not expose /mode yet. Update/rebuild your free-code binary and retry.";
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        // Execute extension command in backend without entering the generic
        // model-processing path for slash text handling.
        await runtime.rpcClient.prompt(`/mode ${parsedMode.subcommand}`);
        const body = `Mode set to ${parsedMode.subcommand}.`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      } catch (error) {
        const errText = toErrorMessage(error);
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      }
      return;
    }

    if (
      trimmed === "/rag-kb" ||
      trimmed.startsWith("/rag-kb ") ||
      trimmed.startsWith("/rag-kb\t")
    ) {
      const parsedRagKb = parseRagKbCommand(trimmed);
      if (!parsedRagKb.ok) {
        const errText = parsedRagKb.error;
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      const { base } = getRagSettings();
      const ragTab = this.getTabById(promptTabId) ?? this.getActiveTab();

      if (parsedRagKb.subcommand === "list") {
        const listed = await listKnowledgeBasesFromPlugin(base);
        const body = listed.ok
          ? listed.kbs.length > 0
            ? `Available KBs: ${listed.kbs.join(", ")}`
            : "No KBs available yet. Create one with /rag-kb create <kb_name>"
          : `Could not list KBs: ${listed.error}`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }

      let normalizedKb = "";
      try {
        normalizedKb = normalizeKbName(parsedRagKb.value);
      } catch (error) {
        const errText = toErrorMessage(error);
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }

      if (parsedRagKb.subcommand === "create") {
        const created = await mutateKnowledgeBaseFromPlugin(
          "createkb",
          normalizedKb,
          base,
        );
        if (!created.ok) {
          const errText = `Could not create KB '${normalizedKb}': ${created.error}`;
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const body = `Created KB: ${normalizedKb}`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }

      if (parsedRagKb.subcommand === "delete") {
        const deleted = await mutateKnowledgeBaseFromPlugin(
          "deletekb",
          normalizedKb,
          base,
        );
        if (!deleted.ok) {
          const errText = `Could not delete KB '${normalizedKb}': ${deleted.error}`;
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        if (ragTab && ragTab.ragKnowledgeBase === normalizedKb) {
          ragTab.ragKnowledgeBase = null;
          this.persistTabs();
        }
        const body = `Deleted KB: ${normalizedKb}`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }

      const listed = await listKnowledgeBasesFromPlugin(base);
      if (!listed.ok) {
        const errText = `Could not verify KBs: ${listed.error}`;
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (!listed.kbs.includes(normalizedKb)) {
        const errText = `KB '${normalizedKb}' does not exist. Create it first with /rag-kb create ${normalizedKb}`;
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (ragTab) {
        ragTab.ragKnowledgeBase = normalizedKb;
        this.persistTabs();
      }
      const body = `Selected KB for this conversation: ${normalizedKb}`;
      this.pushHistory("tools", body, undefined, promptTabId);
      this.postToWebviewForTab(promptTabId, { type: "tools_info", text: body });
      const disc = await fetchRagDiscoverFromPlugin(base, normalizedKb);
      if (!disc.ok) {
        if (!disc.discoverUnsupported) {
          this.pushHistory(
            "tools",
            `Could not load KB metadata overview: ${disc.error}`,
            undefined,
            promptTabId,
          );
          this.postToWebviewForTab(promptTabId, {
            type: "tools_info",
            text: `Could not load KB metadata overview: ${disc.error}`,
          });
        } else {
          const hint = `${normalizedKb}: *.knowledge.md are under ${getKnowledgeBaseDir(normalizedKb)}, but this RAG server has no GET /discover (404). Run free-code-rag from the repo. /rag search does not include sidecars by design.`;
          this.pushHistory("tools", hint, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "tools_info",
            text: hint,
          });
        }
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      llmText = formatRagDiscoverPromptForPlugin(normalizedKb, disc);
    }

    if (
      trimmed === "/rag" ||
      trimmed.startsWith("/rag ") ||
      trimmed.startsWith("/rag\t")
    ) {
      let ragCommandText = trimmed;
      // Allow `/rag addFile` and `/rag addGroup` to use attached files as input.
      if (
        (trimmed === "/rag addFile" || trimmed === "/rag addGroup") &&
        paths.length > 0
      ) {
        ragCommandText = `${trimmed} __attachments__`;
      }
      const parsedRag = parseRagCommand(ragCommandText);
      if (!parsedRag.ok) {
        const errText = parsedRag.error;
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      const { base, maxChunks, maxChars } = getRagSettings();
      const activeKb =
        promptTab && typeof promptTab.ragKnowledgeBase === "string"
          ? promptTab.ragKnowledgeBase
          : null;
      const showKbSelectionStatus = async () => {
        const selected = activeKb
          ? `Selected KB: ${activeKb}`
          : "No KB selected for this conversation.";
        const listed = await listKnowledgeBasesFromPlugin(base);
        const body = listed.ok
          ? `${selected}\nAvailable KBs: ${
              listed.kbs.length > 0 ? listed.kbs.join(", ") : "(none)"
            }\nUse: /rag-kb use <name>`
          : `${selected}\nCould not list KBs: ${listed.error}\nUse: /rag-kb list`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      };

      if (!activeKb) {
        await showKbSelectionStatus();
        return;
      }

      if (parsedRag.subcommand === "addFile") {
        const cwd = this.getWorkspaceCwd() || process.cwd();
        const sourcePath = paths.length > 0 ? paths[0] : parsedRag.value;
        this.postToWebviewForTab(promptTabId, {
          type: "status",
          text: `Adding file to KB '${activeKb}'...`,
        });
        const added = await ragAddFromPlugin(sourcePath, cwd, activeKb, base);
        if (!added.ok) {
          this.pushHistory("error", added.error, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: added.error,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const body = isRagKnowledgeSidecarDestPath(added.destPath)
          ? `Stored in KB '${activeKb}' (${RAG_KNOWLEDGE_SIDECAR_SUFFIX} sidecar — on disk for GET /discover; not in vector /rag search): ${added.destPath}`
          : `Added to KB '${activeKb}': ${added.destPath}`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (parsedRag.subcommand === "addGroup") {
        const cwd = this.getWorkspaceCwd() || process.cwd();
        if (paths.length > 0) {
          this.postToWebviewForTab(promptTabId, {
            type: "status",
            text: `Adding attached files to KB '${activeKb}'...`,
          });
          const added = [];
          const skipped = [];
          const failed = [];
          for (const sourcePath of paths) {
            const result = await ragAddFromPlugin(
              sourcePath,
              cwd,
              activeKb,
              base,
            );
            const displayName = path.basename(sourcePath);
            if (result.ok) {
              added.push(displayName);
              continue;
            }
            if (result.error.startsWith("Unsupported file type.")) {
              skipped.push(displayName);
              continue;
            }
            failed.push({ file: displayName, error: result.error });
          }
          const summary = [
            `KB '${activeKb}'`,
            `Added: ${added.length}`,
            `Skipped: ${skipped.length}`,
            `Failed: ${failed.length}`,
          ];
          const body =
            failed.length > 0
              ? `${summary.join(" | ")}\n${failed
                  .slice(0, 5)
                  .map((x) => `- ${x.file}: ${x.error}`)
                  .join("\n")}`
              : summary.join(" | ");
          this.pushHistory("tools", body, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "tools_info",
            text: body,
          });
          this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        this.postToWebviewForTab(promptTabId, {
          type: "status",
          text: `Adding files from folder to KB '${activeKb}'...`,
        });
        const grouped = await ragAddGroupFromPlugin(
          parsedRag.value,
          cwd,
          activeKb,
          base,
        );
        if (!grouped.ok) {
          this.pushHistory("error", grouped.error, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: grouped.error,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const summary = [
          `KB '${activeKb}'`,
          `Added: ${grouped.added.length}`,
          `Skipped: ${grouped.skipped.length}`,
          `Failed: ${grouped.failed.length}`,
        ];
        const body =
          grouped.failed.length > 0
            ? `${summary.join(" | ")}\n${grouped.failed
                .slice(0, 5)
                .map((x) => `- ${x.file}: ${x.error}`)
                .join("\n")}`
            : summary.join(" | ");
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (parsedRag.subcommand === "list") {
        const list = await ragListFromPlugin(activeKb);
        if (!list.ok) {
          this.pushHistory("error", list.error, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: list.error,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const kbDir = getKnowledgeBaseDir(activeKb);
        const body =
          list.files.length === 0
            ? `KB '${activeKb}' is empty (${kbDir})`
            : `KB '${activeKb}' (${kbDir})\n${list.files.join("\n")}`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (parsedRag.subcommand === "remove") {
        const removed = await ragRemoveFromPlugin(
          parsedRag.value,
          activeKb,
          base,
        );
        if (!removed.ok) {
          this.pushHistory("error", removed.error, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: removed.error,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        const body = `Removed from KB '${activeKb}': ${parsedRag.value.trim()}`;
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (parsedRag.subcommand === "addGithubUrl") {
        const parts = parsedRag.value.split(/\s+/);
        const urlArg = parts[0] ?? "";
        const subPathArg = parts.length > 1 ? parts.slice(1).join("/") : undefined;
        const label = subPathArg ? `${urlArg} (${subPathArg})` : urlArg;
        this.postToWebviewForTab(promptTabId, {
          type: "status",
          text: `Cloning ${label} into KB '${activeKb}'...`,
        });
        const githubResult = await ragAddGithubUrlFromPlugin(urlArg, activeKb, subPathArg, base);
        if (!githubResult.ok) {
          this.pushHistory("error", githubResult.error, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, { type: "error", text: githubResult.error });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        upsertGithubSourceFromPlugin(activeKb, urlArg, subPathArg);
        const summary = [`KB '${activeKb}'`, `Added: ${githubResult.added.length}`, `Skipped: ${githubResult.skipped.length}`, `Failed: ${githubResult.failed.length}`];
        const ghBody = githubResult.failed.length > 0
          ? `${summary.join(" | ")}\n${githubResult.failed.slice(0, 5).map((x) => `- ${x.file}: ${x.error}`).join("\n")}`
          : summary.join(" | ");
        this.pushHistory("tools", ghBody, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "tools_info", text: ghBody });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (parsedRag.subcommand === "refresh") {
        const sources = loadSourcesFromPlugin(activeKb);
        const githubSources = sources.filter((s) => s.type === "github");
        if (sources.length === 0) {
          const noSrcBody = `KB '${activeKb}' has no tracked sources.\nAdd one with /rag addFile or /rag addGithubUrl first.`;
          this.pushHistory("tools", noSrcBody, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, { type: "tools_info", text: noSrcBody });
          this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        this.postToWebviewForTab(promptTabId, {
          type: "status",
          text: `Refreshing ${sources.length} source(s) in KB '${activeKb}'...`,
        });
        const { totalAdded, totalSkipped, errors } = await ragRefreshFromPlugin(activeKb, base);
        const refSummary = [`KB '${activeKb}' refreshed`, `Added/Updated: ${totalAdded}`, `Skipped: ${totalSkipped}`];
        const refBody = errors.length > 0
          ? `${refSummary.join(" | ")}\nErrors:\n${errors.slice(0, 5).join("\n")}`
          : refSummary.join(" | ");
        this.pushHistory(errors.length > 0 ? "error" : "tools", refBody, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: errors.length > 0 ? "error" : "tools_info", text: refBody });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
        return;
      }
      if (parsedRag.subcommand === "schedule") {
        const scheduleArg = parsedRag.value.toLowerCase().trim();
        const existingSchedule = loadScheduleConfigFromPlugin(activeKb);
        if (!scheduleArg) {
          const presetLines = Object.entries(PRESET_SCHEDULES).map(([k, v]) => `  ${k} → "${v.cron}" (${v.label})`).join("\n");
          const statusBody = existingSchedule
            ? `KB '${activeKb}' schedule: ${existingSchedule.preset ?? existingSchedule.cron} (${existingSchedule.cron})\nCreated: ${existingSchedule.createdAt}\n\nOptions: daily | weekly | hourly | <cron expr> | off\n${presetLines}`
            : `KB '${activeKb}' has no active schedule.\nOptions: daily | weekly | hourly | <cron expr> | off\n${presetLines}`;
          this.pushHistory("tools", statusBody, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, { type: "tools_info", text: statusBody });
          this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        if (scheduleArg === "off") {
          if (!existingSchedule) {
            const noSchedBody = `KB '${activeKb}' has no active schedule.`;
            this.pushHistory("tools", noSchedBody, undefined, promptTabId);
            this.postToWebviewForTab(promptTabId, { type: "tools_info", text: noSchedBody });
            this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
            this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
            return;
          }
          saveScheduleConfigFromPlugin(activeKb, null);
          if (existingSchedule.cronJobId) {
            llmText = `[RAG Schedule] Please cancel the cron job with ID "${existingSchedule.cronJobId}" for KB '${activeKb}' using the CronDelete tool.`;
          } else {
            const offBody = `Schedule removed for KB '${activeKb}'.`;
            this.pushHistory("tools", offBody, undefined, promptTabId);
            this.postToWebviewForTab(promptTabId, { type: "tools_info", text: offBody });
            this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
            this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
            return;
          }
        } else {
          const allSources = loadSourcesFromPlugin(activeKb);
          const hasGithub = allSources.some((s) => s.type === "github");
          if (!hasGithub) {
            const noGhBody = `KB '${activeKb}' has no GitHub sources to schedule.\nAdd one first with: /rag addGithubUrl <url>`;
            this.pushHistory("error", noGhBody, undefined, promptTabId);
            this.postToWebviewForTab(promptTabId, { type: "error", text: noGhBody });
            this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
            this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
            return;
          }
          let cron, preset;
          if (scheduleArg in PRESET_SCHEDULES) {
            cron = PRESET_SCHEDULES[scheduleArg].cron;
            preset = scheduleArg;
          } else {
            if (!isValidCronExpression(scheduleArg)) {
              const badCronBody = `Invalid schedule. Use: daily | weekly | hourly | <5-field cron> | off`;
              this.pushHistory("error", badCronBody, undefined, promptTabId);
              this.postToWebviewForTab(promptTabId, { type: "error", text: badCronBody });
              this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
              this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
              return;
            }
            cron = scheduleArg;
          }
          const newSchedule = { cron, ...(preset ? { preset } : {}), createdAt: new Date().toISOString() };
          saveScheduleConfigFromPlugin(activeKb, newSchedule);
          const sourcesFilePath = path.join(getKnowledgeBaseDir(activeKb), SOURCES_FILENAME);
          const label = preset ? `${preset} (${cron})` : cron;
          const schedBody = `Schedule "${label}" saved for KB '${activeKb}'.\nSetting up cron job... (auto-expires after 7 days)`;
          this.pushHistory("tools", schedBody, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, { type: "tools_info", text: schedBody });
          const cancelMsg = existingSchedule?.cronJobId
            ? `First cancel the existing cron job with ID "${existingSchedule.cronJobId}" using CronDelete.\n\n`
            : "";
          llmText = `[RAG Schedule] ${cancelMsg}Please create a durable recurring cron job using CronCreate:\n- cron: "${cron}"\n- recurring: true\n- durable: true\n- prompt: "Refresh RAG knowledge base '${activeKb}'. Read sources from ${sourcesFilePath}, then for each GitHub source re-clone and re-index using the RAG HTTP API. Follow the RAG skill instructions."\n\nAfter CronCreate returns the job ID, store it in ${sourcesFilePath} under schedule.cronJobId using the Edit tool (read file first). Then notify the user the cron is active.`;
        }
      }
      if (parsedRag.subcommand === "addDrive") {
        const driveUrl = parsedRag.value.trim();
        const kbDir = getKnowledgeBaseDir(activeKb);
        const { base: ragBase } = getRagSettings();
        this.postToWebviewForTab(promptTabId, {
          type: "status",
          text: `Downloading from Google Drive and indexing into KB '${activeKb}'...`,
        });
        llmText = buildRagDrivePluginPrompt(driveUrl, activeKb, kbDir, ragBase);
      }
      if (parsedRag.subcommand === "search") {
        const query = parsedRag.value.trim();
        const searched = await ragQueryFromPlugin(
          query,
          activeKb,
          base,
          maxChunks,
          maxChars,
        );
        if (!searched.ok) {
          this.pushHistory("error", searched.error, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: searched.error,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        llmText = formatRagSearchPrompt(query, searched.chunks);
      }
    }

    if (trimmed === "/tools") {
      try {
        if (!runtime.rpcClient) throw new Error("RPC client not available");
        const st = await runtime.rpcClient.getToolPickerState();
        if (!st) throw new Error("get_tool_picker_state returned no data");
        const body = formatToolPickerForWebview(st);
        this.pushHistory("tools", body, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, {
          type: "tools_info",
          text: body,
        });
        this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      } catch (error) {
        const errText = rpcToolPickerErrorMessage(error);
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      }
      return;
    }

    if (trimmed === "/pick-tools") {
      try {
        if (!runtime.rpcClient) throw new Error("RPC client not available");
        const st = await runtime.rpcClient.getToolPickerState();
        if (!st) throw new Error("get_tool_picker_state returned no data");
        const groupList = Array.isArray(st.groups) ? st.groups : [];
        if (groupList.length === 0) {
          const body = formatToolPickerForWebview(st);
          this.pushHistory("tools", body, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "tools_info",
            text: body,
          });
          this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        this.postToWebviewForTab(promptTabId, {
          type: "open_tool_picker",
          state: st,
        });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      } catch (error) {
        const errText = rpcToolPickerErrorMessage(error);
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      }
      return;
    }

    if (trimmed === "/model") {
      try {
        await this._openModelPickerFlow();
      } catch (error) {
        const errText = rpcToolPickerErrorMessage(error);
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      }
      return;
    }

    // `/model <id> [<provider>]` directly applies a model without opening the picker.
    // Mirrors the row format the picker shows so a user can copy what they see ("type
    // what you see"). Bare `/model` keeps opening the picker via the branch above.
    if (trimmed.startsWith("/model ") || trimmed.startsWith("/model\t")) {
      try {
        const argsText = trimmed.slice("/model".length).trim();
        const parsed = parseModelCommandArgs(argsText);
        if (!parsed) {
          const errText =
            "Usage: /model <model-id> [<provider>]\n" +
            "Example: /model gemini-2.5-flash [google-vertex]\n" +
            "Tip: type /model alone to open the model picker.";
          this.pushHistory("error", errText, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: errText,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        if (!runtime.rpcClient) throw new Error("RPC client not available");
        const models = await runtime.rpcClient.getAvailableModels();
        const match = resolveModelMatch(
          models,
          parsed.modelId,
          parsed.provider,
        );
        if (!match.ok) {
          this.pushHistory("error", match.error, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "error",
            text: match.error,
          });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        await this.handleModelPickerApply(match.provider, match.modelId);
      } catch (error) {
        const errText = rpcToolPickerErrorMessage(error);
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      }
      return;
    }

    if (trimmed === "/pick-skill") {
      try {
        if (!runtime.rpcClient) throw new Error("RPC client not available");
        const st = await runtime.rpcClient.getSkillPickerState();
        if (!st) throw new Error("get_skill_picker_state returned no data");
        const skillList = Array.isArray(st.skills) ? st.skills : [];
        if (skillList.length === 0) {
          const body = formatSkillPickerForWebview(st);
          this.pushHistory("tools", body, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, {
            type: "tools_info",
            text: body,
          });
          this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        this.postToWebviewForTab(promptTabId, {
          type: "open_skill_picker",
          state: st,
        });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      } catch (error) {
        const errText = rpcToolPickerErrorMessage(error);
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      }
      return;
    }

    if (trimmed === "/pick-agent") {
      try {
        if (!runtime.rpcClient) throw new Error("RPC client not available");
        const st = await runtime.rpcClient.getAgentPickerState();
        if (!st) throw new Error("get_agent_picker_state returned no data");
        const agentList = Array.isArray(st.agents) ? st.agents : [];
        if (agentList.length === 0) {
          const body = "No agents found in ~/.free-code/agents/. Add agent directories with AGENT.md files to use /pick-agent.";
          this.pushHistory("tools", body, undefined, promptTabId);
          this.postToWebviewForTab(promptTabId, { type: "tools_info", text: body });
          this.postToWebviewForTab(promptTabId, { type: "status", text: "" });
          this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
          return;
        }
        this.postToWebviewForTab(promptTabId, {
          type: "open_agent_picker",
          state: st,
        });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      } catch (error) {
        const errText = rpcToolPickerErrorMessage(error);
        this.pushHistory("error", errText, undefined, promptTabId);
        this.postToWebviewForTab(promptTabId, { type: "error", text: errText });
        this.postToWebviewForTab(promptTabId, { type: "busy", busy: false });
      }
      return;
    }

    try {
      await this._ensureBackendOnActiveTab(promptTabId);
      this._startAutoRecoveryWatchdog(runtime);
      await runtime.rpcClient.prompt(llmText);
    } catch (error) {
      const errText = toErrorMessage(error);
      this.pushHistory("error", errText, undefined, runtime.tabId);
      this.postToWebviewForRuntime(runtime, { type: "error", text: errText });
      this.postToWebviewForTab(runtime.tabId, { type: "busy", busy: false });
      this._stopAutoRecoveryWatchdog(runtime);
    }
  }

  async ensureClientStarted(tabId = this.activeTabId) {
    const id = tabId ?? this.activeTabId;
    const inflight = this._ensureByTab.get(id);
    if (inflight) {
      return await inflight;
    }
    const run = this.ensureClientStartedCore(id);
    this._ensureByTab.set(id, run);
    try {
      return await run;
    } finally {
      if (this._ensureByTab.get(id) === run) {
        this._ensureByTab.delete(id);
      }
    }
  }

  async ensureClientStartedCore(tabId) {
    const runtime = this.getTabRuntime(tabId);
    const config = vscode.workspace.getConfiguration("free-code");
    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    const configuredCwd = config.get("cwd", "");
    const cwd = configuredCwd || workspaceCwd || process.cwd();
    const provider = config.get("provider", "").trim() || undefined;
    const model = config.get("model", "").trim() || undefined;
    const configuredExecutable =
      config.get("executablePath", "free-code").trim() || "free-code";
    const { command, spawnArgsPrefix } = resolveFreeCodeExecutable(
      configuredExecutable,
      workspaceCwd,
    );
    const childEnv = mergeChildEnvForFreeCode(config);
    const noExtensions = config.get("noExtensions") === true;
    const noAgentsFiles = config.get("noAgentsFiles") === true;
    const spawnKey = JSON.stringify({
      command,
      spawnArgsPrefix,
      cwd,
      model,
      noExtensions,
      noAgentsFiles,
      provider,
    });

    if (runtime.rpcClient && runtime.rpcSpawnKey !== spawnKey) {
      await this.disposeRpcProcess(tabId);
    }
    if (runtime.rpcClient) return runtime;

    runtime.rpcClient = new RpcClient({
      command,
      spawnArgsPrefix,
      cwd,
      provider,
      model,
      childEnv,
      noExtensions,
      noAgentsFiles,
    });
    runtime.rpcUnsubscribe = runtime.rpcClient.onEvent((event) =>
      this.handleEvent(runtime, event),
    );

    // Count MCPs to estimate loading time and show a progress message while they initialize.
    let mcpLoadingMs = 0;
    try {
      const mcpConfigPath = path.join(resolveCodingAgentAgentRoot(), "mcp.json");
      const mcpJson = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
      if (mcpJson?.mcpServers && typeof mcpJson.mcpServers === "object") {
        const mcpCount = Object.keys(mcpJson.mcpServers).length;
        if (mcpCount > 0) {
          mcpLoadingMs = mcpCount * 5 * 1000;
          this.postToWebviewForTab(tabId, {
            type: "mcp_loading_start",
            seconds: mcpCount * 5,
          });
        }
      }
    } catch {
      // mcp.json absent or malformed — skip loading indicator
    }

    try {
      await Promise.all([
        runtime.rpcClient.start(),
        mcpLoadingMs > 0 ? new Promise((r) => setTimeout(r, mcpLoadingMs)) : Promise.resolve(),
      ]);
      if (mcpLoadingMs > 0) {
        this.postToWebviewForTab(tabId, { type: "mcp_loading_done" });
      }

      // Send a silent background prompt to prime the provider's prompt cache.
      // The warm-up exchange is invisible to the user (handleEvent suppresses
      // all events while warmingUp is true) but causes the full system prompt
      // (including all MCP tool descriptions) to be cached by the API, so the
      // user's first real message benefits from a cache hit.
      //
      // We abort after 200ms to prevent the agent from executing any tools
      // (tool use would trigger macOS TCC permission dialogs on every startup).
      // 200ms is enough for the API to receive and start processing the request
      // (populating the cache) but fast enough to stop before tool calls.
      try {
        const warmupPromise = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            runtime.warmingUp = false;
            runtime._warmupResolve = null;
            resolve();
          }, 30_000);
          runtime._warmupResolve = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
        runtime.warmingUp = true;
        await runtime.rpcClient.prompt(".");
        setTimeout(() => runtime.rpcClient?.abort().catch(() => {}), 200);
        await warmupPromise;
      } catch {
        runtime.warmingUp = false;
        runtime._warmupResolve = null;
      }

      runtime.rpcSpawnKey = spawnKey;
      // A new process can never be mid-turn — reset any stale busy state
      // left over from a previous process that exited without sending agent_end.
      runtime.agentBusy = false;
      runtime.pendingAssistantText = "";
      runtime.currentAssistantMessageId = null;
      runtime.pendingThinkingText = "";
      runtime.currentThinkingMessageId = null;
      await this.syncSessionAfterRpcStart(runtime);
      return runtime;
    } catch (error) {
      this.postToWebviewForTab(tabId, {
        type: "error",
        text: toErrorMessage(error),
      });
      runtime.rpcUnsubscribe?.();
      runtime.rpcUnsubscribe = null;
      runtime.rpcClient = null;
      runtime.rpcSessionSynced = false;
      runtime.rpcSpawnKey = "";
      throw error;
    }
  }

  async disposeRpcProcess(tabId) {
    if (tabId === undefined) {
      this._ensureByTab.clear();
      await Promise.all(
        [...this.tabRuntimes.keys()].map((id) => this.disposeRpcProcess(id)),
      );
      return;
    }
    const runtime = this.tabRuntimes.get(tabId);
    if (!runtime) return;
    this._ensureByTab.delete(tabId);
    this._stopAutoRecoveryWatchdog(runtime);
    runtime.rpcUnsubscribe?.();
    runtime.rpcUnsubscribe = null;
    await runtime.rpcClient?.stop();
    runtime.rpcClient = null;
    runtime.rpcSessionSynced = false;
    runtime.rpcSpawnKey = "";
    this.tabRuntimes.delete(tabId);
  }

  /**
   * @param {Record<string, unknown>} stats
   * @param {string} [sessionName]
   * @param {string | null} [tabId]
   * @param {Array<{key: string, tokensEstimated: number, enabled: boolean}>} [toolGroups]
   * @param {Array<{name: string, tokensEstimated: number, enabled: boolean}>} [skillEntries]
   * @param {Array<{name: string, tokensEstimated: number, enabled: boolean}>} [agentEntries]
   */
  showSessionInfoInChat(stats, sessionName, tabId = null, toolGroups, skillEntries, agentEntries) {
    const text = formatSessionInfoForWebview({ stats, sessionName, toolGroups, skillEntries, agentEntries });
    this.pushHistory("session", text, undefined, tabId);
    this.postToWebviewForTab(tabId, { type: "session_info", text });
    this.postToWebviewForTab(tabId, { type: "status", text: "" });
    this.postToWebviewForTab(tabId, { type: "busy", busy: false });
  }

  /** @param {unknown[]} keys */
  async handleToolPickerApply(keys) {
    try {
      const runtime = await this.ensureClientStarted();
      if (!runtime.rpcClient) throw new Error("RPC client not available");
      const keyList = keys.map(String);
      // Apply with no selected optional groups: if there are no such groups, skip
      // set_tool_picker (older or minimal RPC sessions) to avoid spurious errors/timeouts.
      if (keyList.length === 0) {
        const st0 = await runtime.rpcClient.getToolPickerState();
        if (!st0) throw new Error("get_tool_picker_state returned no data");
        const g0 = Array.isArray(st0.groups) ? st0.groups : [];
        if (g0.length === 0) {
          const body = formatToolPickerForWebview(st0);
          this.pushHistory("tools", body);
          this.postToWebview({ type: "tools_info", text: body });
          this.postToWebview({ type: "status", text: "" });
          return;
        }
      }
      await runtime.rpcClient.setToolPicker(keyList);
      const st = await runtime.rpcClient.getToolPickerState();
      if (!st) throw new Error("get_tool_picker_state returned no data");
      const body = formatToolPickerForWebview(st);
      this.pushHistory("tools", body);
      this.postToWebview({ type: "tools_info", text: body });
      this.postToWebview({ type: "status", text: "" });
    } catch (error) {
      const errText = rpcToolPickerErrorMessage(error);
      this.pushHistory("error", errText);
      this.postToWebview({ type: "error", text: errText });
    } finally {
      this.postToWebview({ type: "tool_picker_close" });
      this.postToWebview({ type: "busy", busy: false });
    }
  }

  /**
   * Build and post the model-picker payload to the webview without pushing a
   * `/model` user message into the chat history. Shared by the typed `/model`
   * slash command and by the model-indicator click in the input toolbar.
   *
   * Caller must have already started the RPC client (`ensureClientStarted`).
   * Surfaces RPC failures by throwing — caller decides whether to render the
   * error in chat history (typed `/model`) or as a transient error (button click).
   */
  async _openModelPickerFlow() {
    const runtime = await this.ensureClientStarted();
    if (!runtime.rpcClient) throw new Error("RPC client not available");
    const [models, st] = await Promise.all([
      runtime.rpcClient.getAvailableModels(),
      runtime.rpcClient.getState(),
    ]);
    if (!Array.isArray(models) || models.length === 0) {
      const body =
        "No models available with configured auth. Run `free-code` in a terminal and use `/login`, or set provider API keys (see README) and try again.";
      this.pushHistory("tools", body);
      this.postToWebview({ type: "tools_info", text: body });
      this.postToWebview({ type: "status", text: "" });
      this.postToWebview({ type: "busy", busy: false });
      return;
    }
    const current =
      st && typeof st === "object" && "model" in st ? st.model : undefined;
    this.postToWebview({
      type: "open_model_picker",
      state: { models, current },
    });
    this.postToWebview({ type: "busy", busy: false });
  }

  /**
   * Resolve the same cwd used to spawn `free-code --mode rpc` (see `ensureClientStarted`),
   * so the workspace indicator and the agent process always agree on the active folder.
   * @returns {string | null}
   */
  getWorkspaceCwd() {
    const config = vscode.workspace.getConfiguration("free-code");
    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    const configuredCwd = config.get("cwd", "");
    const cwd =
      (typeof configuredCwd === "string" && configuredCwd.trim()) ||
      workspaceCwd ||
      "";
    return cwd ? cwd : null;
  }

  /**
   * Footer workspace pill: offer switching folder / cwd, not only revealing in the OS (Finder is not a picker).
   */
  async handleWorkspaceIndicatorClick() {
    const target = this.getWorkspaceCwd();
    const revealLabel =
      process.platform === "darwin"
        ? "Reveal in Finder"
        : process.platform === "win32"
          ? "Reveal in File Explorer"
          : "Reveal in file manager";
    /** @type {({ label: string; description: string; action: "open_folder" | "set_cwd" | "reveal" })[]} */
    const items = [
      {
        label: "$(folder-opened) Open folder in VS Code…",
        description:
          "Switch the editor to another project (same as File > Open Folder)",
        action: "open_folder",
      },
      {
        label: "$(root-folder) Set agent working directory…",
        description:
          "Writes free-code.cwd so the agent uses another folder without closing this window",
        action: "set_cwd",
      },
      {
        label: `$(eye) ${revealLabel}`,
        description: target ? target : "Current folder",
        action: "reveal",
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Free Code workspace",
      placeHolder: "Choose how to change or inspect the active folder",
    });
    if (!picked) return;
    if (picked.action === "open_folder") {
      await vscode.commands.executeCommand("workbench.action.files.openFolder");
      return;
    }
    if (picked.action === "set_cwd") {
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Use this folder",
        title: "Agent working directory (free-code.cwd)",
      });
      if (!folders?.[0]) return;
      const folderPath = folders[0].fsPath;
      const config = vscode.workspace.getConfiguration("free-code");
      const configurationTarget = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await config.update("cwd", folderPath, configurationTarget);
      this.postWorkspaceIndicator();
      try {
        await this.ensureClientStarted();
      } catch {
        // ensureClientStarted posts errors to the webview
      }
      return;
    }
    if (target) {
      void vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(target),
      );
    }
  }

  /** Export current conversation to Markdown (RPC session, or sidebar transcript fallback). */
  async handleExportConversation() {
    const tab = this.getActiveTab();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suggested = `free-code-chat-${stamp}.md`;
    const wf = vscode.workspace.workspaceFolders?.[0];
    const defaultUri = wf
      ? vscode.Uri.joinPath(wf.uri, suggested)
      : vscode.Uri.file(path.join(homedir(), suggested));
    const out = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ["md"], "All files": ["*"] },
      title: "Export conversation",
      saveLabel: "Export",
    });
    if (!out) return;
    const dest = out.fsPath;
    try {
      await this.ensureClientStarted();
      const runtime = this.getActiveRuntime();
      if (!runtime.rpcClient) {
        throw new Error("RPC client not available");
      }
      const result = await runtime.rpcClient.exportMarkdown(dest);
      await vscode.window.showInformationMessage(
        `Conversation exported to ${result.path}`,
      );
    } catch (e) {
      const md = formatWebviewTranscriptMarkdown(
        tab?.messages ?? [],
        tab?.label,
      );
      try {
        await writeFile(dest, md, "utf8");
        const hint = e instanceof Error ? e.message : String(e);
        await vscode.window.showInformationMessage(
          `Exported sidebar transcript to ${dest}. (Full session export was unavailable: ${hint})`,
        );
      } catch (writeErr) {
        vscode.window.showErrorMessage(
          writeErr instanceof Error ? writeErr.message : String(writeErr),
        );
      }
    }
  }

  /**
   * Push the workspace folder + git branch into the webview footer (mirrors the CLI footer
   * `~/Documents/repositories/free-code (main)`). Hides the indicator when no workspace folder
   * is open. Safe to call from any path: never throws into the chat. Also (re)installs the
   * `.git/HEAD` watcher so branch changes refresh the label without reloading the webview.
   */
  postWorkspaceIndicator() {
    try {
      const cwd = this.getWorkspaceCwd();
      if (!cwd) {
        this.postToWebview({ type: "workspace_indicator", workspace: null });
        this._teardownGitWatcher();
        return;
      }
      const gitPaths = findGitHeadPath(cwd);
      const branch = gitPaths ? readGitBranch(gitPaths.headPath) : null;
      const name = gitPaths
        ? path.basename(gitPaths.repoDir)
        : path.basename(cwd) || cwd;
      const displayPath = formatHomePath(gitPaths ? gitPaths.repoDir : cwd);
      this.postToWebview({
        type: "workspace_indicator",
        workspace: {
          path: cwd,
          displayPath,
          name,
          branch,
        },
      });
      this._setupGitWatcher(cwd, gitPaths?.headPath ?? null);
    } catch (error) {
      console.error("Free Code: postWorkspaceIndicator", error);
    }
  }

  /**
   * Watch the directory containing `.git/HEAD` so branch switches update the footer label.
   * Mirrors the CLI's `FooterDataProvider.setupGitWatcher` (watches the parent dir, not HEAD,
   * because git uses atomic writes that change HEAD's inode and break `fs.watch` on the file
   * itself). The watcher is rebuilt only when `cwd` changes; reuses the existing handle
   * otherwise to avoid churn on every model/session refresh.
   * @param {string} cwd
   * @param {string | null} headPath
   */
  _setupGitWatcher(cwd, headPath) {
    if (this._gitWatchedCwd === cwd && this._gitHeadWatcher) {
      return;
    }
    this._teardownGitWatcher();
    this._gitWatchedCwd = cwd;
    if (!headPath) return;
    try {
      this._gitHeadWatcher = watch(
        path.dirname(headPath),
        (_eventType, filename) => {
          if (filename && filename.toString() !== "HEAD") return;
          if (this._gitRefreshTimer) return;
          this._gitRefreshTimer = setTimeout(() => {
            this._gitRefreshTimer = null;
            this.postWorkspaceIndicator();
          }, 500);
        },
      );
    } catch {
      this._gitHeadWatcher = null;
    }
  }

  _teardownGitWatcher() {
    if (this._gitRefreshTimer) {
      clearTimeout(this._gitRefreshTimer);
      this._gitRefreshTimer = null;
    }
    if (this._gitHeadWatcher) {
      try {
        this._gitHeadWatcher.close();
      } catch {
        // ignore close errors (already disposed)
      }
      this._gitHeadWatcher = null;
    }
    this._gitWatchedCwd = null;
  }

  /**
   * Parse the custom free-code diff format and return an array of 0-based line
   * numbers (in the new file) that were added or modified.
   * Format per line: first char '+' (added), '-' (removed), or ' ' (context),
   * followed by a padded line number, a space, and content.
   * @param {string} diff
   * @returns {number[]}
   */
  _parseAddedLines(diff) {
    const lines = diff.split("\n");
    /** @type {number[]} */
    const addedLines = [];
    for (const line of lines) {
      if (!line || line[0] !== "+") continue;
      const rest = line.slice(1).trimStart();
      if (rest === "..." || rest.endsWith(" ...")) continue;
      const spaceIdx = rest.indexOf(" ");
      const lineNumStr = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const lineNum = parseInt(lineNumStr, 10);
      if (!Number.isNaN(lineNum) && lineNum > 0) {
        addedLines.push(lineNum - 1);
      }
    }
    return addedLines;
  }

  /**
   * Remove all active editor decorations applied by a previous edit.
   */
  _clearEditDecorations() {
    for (const { editor, type } of this._activeEditorDecorations) {
      try {
        editor.setDecorations(type, []);
      } catch {
        // Editor may have been closed.
      }
    }
    this._activeEditorDecorations = [];
  }

  /**
   * Apply green-line decorations to any visible editor showing `absPath`
   * for the given 0-based line numbers.
   * @param {string} absPath
   * @param {number[]} lines0Based
   */
  _applyEditDecorations(absPath, lines0Based) {
    if (lines0Based.length === 0) return;
    if (!this._editAddedDecorationType) {
      this._editAddedDecorationType =
        vscode.window.createTextEditorDecorationType({
          backgroundColor: new vscode.ThemeColor(
            "diffEditor.insertedLineBackground",
          ),
          isWholeLine: true,
          overviewRulerColor: new vscode.ThemeColor(
            "editorOverviewRuler.addedForeground",
          ),
          overviewRulerLane: vscode.OverviewRulerLane.Left,
        });
    }
    const ranges = lines0Based.map((ln) => new vscode.Range(ln, 0, ln, 0));
    for (const editor of vscode.window.visibleTextEditors) {
      const editorPath = editor.document.uri.fsPath;
      if (editorPath !== absPath) continue;
      editor.setDecorations(this._editAddedDecorationType, ranges);
      this._activeEditorDecorations.push({
        editor,
        type: this._editAddedDecorationType,
      });
    }
  }

  /**
   * Push the active model into the webview footer indicator. Safe to call from
   * any path: it silently skips when the RPC client is not started yet (the
   * webview keeps showing the previous label) and never throws into the chat.
   */
  async postModelIndicator() {
    try {
      const runtime = this.getActiveRuntime();
      if (!runtime.rpcClient) {
        this.postToWebview({ type: "model_indicator", model: null });
        return;
      }
      const st = await runtime.rpcClient.getState();
      const m =
        st && typeof st === "object" && "model" in st ? st.model : undefined;
      if (!m || typeof m !== "object") {
        this.postToWebview({ type: "model_indicator", model: null });
        return;
      }
      const o = /** @type {Record<string, unknown>} */ (m);
      const id = typeof o.id === "string" ? o.id : "";
      const provider = typeof o.provider === "string" ? o.provider : "";
      const name = typeof o.name === "string" ? o.name : id;
      this.postToWebview({
        type: "model_indicator",
        model: id ? { id, provider, name } : null,
      });
    } catch (error) {
      console.error("Free Code: postModelIndicator", error);
    }
  }

  /**
   * Push the active saved profile into the webview footer indicator.
   */
  postProfileIndicator() {
    try {
      const data = loadProfilesDataForPlugin();
      const active =
        typeof data.activeProfile === "string" && data.activeProfile
          ? data.activeProfile
          : null;
      this.postToWebview({
        type: "profile_indicator",
        profile: active,
      });
    } catch (error) {
      console.error("Free Code: postProfileIndicator", error);
    }
  }

  /**
   * Sync tab-level RAG KB from the active profile persisted on disk.
   * Useful when profile changes are triggered by agent tools.
   * @param {string} tabId
   */
  async syncRagKbFromActiveProfile(tabId) {
    const data = loadProfilesDataForPlugin();
    const activeName =
      typeof data.activeProfile === "string" ? data.activeProfile : "";
    if (!activeName) return;
    const profile = data.profiles[activeName];
    if (!profile) return;
    const warnings = [];
    await this.applyProfileRagKnowledgeBase(tabId, profile, warnings);
  }

  /**
   * Switch the active model via RPC `set_model` and confirm the result in the chat.
   * @param {string} provider
   * @param {string} modelId
   */
  async handleModelPickerApply(provider, modelId) {
    try {
      const runtime = await this.ensureClientStarted();
      if (!runtime.rpcClient) throw new Error("RPC client not available");
      const result = await runtime.rpcClient.setModel(provider, modelId);
      const m =
        result && typeof result === "object"
          ? /** @type {Record<string, unknown>} */ (result)
          : null;
      const name = m && typeof m.name === "string" ? m.name : modelId;
      const prov = m && typeof m.provider === "string" ? m.provider : provider;
      const id = m && typeof m.id === "string" ? m.id : modelId;
      const body = `Model set to ${id} [${prov}] (${name})`;
      this.pushHistory("tools", body);
      this.postToWebview({ type: "tools_info", text: body });
      this.postToWebview({ type: "status", text: "" });
      void this.postModelIndicator();
    } catch (error) {
      const errText = toErrorMessage(error);
      this.pushHistory("error", errText);
      this.postToWebview({ type: "error", text: errText });
    } finally {
      this.postToWebview({ type: "model_picker_close" });
      this.postToWebview({ type: "busy", busy: false });
    }
  }

  /** @param {string[]} enabledNames */
  async handleSkillPickerApply(enabledNames) {
    try {
      const runtime = await this.ensureClientStarted();
      if (!runtime.rpcClient) throw new Error("RPC client not available");
      const names = enabledNames.map(String);
      await runtime.rpcClient.setSkillPicker(names);
      const st = await runtime.rpcClient.getSkillPickerState();
      if (!st) throw new Error("get_skill_picker_state returned no data");
      const body = formatSkillPickerForWebview(st);
      this.pushHistory("tools", body);
      this.postToWebview({ type: "tools_info", text: body });
      this.postToWebview({ type: "status", text: "" });
    } catch (error) {
      const errText = rpcToolPickerErrorMessage(error);
      this.pushHistory("error", errText);
      this.postToWebview({ type: "error", text: errText });
    } finally {
      this.postToWebview({ type: "skill_picker_close" });
      this.postToWebview({ type: "busy", busy: false });
    }
  }

  async handleAgentPickerApply(enabledNames) {
    try {
      const runtime = await this.ensureClientStarted();
      if (!runtime.rpcClient) throw new Error("RPC client not available");
      const names = enabledNames.map(String);
      await runtime.rpcClient.setAgentPicker(names);
      const st = await runtime.rpcClient.getAgentPickerState();
      if (!st) throw new Error("get_agent_picker_state returned no data");
      const body = formatAgentPickerForWebview(st);
      this.pushHistory("tools", body);
      this.postToWebview({ type: "tools_info", text: body });
      this.postToWebview({ type: "status", text: "" });
    } catch (error) {
      const errText = rpcToolPickerErrorMessage(error);
      this.pushHistory("error", errText);
      this.postToWebview({ type: "error", text: errText });
    } finally {
      this.postToWebview({ type: "agent_picker_close" });
      this.postToWebview({ type: "busy", busy: false });
    }
  }

  handleEvent(runtime, event) {
    // Suppress all UI events during the background warm-up prompt.
    // Only agent_end matters so we know when the warm-up is done.
    if (runtime.warmingUp) {
      if (event?.type === "agent_end") {
        runtime.warmingUp = false;
        runtime._warmupResolve?.();
        runtime._warmupResolve = null;
      }
      return;
    }
    if (isAgentProgressEvent(event)) {
      this._markAgentProgress(runtime);
    }
    switch (event?.type) {
      case "message_start": {
        if (event.message?.role !== "custom" || event.message.display === false)
          return;
        const text = formatCustomMessageForWebview(event.message);
        if (!text) return;
        this.pushHistory("custom", text, undefined, runtime.tabId);
        this.postToWebviewForRuntime(runtime, { type: "custom_message", text });
        this.appendSubagentResultToTab(runtime, text);
        return;
      }
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta?.type === "thinking_delta") {
          // Stream model reasoning into a collapsed details block in the chat.
          // Matches the CLI, which prints thinking above the final answer; here we hide it
          // by default to keep the conversation clean and let the user expand on demand.
          if (!runtime.currentThinkingMessageId) {
            runtime.currentThinkingMessageId = `thinking-${Date.now()}`;
            runtime.pendingThinkingText = "";
            this.postToWebviewForRuntime(runtime, {
              type: "thinking_start",
              messageId: runtime.currentThinkingMessageId,
            });
          }
          if (typeof delta.delta === "string") {
            runtime.pendingThinkingText += delta.delta;
            this.postToWebviewForRuntime(runtime, {
              type: "thinking_delta",
              messageId: runtime.currentThinkingMessageId,
              text: delta.delta,
            });
          }
          return;
        }
        if (delta?.type !== "text_delta") return;
        if (!runtime.currentAssistantMessageId) {
          runtime.currentAssistantMessageId = `assistant-${Date.now()}`;
          runtime.pendingAssistantText = "";
          this.postToWebviewForRuntime(runtime, {
            type: "assistant_message_start",
            messageId: runtime.currentAssistantMessageId,
          });
        }
        if (typeof delta.delta === "string") {
          runtime.pendingAssistantText += delta.delta;
        }
        this.postToWebviewForRuntime(runtime, {
          type: "assistant_message_delta",
          messageId: runtime.currentAssistantMessageId,
          text: delta.delta,
        });
        return;
      }
      case "tool_execution_start": {
        // Mirror the interactive TUI: render the tool invocation (name + args) inline
        // in the chat, not just as a status line. This is what the CLI shows and what
        // the user expects ("same as free-code cli").
        //
        // Finalize the current assistant bubble so subsequent text_deltas create a new
        // bubble BELOW the tool_call / tool_result rows (CLI order: preamble text →
        // tool call → tool result → final answer). Without this, the final text is
        // appended to the preamble bubble and appears above the tool activity.
        //
        // Flush thinking BEFORE assistant so the persisted order matches what the user
        // saw on screen (thinking → preamble → tool call). Without this, reloading the
        // webview would re-render thinking after the assistant bubble.
        this.flushThinking(runtime);
        if (runtime.pendingAssistantText) {
          this.pushHistory(
            "assistant",
            runtime.pendingAssistantText,
            undefined,
            runtime.tabId,
          );
          runtime.pendingAssistantText = "";
        }
        runtime.currentAssistantMessageId = null;
        // Track the file path for edit/write tool calls so we can apply decorations on completion.
        if (
          (event.toolName === "edit" || event.toolName === "write") &&
          typeof event.args?.path === "string" &&
          event.toolCallId
        ) {
          runtime.pendingEditPaths.set(event.toolCallId, event.args.path);
        }
        this.postToWebviewForRuntime(runtime, {
          type: "status",
          text: `Tool: ${event.toolName}`,
        });
        this.postToWebviewForRuntime(runtime, {
          type: "tool_call",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
        });
        try {
          this.pushHistory(
            "tool_call",
            JSON.stringify({
              toolName: event.toolName,
              args: event.args ?? null,
            }),
            undefined,
            runtime.tabId,
          );
        } catch {
          this.pushHistory(
            "tool_call",
            JSON.stringify({ toolName: event.toolName, args: null }),
            undefined,
            runtime.tabId,
          );
        }
        return;
      }
      case "tool_execution_end": {
        this.postToWebviewForRuntime(runtime, { type: "status", text: "" });
        this.postToWebviewForRuntime(runtime, {
          type: "tool_result",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError === true,
        });
        try {
          this.pushHistory(
            "tool_result",
            JSON.stringify({
              toolName: event.toolName,
              result: event.result ?? null,
              isError: event.isError === true,
            }),
            undefined,
            runtime.tabId,
          );
        } catch {
          this.pushHistory(
            "tool_result",
            JSON.stringify({
              toolName: event.toolName,
              result: null,
              isError: event.isError === true,
            }),
            undefined,
            runtime.tabId,
          );
        }
        // When the LLM successfully calls the `set_active_model` tool (shipped as the
        // opt-in `examples/extensions/set-active-model` extension), refresh the active-
        // model indicator immediately instead of waiting for the next session sync.
        // The matching `set_model` RPC has already mutated the agent session by the
        // time this event fires, so `postModelIndicator` reads the new model.
        if (
          event.toolName === "set_active_model" &&
          event.isError !== true &&
          runtime.tabId === this.activeTabId
        ) {
          void this.postModelIndicator();
        }
        if (
          event.toolName === "set_active_profile" &&
          event.isError !== true &&
          runtime.tabId === this.activeTabId
        ) {
          this.postProfileIndicator();
          void this.syncRagKbFromActiveProfile(runtime.tabId);
        }
        // Apply green-line decorations in any visible editor for a successful edit/write.
        if (
          (event.toolName === "edit" || event.toolName === "write") &&
          event.isError !== true &&
          event.toolCallId
        ) {
          const relPath = runtime.pendingEditPaths.get(event.toolCallId);
          runtime.pendingEditPaths.delete(event.toolCallId);
          if (relPath) {
            try {
              const cwd = this.getWorkspaceCwd();
              const absPath = path.isAbsolute(relPath)
                ? relPath
                : cwd
                  ? path.join(cwd, relPath)
                  : relPath;
              const diff =
                event.result &&
                typeof event.result === "object" &&
                event.result.details &&
                typeof event.result.details === "object" &&
                typeof event.result.details.diff === "string"
                  ? event.result.details.diff
                  : null;
              if (diff) {
                this._clearEditDecorations();
                const lines = this._parseAddedLines(diff);
                this._applyEditDecorations(absPath, lines);
              }
            } catch {
              // Decoration is best-effort; never throw into the chat.
            }
          }
        }
        return;
      }
      case "agent_end": {
        // Same ordering as tool_execution_start: flush thinking first so the
        // persisted history reflects what the user saw stream (thinking → answer).
        this.flushThinking(runtime);
        if (runtime.pendingAssistantText) {
          this.pushHistory(
            "assistant",
            runtime.pendingAssistantText,
            undefined,
            runtime.tabId,
          );
        }
        runtime.pendingAssistantText = "";
        runtime.currentAssistantMessageId = null;
        this.postToWebviewForRuntime(runtime, { type: "status", text: "" });
        this.postToWebviewForRuntime(runtime, { type: "agent_end" });
        this.postToWebviewForTab(runtime.tabId, { type: "busy", busy: false });
        this._stopAutoRecoveryWatchdog(runtime);
        return;
      }
      case "extension_error": {
        const err = event.error || "Extension error";
        this.pushHistory("error", err, undefined, runtime.tabId);
        this.postToWebviewForRuntime(runtime, { type: "error", text: err });
        this.postToWebviewForTab(runtime.tabId, { type: "busy", busy: false });
        this._stopAutoRecoveryWatchdog(runtime);
        return;
      }
      case "session_info": {
        this.showSessionInfoInChat(
          event.stats,
          typeof event.sessionName === "string" ? event.sessionName : undefined,
          runtime.tabId,
        );
        return;
      }
      case "extension_ui_request": {
        void this.handleExtensionUIRequest(runtime, event);
        return;
      }
      case "agent_start": {
        // Clear decorations from the previous turn so stale highlights don't
        // accumulate when the agent starts working on a new prompt.
        this._clearEditDecorations();
        runtime.pendingEditPaths.clear();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Handle `extension_ui_request` events emitted by the agent (e.g. damage-control's MCP
   * authorization prompt). Maps each method to a native VS Code dialog / notification and
   * sends the matching `extension_ui_response` back for dialog methods. Fire-and-forget
   * methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) are surfaced
   * to the user but do not send a response.
   * @param {Record<string, unknown>} event
   */
  async handleExtensionUIRequest(runtime, event) {
    const id = typeof event?.id === "string" ? event.id : "";
    const method = typeof event?.method === "string" ? event.method : "";
    if (!id || !method) return;
    const client = runtime.rpcClient;
    if (!client) return;

    const respondCancelled = () =>
      client.sendExtensionUIResponse(id, { cancelled: true });

    // After any native dialog (modal confirm, QuickPick, InputBox), VS Code returns
    // focus to its last active panel — usually the code editor, not this webview.
    // The user's next paste/keystroke ends up in the wrong place unless we explicitly
    // bring the chat view to the foreground and refocus its input.
    const restoreChatFocus = () => {
      try {
        this.view?.show?.(false);
      } catch {
        // ignore show errors (view may be disposed)
      }
      this.postToWebview({ type: "focus_input" });
    };

    try {
      switch (method) {
        case "confirm": {
          const title =
            typeof event.title === "string" ? event.title : "Confirm";
          const message =
            typeof event.message === "string" ? event.message : "";
          const prompt = message ? `${title}\n\n${message}` : title;
          const pick = await vscode.window.showInformationMessage(
            prompt,
            { modal: true },
            "Allow",
            "Deny",
          );
          if (pick === undefined) {
            client.sendExtensionUIResponse(id, { cancelled: true });
          } else {
            client.sendExtensionUIResponse(id, { confirmed: pick === "Allow" });
          }
          restoreChatFocus();
          return;
        }
        case "select": {
          const title =
            typeof event.title === "string" ? event.title : "Select";
          const options = Array.isArray(event.options)
            ? event.options.filter((o) => typeof o === "string")
            : [];
          const pick = await vscode.window.showQuickPick(options, {
            title,
            placeHolder: title,
            ignoreFocusOut: true,
          });
          if (pick === undefined) {
            client.sendExtensionUIResponse(id, { cancelled: true });
          } else {
            client.sendExtensionUIResponse(id, { value: pick });
          }
          restoreChatFocus();
          return;
        }
        case "input": {
          const title = typeof event.title === "string" ? event.title : "Input";
          const placeholder =
            typeof event.placeholder === "string"
              ? event.placeholder
              : undefined;
          const value = await vscode.window.showInputBox({
            title,
            placeHolder: placeholder,
            ignoreFocusOut: true,
          });
          if (value === undefined) {
            client.sendExtensionUIResponse(id, { cancelled: true });
          } else {
            client.sendExtensionUIResponse(id, { value });
          }
          restoreChatFocus();
          return;
        }
        case "editor": {
          const title = typeof event.title === "string" ? event.title : "Edit";
          const prefill =
            typeof event.prefill === "string" ? event.prefill : "";
          const value = await vscode.window.showInputBox({
            title,
            value: prefill,
            ignoreFocusOut: true,
          });
          if (value === undefined) {
            client.sendExtensionUIResponse(id, { cancelled: true });
          } else {
            client.sendExtensionUIResponse(id, { value });
          }
          restoreChatFocus();
          return;
        }
        case "notify": {
          const message =
            typeof event.message === "string" ? event.message : "";
          if (!message) return;
          const notifyType = event.notifyType;
          
          // Display token usage (TPS) as a static status bar message instead of a notification popup
          if (message.startsWith("TPS") && notifyType === "info") {
            this.postToWebviewForRuntime(runtime, {
              type: "token_usage",
              text: message,
            });
            return;
          }
          
          if (notifyType === "error") {
            void vscode.window.showErrorMessage(message);
            this.postToWebviewForRuntime(runtime, { type: "error", text: message });
          } else if (notifyType === "warning") {
            void vscode.window.showWarningMessage(message);
            this.postToWebviewForRuntime(runtime, { type: "hint", text: message });
          } else {
            void vscode.window.showInformationMessage(message);
          }
          return;
        }
        case "open_external": {
          const raw = typeof event.url === "string" ? event.url.trim() : "";
          if (!raw) return;
          try {
            await vscode.env.openExternal(vscode.Uri.parse(raw));
          } catch {
            // ignore
          }
          return;
        }
        case "setStatus": {
          // The "profile" status is a TUI status-bar line ("- profile:<name>")
          // that profile-manager re-emits on startup/session restore. The GUI
          // shows the active profile via its own native indicator
          // (postProfileIndicator), so forwarding it here would only duplicate
          // it as a stray status line. Drop it.
          const statusKey =
            typeof event.statusKey === "string" ? event.statusKey : "";
          if (statusKey === "profile") return;
          const statusText =
            typeof event.statusText === "string" ? event.statusText : "";
          if (statusKey === "mode") {
            this.postToWebviewForRuntime(runtime, {
              type: "mode_indicator",
              mode: statusText,
            });
            this.postToWebviewForRuntime(runtime, { type: "status", text: "" });
            return;
          }
          this.postToWebviewForRuntime(runtime, {
            type: "status",
            text: statusText,
          });
          return;
        }
        case "setWidget": {
          const widgetKey =
            typeof event.widgetKey === "string" ? event.widgetKey : "";
          const lines = Array.isArray(event.widgetLines)
            ? event.widgetLines.filter((line) => typeof line === "string")
            : null;
          if (widgetKey.startsWith("sub-") && lines) {
            this.upsertSubagentWidget(runtime, widgetKey, lines);
          } else if (widgetKey.startsWith("sub-")) {
            this.removeSubagentWidget(runtime, widgetKey);
          }
          return;
        }
        case "setTitle":
        case "set_editor_text":
          // Fire-and-forget with no host-side effect required for the MCP flow.
          return;
        case "questionnaire": {
          const rawQuestions = Array.isArray(event.questions)
            ? event.questions
            : [];
          const questions = rawQuestions
            .filter((q) => q && typeof q === "object")
            .map((q, idx) => {
              const obj = /** @type {Record<string, unknown>} */ (q);
              const rawOpts = Array.isArray(obj.options) ? obj.options : [];
              const options = rawOpts
                .filter((o) => o && typeof o === "object")
                .map((o) => {
                  const opt = /** @type {Record<string, unknown>} */ (o);
                  return {
                    value: typeof opt.value === "string" ? opt.value : "",
                    label: typeof opt.label === "string" ? opt.label : "",
                    description:
                      typeof opt.description === "string"
                        ? opt.description
                        : undefined,
                  };
                })
                .filter((o) => o.value || o.label);
              return {
                id:
                  typeof obj.id === "string" && obj.id ? obj.id : `q${idx + 1}`,
                prompt: typeof obj.prompt === "string" ? obj.prompt : "",
                options,
                label:
                  typeof obj.label === "string" ? obj.label : `Q${idx + 1}`,
                allowOther: obj.allowOther !== false,
              };
            })
            .filter((q) => q.prompt && q.options.length > 0);
          if (questions.length === 0) {
            client.sendExtensionUIResponse(id, { cancelled: true });
            return;
          }
          runtime.pendingQuestionnaires.set(id, { rpcClient: client });
          this.postToWebviewForRuntime(runtime, {
            type: "questionnaire_request",
            requestId: id,
            questions,
          });
          return;
        }
        default:
          // Unknown dialog methods: reply cancelled with `unsupported: true` so callers
          // (e.g. the bundled `questionnaire` tool when speaking to a host that hasn't
          // implemented a richer UI) can fall back gracefully instead of treating the
          // missing handler as a user cancellation.
          client.sendExtensionUIResponse(id, {
            cancelled: true,
            unsupported: true,
          });
          return;
      }
    } catch (error) {
      console.error("Free Code: extension_ui_request handler failed", error);
      try {
        respondCancelled();
      } catch {
        // ignore
      }
    }
  }

  postToWebview(payload) {
    this.view?.webview.postMessage(payload);
  }

  /**
   * Resolve a pending questionnaire request emitted via `extension_ui_request` with
   * the answers (or cancellation) the webview gathered from the user. The matching
   * pending entry holds the RPC client that originated the request, so multi-tab
   * sessions route their replies to the correct agent process.
   * @param {Record<string, unknown>} message
   */
  handleQuestionnaireResponse(message) {
    const requestId =
      typeof message.requestId === "string" ? message.requestId : "";
    if (!requestId) return;
    // Find the runtime that owns this pending request — typically the active tab,
    // but loop over all tabs in case the user switched while answering.
    let pending = null;
    let owningRuntime = null;
    for (const runtime of this.tabRuntimes.values()) {
      const entry = runtime.pendingQuestionnaires.get(requestId);
      if (entry) {
        pending = entry;
        owningRuntime = runtime;
        break;
      }
    }
    if (!pending || !owningRuntime) return;
    owningRuntime.pendingQuestionnaires.delete(requestId);
    if (message.cancelled === true) {
      pending.rpcClient.sendExtensionUIResponse(requestId, { cancelled: true });
      return;
    }
    const rawAnswers = Array.isArray(message.answers) ? message.answers : [];
    const answers = rawAnswers
      .filter((a) => a && typeof a === "object")
      .map((a) => {
        const obj = /** @type {Record<string, unknown>} */ (a);
        /** @type {Record<string, unknown>} */
        const out = {
          id: typeof obj.id === "string" ? obj.id : "",
          value: typeof obj.value === "string" ? obj.value : "",
          label: typeof obj.label === "string" ? obj.label : "",
          wasCustom: obj.wasCustom === true,
        };
        if (typeof obj.index === "number" && Number.isFinite(obj.index)) {
          out.index = obj.index;
        }
        return out;
      })
      .filter((a) => a.id);
    pending.rpcClient.sendExtensionUIResponse(requestId, {
      cancelled: false,
      answers,
    });
  }

  async dispose() {
    this.clearSessionStatsPolling();
    this._clearEditDecorations();
    this._editAddedDecorationType?.dispose();
    this._editAddedDecorationType = null;
    await this.disposeRpcProcess();
  }

  getHtml(webview) {
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const templatePath = path.join(mediaDir.fsPath, "chat.html");
    const template = readFileSync(templatePath, "utf8");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaDir, "chat.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaDir, "chat.css"),
    );
    const nonce = String(Date.now());
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return template
      .replaceAll("__FREE_CODE_CSP__", csp)
      .replaceAll("__FREE_CODE_STYLE_HREF__", String(styleUri))
      .replaceAll("__FREE_CODE_SCRIPT_NONCE__", nonce)
      .replaceAll("__FREE_CODE_SCRIPT_SRC__", String(scriptUri))
      .replaceAll("__FREE_CODE_EXTRA_HEAD__", "");
  }
}

function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const onData = (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) break;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  };
  stream.on("data", onData);
  return () => stream.off("data", onData);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAgentProgressEvent(event) {
  if (event?.type === "message_update") {
    const delta = event.assistantMessageEvent;
    // Only treat visible stream chunks as progress; internal updates can arrive
    // while the UI appears stalled and should not reset the recovery watchdog.
    return delta?.type === "text_delta" || delta?.type === "thinking_delta";
  }
  return (
    event?.type === "agent_start" ||
    event?.type === "turn_start" ||
    event?.type === "message_start" ||
    event?.type === "message_end" ||
    event?.type === "tool_execution_start" ||
    event?.type === "tool_execution_end" ||
    event?.type === "extension_ui_request"
  );
}

/** Merges `free-code.env` settings into `process.env` for the spawned `free-code` process. */
function mergeChildEnvForFreeCode(config) {
  const overrides = config.get("env");
  if (!overrides || typeof overrides !== "object") {
    return { ...process.env };
  }
  const out = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v == null) continue;
    out[k] = String(v);
  }
  return out;
}

function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** @param {string} text */
function parseJsonObject(text) {
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object"
      ? /** @type {Record<string, unknown>} */ (data)
      : null;
  } catch {
    return null;
  }
}

/** @param {string[]} lines */
function getSubagentDisplayId(lines) {
  const header = Array.isArray(lines) ? lines[0] : "";
  const match =
    typeof header === "string" ? header.match(/Subagent #(\d+)/) : null;
  return match ? match[1] : null;
}

/** @param {Record<string, unknown>} message */
function formatCustomMessageForWebview(message) {
  const customType =
    typeof message.customType === "string" ? message.customType : "custom";
  const content = message.content;
  let body = "";
  if (typeof content === "string") {
    body = content;
  } else if (Array.isArray(content)) {
    body = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = /** @type {Record<string, unknown>} */ (part);
        if (typeof p.text === "string") return p.text;
        return p.type === "image" ? "[image]" : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (!body.trim()) return "";
  return `[${customType}]\n\n${body}`;
}

/**
 * Explains "Unknown command: get_tool_picker_state" (old on-PATH `free-code` without those RPC verbs).
 * @param {unknown} error
 * @returns {string}
 */
function rpcToolPickerErrorMessage(error) {
  const base = toErrorMessage(error);
  if (
    base.includes("Unknown command: get_tool_picker_state") ||
    base.includes("Unknown command: set_tool_picker") ||
    base.includes("Unknown command: get_skill_picker_state") ||
    base.includes("Unknown command: set_skill_picker")
  ) {
    return `${base}\n\nIf you develop in this monorepo, run \`npm run build\` so \`packages/coding-agent/dist/cli.js\` exists; the extension prefers that over an older \`free-code\` on your PATH. Or point **Free Code: Executable path** at a current build (see docs/free-code-local-setup.md).`;
  }
  return base;
}

/**
 * @param {Record<string, unknown>} state from get_skill_picker_state
 * @returns {string}
 */
function formatSkillPickerForWebview(state) {
  const skills = Array.isArray(state.skills) ? state.skills : [];
  if (skills.length === 0) {
    return "No <skill> blocks in the current merged system prompt. Ensure skills are loaded (same as the terminal CLI), then try again.";
  }
  let out = "Skills (system prompt)\n\n";
  for (const raw of skills) {
    if (!raw || typeof raw !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (raw);
    const name = typeof o.name === "string" ? o.name : "?";
    const on = o.enabled === true ? "on" : "off";
    const te = num(o.tokensEstimated);
    out += `  [${on}] ${name}  (~${te} tok est.)\n`;
  }
  return out.trimEnd();
}

function formatAgentPickerForWebview(state) {
  const agents = Array.isArray(state.agents) ? state.agents : [];
  if (agents.length === 0) {
    return "No agents found in ~/.free-code/agents/. Add agent directories with AGENT.md files to use /pick-agent.";
  }
  let out = "Active agents\n\n";
  for (const raw of agents) {
    if (!raw || typeof raw !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (raw);
    const name = typeof o.name === "string" ? o.name : "?";
    const on = o.enabled === true ? "on" : "off";
    const te = num(o.tokensEstimated);
    out += `  [${on}] ${name}  (~${te} tok est.)\n`;
  }
  return out.trimEnd();
}

/**
 * Plain-text session summary for RPC `session_info`.
 * @param {{ stats: Record<string, unknown>; sessionName?: string; toolGroups?: Array<{key: string, tokensEstimated: number, enabled: boolean}>; skillEntries?: Array<{name: string, tokensEstimated: number, enabled: boolean}>; agentEntries?: Array<{name: string, tokensEstimated: number, enabled: boolean}> }} event
 * @returns {string}
 */
function formatSessionInfoForWebview(event) {
  const stats = event.stats;
  const sessionName = event.sessionName;
  const toolGroups = Array.isArray(event.toolGroups) ? event.toolGroups : [];
  const skillEntries = Array.isArray(event.skillEntries) ? event.skillEntries : [];
  const agentEntries = Array.isArray(event.agentEntries) ? event.agentEntries : [];
  const sid = typeof stats.sessionId === "string" ? stats.sessionId : "";
  const file =
    stats.sessionFile != null && stats.sessionFile !== ""
      ? String(stats.sessionFile)
      : "In-memory";
  let out = "Session info\n\n";
  if (sessionName) out += `Name: ${sessionName}\n`;
  out += `File: ${file}\n`;
  out += `ID: ${sid}\n\n`;
  out += "Messages\n";
  out += `User: ${num(stats.userMessages)}\n`;
  out += `Assistant: ${num(stats.assistantMessages)}\n`;
  out += `Tool calls: ${num(stats.toolCalls)}\n`;
  out += `Tool results: ${num(stats.toolResults)}\n`;
  out += `Total: ${num(stats.totalMessages)}\n\n`;

  const enabledGroups = toolGroups.filter((g) => g && g.enabled);
  const enabledSkills = skillEntries.filter((s) => s && s.enabled);
  const enabledAgents = agentEntries.filter((a) => a && a.enabled);
  let toolsTotal = 0;
  if (enabledGroups.length > 0 || enabledSkills.length > 0 || enabledAgents.length > 0) {
    out += "Tools in context (estimated)\n";
    for (const g of enabledGroups) {
      const tok = typeof g.tokensEstimated === "number" ? g.tokensEstimated : 0;
      toolsTotal += tok;
      out += `${g.key}: ~${tok.toLocaleString()} tok\n`;
    }
    for (const s of enabledSkills) {
      const tok = typeof s.tokensEstimated === "number" ? s.tokensEstimated : 0;
      toolsTotal += tok;
      out += `Skill: ${s.name}: ~${tok.toLocaleString()} tok\n`;
    }
    for (const a of enabledAgents) {
      const tok = typeof a.tokensEstimated === "number" ? a.tokensEstimated : 0;
      toolsTotal += tok;
      out += `Agent: ${a.name}: ~${tok.toLocaleString()} tok\n`;
    }
    out += `Total: ~${toolsTotal.toLocaleString()} tok\n\n`;
  }

  const cu = stats.contextUsage;
  if (cu && typeof cu === "object" && cu.tokens != null) {
    const ctxTok = num(cu.tokens);
    const ctxWin = num(cu.contextWindow);
    const p = cu.percent;
    const pct = typeof p === "number" ? ` (${p.toFixed(1)}%)` : "";
    out += `Context (estimated)\n${ctxTok.toLocaleString()} / ${ctxWin.toLocaleString()}${pct}\n`;
  } else if (
    cu &&
    typeof cu === "object" &&
    cu.tokens === null &&
    num(cu.contextWindow) > 0
  ) {
    out +=
      "Context (estimated)\nunknown (e.g. after compaction, before next model response)\n";
  }
  return out.trimEnd();
}

/**
 * Parse the textual argument list for the chat-side `/model <id> [<provider>]`
 * shortcut. Mirrors the row format the model picker shows (`<id> [<provider>]`)
 * so a user can copy exactly what they see. Also accepts the same pair without
 * brackets and the `<provider>/<id>` form some CLIs use. Returns null when the
 * input is empty or has more than two whitespace-separated tokens — the caller
 * prints usage in that case. Whitespace and bracket spacing are tolerant.
 * @param {string} raw
 * @returns {{ modelId: string, provider: string | null } | null}
 */
function parseModelCommandArgs(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const bracket = s.match(/^(\S+)\s*\[\s*([^\]\s]+)\s*\]\s*$/);
  if (bracket) return { modelId: bracket[1], provider: bracket[2] };
  const slash = s.match(/^([^/\s]+)\/(\S+)\s*$/);
  if (slash) return { modelId: slash[2], provider: slash[1] };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { modelId: parts[0], provider: null };
  if (parts.length === 2) return { modelId: parts[0], provider: parts[1] };
  return null;
}

/**
 * Resolve a parsed `/model …` argument against the live list returned by
 * `get_available_models` (same list the picker shows: only models with
 * configured auth). Tries exact case-sensitive match first, then case
 * insensitive, then offers suggestions. Returns a friendly error string for
 * the chat when the spec is missing, ambiguous, or has no match.
 * @param {unknown[]} rawModels
 * @param {string} modelId
 * @param {string | null} provider
 * @returns {{ ok: true, provider: string, modelId: string, name: string } | { ok: false, error: string }}
 */
function resolveModelMatch(rawModels, modelId, provider) {
  const list = Array.isArray(rawModels)
    ? rawModels
        .map((m) =>
          m && typeof m === "object"
            ? /** @type {Record<string, unknown>} */ (m)
            : null,
        )
        .filter((o) => o !== null)
        .map((o) => ({
          id: typeof o.id === "string" ? o.id : "",
          provider: typeof o.provider === "string" ? o.provider : "",
          name: typeof o.name === "string" ? o.name : "",
        }))
        .filter((o) => o.id && o.provider)
    : [];
  if (list.length === 0) {
    return {
      ok: false,
      error:
        "No models available with configured auth. Run `free-code` in a terminal and use `/login`, or set provider API keys (see README) and try again.",
    };
  }
  const wanted = String(modelId);
  const wantedProv = provider ? String(provider) : null;
  const lowerEq = (a, b) => a.toLowerCase() === b.toLowerCase();

  const exact = list.filter(
    (m) => m.id === wanted && (wantedProv == null || m.provider === wantedProv),
  );
  if (exact.length === 1) {
    const m = exact[0];
    return {
      ok: true,
      provider: m.provider,
      modelId: m.id,
      name: m.name || m.id,
    };
  }
  if (exact.length > 1 && wantedProv == null) {
    const provs = exact.map((m) => m.provider).sort();
    return {
      ok: false,
      error:
        `Model id '${wanted}' is available with multiple providers: ${provs.join(", ")}.\n` +
        `Specify one, e.g. /model ${wanted} [${provs[0]}]`,
    };
  }

  const ci = list.filter(
    (m) =>
      lowerEq(m.id, wanted) &&
      (wantedProv == null || lowerEq(m.provider, wantedProv)),
  );
  if (ci.length === 1) {
    const m = ci[0];
    return {
      ok: true,
      provider: m.provider,
      modelId: m.id,
      name: m.name || m.id,
    };
  }
  if (ci.length > 1 && wantedProv == null) {
    const provs = ci.map((m) => m.provider).sort();
    return {
      ok: false,
      error:
        `Model id '${wanted}' is available with multiple providers: ${provs.join(", ")}.\n` +
        `Specify one, e.g. /model ${ci[0].id} [${provs[0]}]`,
    };
  }

  const idMatches = list.filter((m) => lowerEq(m.id, wanted));
  if (idMatches.length > 0 && wantedProv) {
    const provs = idMatches.map((m) => m.provider).sort();
    return {
      ok: false,
      error:
        `Model '${wanted}' is not available with provider '${wantedProv}'.\n` +
        `Available providers for this id: ${provs.join(", ")}.\n` +
        `Tip: /model ${idMatches[0].id} [${provs[0]}]`,
    };
  }

  const lowerId = wanted.toLowerCase();
  const fuzzy = list
    .filter((m) => m.id.toLowerCase().includes(lowerId))
    .slice(0, 5)
    .map((m) => `  ${m.id} [${m.provider}]`);
  const suffix =
    fuzzy.length > 0
      ? `\nDid you mean:\n${fuzzy.join("\n")}`
      : "\nType /model to open the picker and see all available models.";
  const provLabel = wantedProv ? ` [${wantedProv}]` : "";
  return {
    ok: false,
    error: `Model not found: ${wanted}${provLabel}.${suffix}`,
  };
}

/**
 * @param {Record<string, unknown>} state from get_tool_picker_state
 * @returns {string}
 */
function formatToolPickerForWebview(state) {
  const groups = Array.isArray(state.groups) ? state.groups : [];
  let out = "Active tools\n\n";
  if (groups.length === 0) {
    out +=
      "No optional tool groups (MCP / agent extensions) in this session. If you expected MCP here: turn off **Free Code: No extensions** in settings (default is off, same as the terminal CLI), use a current free-code binary, and ensure MCP is configured like in the terminal.";
  } else {
    out += "Optional groups (same grouping as /pick-tools in TUI):\n";
    for (const g of groups) {
      if (!g || typeof g !== "object") continue;
      const o = /** @type {Record<string, unknown>} */ (g);
      const key = typeof o.key === "string" ? o.key : "?";
      const on = o.enabled === true ? "on" : "off";
      const tc = num(o.toolCount);
      const te = num(o.tokensEstimated);
      out += `  [${on}] ${key}  (${tc} tools, ~${te} tok est. in tool defs)\n`;
    }
  }
  return out.trimEnd();
}

/** @param {unknown} v */
function num(v) {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  return 0;
}

/**
 * Given a list of URIs (files or folders) from showOpenDialog, return an array
 * of absolute file paths. Folders are expanded to all files they contain.
 * @param {import("vscode").Uri[]} uris
 * @returns {Promise<string[]>}
 */
export async function resolveSelectionPaths(uris) {
  const { statSync } = await import("node:fs");
  const paths = [];
  for (const uri of uris) {
    let isDir = false;
    try {
      isDir = statSync(uri.fsPath).isDirectory();
    } catch {
      // If stat fails, treat as file.
    }
    if (isDir) {
      // Expand folder to all contained files via workspace API.
      try {
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(uri, "**/*"),
          null,
          10000,
        );
        for (const f of found) {
          paths.push(f.fsPath);
        }
      } catch {
        // Fallback: just pass the folder path itself.
        paths.push(uri.fsPath);
      }
    } else {
      paths.push(uri.fsPath);
    }
  }
  return paths;
}
