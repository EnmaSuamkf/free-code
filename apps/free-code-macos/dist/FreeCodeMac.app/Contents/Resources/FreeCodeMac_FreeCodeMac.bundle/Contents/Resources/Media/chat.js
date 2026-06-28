// === MODULE: dom-refs ===
// VS Code API and all DOM element references.

const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById("messages");
const statusEl = document.getElementById("status");
const formEl = document.getElementById("chat-form");
const modeIndicatorBarEl = document.getElementById("mode-indicator-bar");
const modeIndicatorValueEl = document.getElementById("mode-indicator-value");
const inputEl = /** @type {HTMLTextAreaElement|null} */ (
  document.getElementById("input")
);
const fileChipsEl = document.getElementById("file-chips");
const attachButton = document.getElementById("attach");
const exportChatButton = document.getElementById("export-chat");
const agentBrowserToggle = /** @type {HTMLButtonElement|null} */ (
  document.getElementById("agent-browser-toggle")
);
const agentBrowserPanel = document.getElementById("agent-browser-panel");
const agentBrowserUrlInput = /** @type {HTMLInputElement|null} */ (
  document.getElementById("agent-browser-url")
);
const agentBrowserInstructionInput = /** @type {HTMLInputElement|null} */ (
  document.getElementById("agent-browser-instruction")
);
const agentBrowserOpenButton = document.getElementById("agent-browser-open");
const agentBrowserCancelButton = document.getElementById(
  "agent-browser-cancel",
);
const chatNavToggleEl = /** @type {HTMLButtonElement|null} */ (document.getElementById("chat-nav-toggle"));
const chatNavTitleEl = document.getElementById("chat-nav-title");
const chatNavNewEl = document.getElementById("chat-nav-new");
const chatListPanelEl = document.getElementById("chat-list-panel");
const chatListBodyEl = document.getElementById("chat-list-body");
const chatListBackdropEl = document.getElementById("chat-list-backdrop");
const chatListPinBtnEl = /** @type {HTMLButtonElement|null} */ (document.getElementById("chat-list-pin-btn"));
const sendOrStopButton = /** @type {HTMLButtonElement|null} */ (
  document.getElementById("send-or-stop-button")
);
const slashMenuEl = document.getElementById("slash-menu");
const modelIndicatorEl = /** @type {HTMLButtonElement|null} */ (
  document.getElementById("model-indicator")
);
const modelIndicatorLabelEl = document.getElementById("model-indicator-label");
const profileIndicatorEl = /** @type {HTMLButtonElement|null} */ (
  document.getElementById("profile-indicator")
);
const profileIndicatorLabelEl = document.getElementById("profile-indicator-label");
const workspaceIndicatorEl = /** @type {HTMLButtonElement|null} */ (
  document.getElementById("workspace-indicator")
);
const workspaceIndicatorLabelEl = document.getElementById(
  "workspace-indicator-label",
);
const queuePanelEl = document.getElementById("queue-panel");
const queueTextEl = document.getElementById("queue-text");
const queueEditBtn = document.getElementById("queue-edit");
const queueDeleteBtn = document.getElementById("queue-delete");
const terminalPanelEl = document.getElementById("terminal-panel");
const terminalOutputEl = document.getElementById("terminal-output");
const terminalInputEl = /** @type {HTMLInputElement|null} */ (
  document.getElementById("terminal-input")
);
const terminalPopoutBtn = document.getElementById("terminal-popout");
const terminalClearBtn = document.getElementById("terminal-clear");
const terminalCloseBtn = document.getElementById("terminal-close");
const sessionMonitorEl = document.getElementById("session-monitor");
const sessionMonitorCloseBtn = document.getElementById("session-monitor-close");
const sessionCtxBar = document.getElementById("session-ctx-bar");
const sessionCtxText = document.getElementById("session-ctx-text");
const sessionMsgTotal = document.getElementById("session-msg-total");
const sessionToolCalls = document.getElementById("session-tool-calls");
const sessionMcpTools = document.getElementById("session-mcp-tools");
const sessionSkills = document.getElementById("session-skills");
const sessionAgents = document.getElementById("session-agents");

const sessionCtxDetail = document.getElementById("session-ctx-detail");

// === MODULE: state ===
// Global state variables and session activation persistence.


const SESSION_MONITOR_STATS_HOLD_MS = 45000;
const SESSION_MONITOR_LOADING_TEXT =
  "Starting the agent, loading the session, or waiting for user interaction…";

function readMigratedLocalStorage(primaryKey, legacyKey) {
  try {
    const current = localStorage.getItem(primaryKey);
    if (current !== null) return current;
    if (!legacyKey) return null;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy !== null) {
      localStorage.setItem(primaryKey, legacy);
      return legacy;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** After opening Session or Load, keep the wait sheet until message/output token stats look real. */
let sessionMonitorStatsHoldActive = false;
let sessionMonitorStatsHoldDeadline = 0;

/** Whether the agent is currently processing a prompt. */
let isBusy = false;
/** @type {{ text: string, attachments: string[] } | null} */
let queuedMessage = null;

const assistantNodes = new Map();
/**
 * messageId -> `<pre>` body of the thinking `<details>` element.
 * Used by streaming thinking_delta handlers to append text to the right block.
 * @type {Map<string, HTMLElement>}
 */
const thinkingNodes = new Map();
/** @type {Map<string, HTMLElement>} */
const subagentWidgetNodes = new Map();
/** @type {Map<string, Array<ToolEntry>>} */
const pendingToolEntriesByName = new Map();
/** @type {Set<HTMLDetailsElement>} */
const pendingToolRows = new Set();
/** @type {Element[]} */
let lastTurnNodes = [];
/** @type {HTMLDivElement | null} */
let workingIndicatorEl = null;
let workingStartedAt = 0;
let workingLastActivityAt = 0;
let workingStatusText = "";
/** @type {ReturnType<typeof setInterval> | null} */
let workingTimer = null;
const SCROLL_PIN_THRESHOLD_PX = 48;
let isScrollPinnedToBottom = true;

/** @type {{ label: string, slash: string, description: string }[]} */
let slashCommandItems = [];
/** @type {{ label: string, slash: string, description: string }[]} */
let slashSkillItems = [];
/** @type {{ label: string, slash: string, description: string }[]} */
let slashFlatItems = [];
/** @type {Array<{key: string, label: string}>} Tool groups (MCPs, extensions) */
let toolGroups = [];
/** @type {Array<{name: string, tokensEstimated: number}>} Loaded skills */
let loadedSkills = [];
/** @type {Map<string, number>} MCP group keys ever activated → tokensEstimated (cumulative) */
let activatedMcpTokens = new Map();
/** @type {Map<string, number>} Skill names ever activated → tokensEstimated (cumulative) */
let activatedSkillTokens = new Map();
/** @type {Map<string, number>} Agent names ever activated → tokensEstimated (cumulative) */
let activatedAgentTokens = new Map();
/** Current session ID to detect when switching conversations */
let currentSessionId = null;
const SESSION_ACTIVATIONS_KEY = "free-code-session-activations";
const LEGACY_SESSION_ACTIVATIONS_KEY = "edo-session-activations";
/** @type {Map<string, {mcpTokens: Map<string, number>, skillTokens: Map<string, number>, agentTokens: Map<string, number>}>} Per-session activation state */
let sessionActivations = (function () {
  try {
    const raw = readMigratedLocalStorage(SESSION_ACTIVATIONS_KEY, LEGACY_SESSION_ACTIVATIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const map = new Map();
      for (const [id, val] of Object.entries(parsed)) {
        // Support both old format (mcpKeys array) and new format (mcpTokens object)
        const mcpTokens = new Map();
        if (val.mcpTokens && typeof val.mcpTokens === "object") {
          for (const [k, t] of Object.entries(val.mcpTokens)) mcpTokens.set(k, Number(t) || 0);
        } else if (Array.isArray(val.mcpKeys)) {
          for (const k of val.mcpKeys) mcpTokens.set(k, 0);
        }
        const skillTokens = new Map();
        if (val.skillTokens && typeof val.skillTokens === "object") {
          for (const [k, t] of Object.entries(val.skillTokens)) skillTokens.set(k, Number(t) || 0);
        } else if (Array.isArray(val.skillNames)) {
          for (const k of val.skillNames) skillTokens.set(k, 0);
        }
        const agentTokens = new Map();
        if (val.agentTokens && typeof val.agentTokens === "object") {
          for (const [k, t] of Object.entries(val.agentTokens)) agentTokens.set(k, Number(t) || 0);
        }
        map.set(id, { mcpTokens, skillTokens, agentTokens });
      }
      return map;
    }
  } catch (_) {}
  return new Map();
})();

function saveSessionActivations() {
  try {
    const obj = {};
    for (const [id, val] of sessionActivations.entries()) {
      obj[id] = {
        mcpTokens: Object.fromEntries(val.mcpTokens),
        skillTokens: Object.fromEntries(val.skillTokens),
        agentTokens: Object.fromEntries(val.agentTokens),
      };
    }
    if (currentSessionId) {
      obj[currentSessionId] = {
        mcpTokens: Object.fromEntries(activatedMcpTokens),
        skillTokens: Object.fromEntries(activatedSkillTokens),
        agentTokens: Object.fromEntries(activatedAgentTokens),
      };
    }
    writeLocalStorage(SESSION_ACTIVATIONS_KEY, JSON.stringify(obj));
  } catch (_) {}
}
let slashMenuActiveIndex = 0;
/** @type {{ start: number, end: number, query: string } | null} */
let slashMenuContext = null;

/**
 * @type {Map<number, string>}
 * id -> absolute file path for chips attached to the current message.
 */
const attachedFiles = new Map();
let nextFileDropId = 1;
/** Measured height of the empty 3-line textarea; max grow is 2x (100% extra). */
let inputBaseMinH = 0;
let inputManualHeight = 0; // when > 0, user dragged; skip auto-grow

// === MODULE: utils ===
// Zoom, terminal output, file URI conversion, drag-drop collection, clearChips.


const FREE_CODE_ZOOM_CSS_VAR = "--free-code-zoom";
const FREE_CODE_UI_ZOOM_KEY = "free_code_mac_ui_zoom";
const LEGACY_UI_ZOOM_KEY = "edo_mac_ui_zoom";

function getFreeCodeZoom() {
  const raw = document.documentElement.style.getPropertyValue(FREE_CODE_ZOOM_CSS_VAR).trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 1;
}

function setFreeCodeZoom(value) {
  const v = Math.min(2, Math.max(0.6, value));
  document.documentElement.style.setProperty(FREE_CODE_ZOOM_CSS_VAR, String(v));
  writeLocalStorage(FREE_CODE_UI_ZOOM_KEY, String(v));
}

function appendTerminalOutput(text) {
  if (!terminalOutputEl || typeof text !== "string") return;
  const line = document.createElement("div");
  line.className = "terminal-line";
  line.textContent = text.endsWith("\n") ? text.slice(0, -1) : text;
  terminalOutputEl.appendChild(line);
  terminalOutputEl.scrollTop = terminalOutputEl.scrollHeight;
}

function appendTerminalError(text) {
  if (!terminalOutputEl || typeof text !== "string") return;
  const line = document.createElement("div");
  line.className = "terminal-line terminal-line-err";
  line.textContent = text.endsWith("\n") ? text.slice(0, -1) : text;
  terminalOutputEl.appendChild(line);
  terminalOutputEl.scrollTop = terminalOutputEl.scrollHeight;
}

/**
 * @typedef {{
 *   row: HTMLDetailsElement,
 *   toolName: string,
 *   label: HTMLSpanElement,
 *   statusDot: HTMLSpanElement,
 *   resultHost: HTMLDivElement,
 *   hasResult: boolean,
 * }} ToolEntry
 */

/**
 * @param {string} uri
 * @returns {string}
 */
function fileUriToFsPath(uri) {
  const t = uri.trim();
  if (!t) return t;

  // VS Code webview resource URIs (old scheme: vscode-resource:///path,
  // new CDN scheme: https://file+.vscode-resource.vscode-cdn.net/path)
  if (
    t.startsWith("vscode-resource:") ||
    t.startsWith("https://file+.vscode-resource.")
  ) {
    try {
      const u = new URL(t);
      let p = decodeURIComponent(u.pathname);
      // Windows: /C:/path → C:/path
      if (p.length >= 3 && p[0] === "/" && p[2] === ":") p = p.slice(1);
      return p;
    } catch {
      // Fallback: strip scheme + leading slashes
      const stripped = t
        .replace(/^vscode-resource:\/+/, "/")
        .replace(/^https:\/\/[^/]+/, "");
      try {
        return decodeURIComponent(stripped);
      } catch {
        return stripped;
      }
    }
  }

  if (!t.startsWith("file:")) {
    if (t.startsWith("/")) {
      try {
        return decodeURIComponent(t);
      } catch {
        return t;
      }
    }
    return t;
  }
  let pathname;
  try {
    const u = new URL(t);
    pathname = u.pathname;
  } catch {
    return t;
  }
  try {
    pathname = decodeURIComponent(pathname.replace(/\+/g, " "));
  } catch {
    // keep pathname
  }
  if (pathname.length >= 3 && pathname[0] === "/" && pathname[2] === ":") {
    pathname = pathname.slice(1);
  }
  return pathname;
}

/**
 * @param {string} block
 * @param {Set<string>} out
 */
function addPathsFromUriListBlock(block, out) {
  for (const line of block.split(/\r?\n/)) {
    const u = line.trim();
    if (!u || u.startsWith("#")) continue;
    if (
      u.startsWith("file:") ||
      u.startsWith("vscode-resource:") ||
      u.startsWith("https://file+.vscode-resource.")
    ) {
      const p = fileUriToFsPath(u);
      if (p) out.add(p);
    } else if (u[0] === "/" || (u[0] === "~" && u[1] === "/") || u === "~") {
      const p = fileUriToFsPath(u);
      if (p) out.add(p);
    } else if (/^[A-Za-z]:[\\/]/.test(u)) {
      out.add(u);
    }
  }
}

/**
 * @param {DataTransfer} dt
 * @param {Set<string>} out
 */
function collectFilesFromDataTransferItemList(dt, out) {
  if (!dt.items || dt.items.length === 0) return;
  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i];
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) {
        const p = /** @type {{ path?: string }} */ (f).path;
        if (typeof p === "string" && p) out.add(p);
      }
    }
  }
}

/**
 * @param {DataTransfer} dt
 * @param {Set<string>} out
 */
function collectDataTransferGetDataSync(dt, out) {
  if (!dt) return;
  /** @type {string[]} */
  const types = [];
  try {
    if (dt.types) {
      if (Array.from) types.push(...Array.from(dt.types));
    }
  } catch {
    // ignore
  }
  // order matters: Explorer often uses text/uri-list
  const preferred = [
    "text/uri-list",
    "text/plain",
    "text/x-moz-url",
    "resourceurls",
    "vscode-file-urls",
  ];
  for (const t of preferred) {
    try {
      const d = dt.getData(t);
      if (d) addPathsFromUriListBlock(d, out);
    } catch {
      // getData not allowed for this type
    }
  }
  for (const t of types) {
    if (preferred.includes(t)) continue;
    if (!t || !t.startsWith("text/")) continue;
    try {
      const d = dt.getData(t);
      if (d && d.includes("file://")) addPathsFromUriListBlock(d, out);
    } catch {
      // ignore
    }
  }
  if (out.size === 0) {
    try {
      for (const t of types) {
        const d = dt.getData(t);
        if (
          d &&
          (d.startsWith("/") || d.startsWith("~") || /^[A-Za-z]:[\\/]/.test(d))
        ) {
          for (const line of d.split(/\r?\n/)) {
            const s = line.trim();
            if (s && !s.startsWith("#")) {
              if (s.startsWith("file:")) out.add(fileUriToFsPath(s));
              else if (
                s[0] === "/" ||
                s[0] === "~" ||
                /^[A-Za-z]:[\\/]/.test(s)
              )
                out.add(s);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

/**
 * @param {DataTransfer} dt
 * @param {Set<string>} out
 */
function collectDataTransferFileListSync(dt, out) {
  if (!dt.files || dt.files.length === 0) return;
  for (let i = 0; i < dt.files.length; i++) {
    const f = /** @type {{ path?: string }} */ (dt.files[i]);
    if (typeof f.path === "string" && f.path) out.add(f.path);
  }
}

/**
 * @param {DataTransfer} dt
 * @returns {Promise<string[]>}
 */
function collectDropPathsFromDataTransferAsync(dt) {
  /** @type {Set<string>} */
  const out = new Set();
  collectDataTransferGetDataSync(dt, out);
  collectDataTransferFileListSync(dt, out);
  collectFilesFromDataTransferItemList(dt, out);
  if (out.size > 0) return Promise.resolve([...out]);

  /** @type {Promise<string>[]} */
  const stringJobs = [];
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind !== "string") continue;
      stringJobs.push(
        new Promise((resolve) => {
          try {
            item.getAsString((s) => resolve(s || ""));
          } catch {
            resolve("");
          }
        }),
      );
    }
  }
  if (stringJobs.length === 0) {
    return Promise.resolve([]);
  }
  return Promise.all(stringJobs).then((chunks) => {
    for (const c of chunks) {
      if (c) addPathsFromUriListBlock(c, out);
    }
    return [...out].filter((p) => p.length > 0);
  });
}

/**
 * Remove all visual chips and clear the attached files map.
 */
function clearChips() {
  attachedFiles.clear();
  if (fileChipsEl) {
    fileChipsEl.textContent = "";
    fileChipsEl.hidden = true;
  }
}

// === MODULE: slash-menu ===
// Slash command autocomplete: context detection, filtering, rendering, selection.


/**
 * @param {string} value
 * @param {number} cursor
 * @returns {{ start: number, end: number, query: string } | null}
 */
function getSlashContext(value, cursor) {
  const before = value.slice(0, cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const col = before.slice(lineStart);
  const leftTrimmed = col.trimStart();
  if (!leftTrimmed.startsWith("/")) return null;
  const slashIdx = col.length - leftTrimmed.length;
  const token = col.slice(slashIdx);
  return {
    start: lineStart + slashIdx,
    end: cursor,
    query: token.slice(1).toLowerCase(),
  };
}

/**
 * @param {string} query
 */
function getFilteredSlashItems(query) {
  const q = (query || "").toLowerCase();
  const spaceIdx = q.indexOf(" ");
  if (spaceIdx !== -1) {
    const commandName = q.slice(0, spaceIdx).trim();
    const argumentPrefix = q.slice(spaceIdx + 1).trimStart();
    if (!commandName) return { commands: [], skills: [] };
    const baseSlash = `/${commandName}`;
    const baseCommand = slashCommandItems.find(
      (item) => item.slash.toLowerCase() === baseSlash,
    );
    if (!baseCommand) return { commands: [], skills: [] };
    const derived = deriveSubcommandsFromDescription(baseCommand);
    const argScore = (item) => {
      const full = item.slash.toLowerCase();
      const basePrefix = `${baseSlash} `;
      if (!full.startsWith(basePrefix)) return Number.POSITIVE_INFINITY;
      const suffix = full.slice(basePrefix.length);
      if (!argumentPrefix) return 0;
      if (suffix.startsWith(argumentPrefix)) return 1;
      if (suffix.includes(argumentPrefix)) return 2;
      if (
        item.description &&
        item.description.toLowerCase().includes(argumentPrefix)
      )
        return 3;
      return Number.POSITIVE_INFINITY;
    };
    const commands = derived
      .map((item) => ({ item, score: argScore(item) }))
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) =>
        a.score !== b.score
          ? a.score - b.score
          : a.item.slash.localeCompare(b.item.slash),
      )
      .map((row) => row.item);
    return { commands, skills: [] };
  }
  const score = (item) => {
    if (!q) return 0;
    const rest = item.slash.slice(1).toLowerCase();
    if (rest.startsWith(`${q} `)) return 0;
    if (rest.startsWith(q)) return 1;
    if (rest === q) return 2;
    if (
      rest.includes(q) ||
      (item.description && item.description.toLowerCase().includes(q))
    )
      return 3;
    return Number.POSITIVE_INFINITY;
  };
  const filter = (items) => {
    const matched = items
      .map((it) => ({ it, s: score(it) }))
      .filter((row) => Number.isFinite(row.s));
    if (!q) return matched.map((row) => row.it);
    matched.sort((a, b) => {
      if (a.s !== b.s) return a.s - b.s;
      return a.it.slash.localeCompare(b.it.slash);
    });
    return matched.map((row) => row.it);
  };
  return {
    commands: filter(slashCommandItems),
    skills: filter(slashSkillItems),
  };
}

/**
 * @param {{ label: string, slash: string, description: string }} item
 * @returns {{ label: string, slash: string, description: string }[]}
 */
function deriveSubcommandsFromDescription(item) {
  if (!item || typeof item.slash !== "string" || item.slash[0] !== "/")
    return [];
  const desc = typeof item.description === "string" ? item.description : "";
  if (!desc || desc.indexOf("|") === -1) return [];
  const base = item.slash.trim();
  const fragments = desc
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  /** @type {{ label: string, slash: string, description: string }[]} */
  const out = [];
  for (const fragment of fragments) {
    let candidate = fragment.replace(/^[\u2022\-*]\s*/, "").trim();
    if (!candidate) continue;
    const colonIdx = candidate.indexOf(":");
    if (colonIdx !== -1 && candidate.slice(0, colonIdx).indexOf("/") === -1) {
      candidate = candidate.slice(colonIdx + 1).trim();
    }
    if (!candidate) continue;
    candidate = candidate.split(/\.\s/)[0].trim();
    if (!candidate) continue;
    const placeholderHint = /<[^>]+>|\[[^\]]+\]/.test(candidate);
    if (candidate.startsWith("/")) {
      const m = candidate.match(
        /^\/[a-z0-9:_-]+(?:\s+[a-z0-9:_-]+)?(?:\s*(?:<[^>]+>|\[[^\]]+\]))?/i,
      );
      if (!m) continue;
      candidate = m[0].trim();
    } else {
      const m = candidate.match(/^[a-z0-9:_-]+(?:\s*(?:<[^>]+>|\[[^\]]+\]))?/i);
      if (!m) continue;
      candidate = `${base} ${m[0].trim()}`;
    }
    if (!candidate.startsWith(`${base} `)) continue;
    let clean = candidate
      .replace(/\s*(<[^>]+>|\[[^\]]+\])/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean || clean === base) continue;
    const slash = placeholderHint ? `${clean} ` : clean;
    out.push({
      slash,
      label: clean,
      description: `Subcommand of ${base}`,
    });
  }
  return out;
}

function hideSlashMenu() {
  slashMenuContext = null;
  if (slashMenuEl) {
    slashMenuEl.hidden = true;
    slashMenuEl.textContent = "";
  }
  slashFlatItems = [];
}

/**
 * @param {{ label: string, slash: string, description: string }} item
 * @param {number} index
 */
function createSlashItemButton(item, index) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "slash-menu-item";
  btn.dataset.index = String(index);
  const lab = document.createElement("span");
  lab.className = "slash-menu-label";
  lab.textContent = item.label;
  btn.appendChild(lab);
  if (item.description) {
    const d = document.createElement("div");
    d.className = "slash-menu-desc";
    d.textContent = item.description;
    btn.appendChild(d);
  }
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applySlashAtIndex(index);
  });
  return btn;
}

function updateSlashActiveClass() {
  if (!slashMenuEl) return;
  const buttons = slashMenuEl.querySelectorAll(".slash-menu-item");
  buttons.forEach((btn, i) => {
    btn.classList.toggle("slash-menu-item-active", i === slashMenuActiveIndex);
  });
  const active = buttons[slashMenuActiveIndex];
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest" });
  }
}

function renderSlashMenu() {
  if (!slashMenuEl || !slashMenuContext) return;
  const { query } = slashMenuContext;
  const { commands, skills } = getFilteredSlashItems(query);
  slashFlatItems = [];
  slashMenuEl.textContent = "";
  if (commands.length === 0 && skills.length === 0) {
    slashMenuEl.hidden = true;
    return;
  }
  if (commands.length > 0) {
    const h = document.createElement("div");
    h.className = "slash-menu-heading";
    h.textContent = "Commands";
    slashMenuEl.appendChild(h);
    for (const it of commands) {
      const idx = slashFlatItems.length;
      slashFlatItems.push(it);
      slashMenuEl.appendChild(createSlashItemButton(it, idx));
    }
  }
  if (skills.length > 0) {
    const h = document.createElement("div");
    h.className = "slash-menu-heading";
    h.textContent = "Skills";
    slashMenuEl.appendChild(h);
    for (const it of skills) {
      const idx = slashFlatItems.length;
      slashFlatItems.push(it);
      slashMenuEl.appendChild(createSlashItemButton(it, idx));
    }
  }
  slashMenuActiveIndex = Math.min(
    Math.max(0, slashMenuActiveIndex),
    slashFlatItems.length - 1,
  );
  updateSlashActiveClass();
  slashMenuEl.hidden = false;
}

/**
 * @param {number} index
 */
function applySlashAtIndex(index) {
  const it = slashFlatItems[index];
  if (!it || !inputEl || !slashMenuContext) return;
  const before = inputEl.value.slice(0, slashMenuContext.start);
  const after = inputEl.value.slice(slashMenuContext.end);
  const insertion = it.slash;
  inputEl.value = before + insertion + after;
  const pos = before.length + insertion.length;
  inputEl.setSelectionRange(pos, pos);
  hideSlashMenu();
  syncInputHeight();
}

function updateSlashMenuFromInput() {
  if (!inputEl || !slashMenuEl) return;
  const v = inputEl.value;
  const c = inputEl.selectionStart ?? v.length;
  const ctx = getSlashContext(v, c);
  if (!ctx) {
    hideSlashMenu();
    return;
  }
  const queryChanged =
    !slashMenuContext || ctx.query !== slashMenuContext.query;
  slashMenuContext = ctx;
  if (slashCommandItems.length === 0 && slashSkillItems.length === 0) {
    vscode.postMessage({ type: "request_slash_commands" });
  }
  if (queryChanged) {
    slashMenuActiveIndex = 0;
  }
  renderSlashMenu();
}

// === MODULE: input ===
// Textarea auto-resize, file chip insertion, agent browser panel.

/**
 * Base height = empty textarea with `rows=3` (one-time measure).
 * Grows with content up to 200% of that height (100% extra); then scrolls inside.
 */
function ensureInputBaseMinH() {
  if (!inputEl || inputBaseMinH > 0) return;
  const el = inputEl;
  const prevH = el.style.height;
  el.style.height = "";
  const v = el.value;
  el.value = "";
  void el.offsetHeight;
  inputBaseMinH = el.offsetHeight;
  el.value = v;
  el.style.height = prevH;
}

/**
 * @returns {void}
 */
function syncInputHeight() {
  if (!inputEl) return;
  // If user manually resized via drag, honour that height and skip auto-grow
  if (inputManualHeight > 0) {
    inputEl.style.height = `${inputManualHeight}px`;
    inputEl.style.overflowY = "auto";
    return;
  }
  ensureInputBaseMinH();
  const minH = inputBaseMinH;
  if (minH <= 0) return;
  const maxH = minH * 2;
  const el = inputEl;
  // Save scroll position so collapsing to 0px doesn't cause visible jank
  const savedScroll = messagesEl ? messagesEl.scrollTop : 0;
  const wasPinned = isScrollPinnedToBottom;
  el.style.height = "0px";
  const scrollH = el.scrollHeight;
  const h = Math.min(Math.max(scrollH, minH), maxH);
  el.style.height = `${h}px`;
  el.style.overflowY = scrollH > maxH ? "auto" : "hidden";
  // Restore scroll position to prevent jitter when typing
  if (messagesEl) {
    if (wasPinned) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      messagesEl.scrollTop = savedScroll;
    }
  }
}

/**
 * Insert or replace the current selection in the textarea. Uses `setRangeText` so
 * the change is merged into the browser's undo history (unlike assigning `.value`).
 * @param {string} text
 */
function insertTextInTextarea(text) {
  if (!inputEl) return;
  const el = inputEl;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (typeof el.setRangeText === "function") {
    el.setRangeText(text, start, end, "end");
  } else {
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * @param {string[]} paths
 */
function insertChipsForPaths(paths) {
  if (paths.length === 0) return;
  for (const p of paths) {
    const id = nextFileDropId++;
    const base = p.split(/[/\\]/).pop() || p;
    attachedFiles.set(id, p);

    if (fileChipsEl) {
      const chip = document.createElement("span");
      chip.className = "file-chip";
      chip.dataset.fileId = String(id);
      chip.title = p;

      const nameEl = document.createElement("span");
      nameEl.className = "file-chip-name";
      nameEl.textContent = base;

      const removeEl = document.createElement("button");
      removeEl.type = "button";
      removeEl.className = "file-chip-remove";
      removeEl.textContent = "\u00d7";
      removeEl.setAttribute("aria-label", `Remove ${base}`);
      removeEl.addEventListener("click", (e) => {
        e.stopPropagation();
        attachedFiles.delete(id);
        chip.remove();
        if (fileChipsEl.childElementCount === 0) fileChipsEl.hidden = true;
      });

      chip.appendChild(nameEl);
      chip.appendChild(removeEl);

      chip.addEventListener("click", () => {
        vscode.postMessage({ type: "open_file", path: p });
      });

      fileChipsEl.appendChild(chip);
      fileChipsEl.hidden = false;
    }
  }
  inputEl?.focus();
}

function showAgentBrowserPanel() {
  if (!agentBrowserPanel) return;
  agentBrowserPanel.hidden = false;
  agentBrowserUrlInput?.focus();
}

function hideAgentBrowserPanel() {
  if (!agentBrowserPanel) return;
  agentBrowserPanel.hidden = true;
  if (agentBrowserUrlInput) agentBrowserUrlInput.value = "";
  if (agentBrowserInstructionInput) agentBrowserInstructionInput.value = "";
  inputEl?.focus();
}

function submitAgentBrowserOpen() {
  const url = agentBrowserUrlInput?.value.trim() || "";
  const instruction = agentBrowserInstructionInput?.value.trim() || "";
  if (isBusy) {
    setWorkingStatus("Wait for current turn before opening visible browser", {
      markActivity: false,
    });
    return;
  }
  if (!url) {
    agentBrowserUrlInput?.focus();
    return;
  }
  hideAgentBrowserPanel();
  vscode.postMessage({ type: "open_agent_browser", url, instruction });
}

// === MODULE: pickers ===
// Tool, skill, model, and agent picker modals.

/**
 * @param {Record<string, unknown>} state
 */
function openToolPicker(state) {
  const modal = document.getElementById("tool-picker-modal");
  const body = document.getElementById("tool-picker-body");
  if (!modal || !body) return;
  body.textContent = "";
  const groups = Array.isArray(state.groups) ? state.groups : [];
  // Store tool groups globally for session monitor
  toolGroups = groups;
  // Seed activatedMcpTokens with any groups already enabled (e.g. after reloading)
  let mcpSeeded = false;
  for (const g of groups) {
    if (g && typeof g === "object") {
      const o = /** @type {Record<string, unknown>} */ (g);
      if (o.enabled === true && typeof o.key === "string" && o.key) {
        const tok = typeof o.tokensEstimated === "number" ? o.tokensEstimated : 0;
        activatedMcpTokens.set(o.key, tok);
        mcpSeeded = true;
      }
    }
  }
  if (mcpSeeded) saveSessionActivations();
  if (groups.length === 0) {
    const p = document.createElement("p");
    p.className = "tool-picker-hint tool-picker-empty";
    p.textContent =
      "No optional tool groups in this session (e.g. embedded agent with --no-extensions). See /tools.";
    body.appendChild(p);
  }
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (g);
    const key = typeof o.key === "string" ? o.key : "";
    const row = document.createElement("label");
    row.className = "tool-picker-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = o.enabled === true;
    cb.dataset.groupKey = key;
    const span = document.createElement("span");
    const tc = typeof o.toolCount === "number" ? o.toolCount : 0;
    const te = typeof o.tokensEstimated === "number" ? o.tokensEstimated : 0;
    span.textContent = `${key} (${tc} tools, ~${te} tok est.)`;
    row.appendChild(cb);
    row.appendChild(span);
    body.appendChild(row);
  }
  ensureToolPickerGlobalHandlers();
  modal.style.display = "flex";
  modal.hidden = false;
}

function closeToolPicker() {
  const modal = document.getElementById("tool-picker-modal");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
}

/**
 * Skill picker modal (RPC get_skill_picker_state / set_skill_picker), same styling as tool groups.
 * @param {Record<string, unknown>} state
 */
function openSkillPicker(state) {
  const modal = document.getElementById("skill-picker-modal");
  const hintEl = document.getElementById("skill-picker-hint");
  const body = document.getElementById("skill-picker-body");
  if (!modal || !body) return;
  body.textContent = "";
  const hint =
    state &&
    typeof state === "object" &&
    typeof (/** @type {Record<string, unknown>} */ (state).hint) === "string"
      ? String(/** @type {Record<string, unknown>} */ (state).hint)
      : "Skills merged into the system prompt. Toggle entries to omit skill XML blocks from prompts sent to the model.";
  if (hintEl) hintEl.textContent = hint;
  const skills = Array.isArray(state.skills) ? state.skills : [];
  // Store skills globally for session monitor
  loadedSkills = skills;
  // Seed activatedSkillTokens with any skills already enabled (e.g. after reloading)
  let skillSeeded = false;
  for (const raw of skills) {
    if (raw && typeof raw === "object") {
      const s = /** @type {Record<string, unknown>} */ (raw);
      if (s.enabled === true && typeof s.name === "string" && s.name) {
        const tok = typeof s.tokensEstimated === "number" ? s.tokensEstimated : 0;
        activatedSkillTokens.set(s.name, tok);
        skillSeeded = true;
      }
    }
  }
  if (skillSeeded) saveSessionActivations();
  if (skills.length === 0) {
    const p = document.createElement("p");
    p.className = "tool-picker-hint tool-picker-empty";
    p.textContent = "No skills in this session system prompt.";
    body.appendChild(p);
  }
  for (const raw of skills) {
    if (!raw || typeof raw !== "object") continue;
    const s = /** @type {Record<string, unknown>} */ (raw);
    const name = typeof s.name === "string" ? s.name : "";
    if (!name) continue;
    const desc = typeof s.description === "string" ? s.description : "";
    const tok =
      typeof s.tokensEstimated === "number" && !Number.isNaN(s.tokensEstimated)
        ? s.tokensEstimated
        : 0;
    const row = document.createElement("label");
    row.className = "tool-picker-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s.enabled === true;
    cb.dataset.skillName = name;
    const span = document.createElement("span");
    const line =
      desc.length > 0
        ? `${name} (~${tok} tok est.) \u2014 ${desc}`
        : `${name} (~${tok} tok est.)`;
    span.textContent = line.length > 220 ? `${line.slice(0, 217)}\u2026` : line;
    if (line.length > 220) row.title = line;
    row.appendChild(cb);
    row.appendChild(span);
    body.appendChild(row);
  }
  ensureSkillPickerGlobalHandlers();
  modal.style.display = "flex";
  modal.hidden = false;
}

/**
 * Single-select model picker. Mirrors the CLI `/model` selector: a list of
 * `<id> [provider]` rows with a ✓ on the currently active model, plus a
 * filter input that matches against id, provider, and name. Click a row or
 * hit Enter on the highlighted row to apply (sends `model_picker_apply`).
 * @typedef {{ id: string, name: string, provider: string }} ModelInfo
 */

/** @type {ModelInfo[]} */
let modelPickerAll = [];
/** @type {ModelInfo[]} */
let modelPickerFiltered = [];
let modelPickerActiveIndex = 0;
/** @type {{ provider: string, id: string } | null} */
let modelPickerCurrent = null;

/**
 * @param {Record<string, unknown>} state shape: { models: ModelInfo[], current?: { provider, id } }
 */
function openModelPicker(state) {
  const modal = document.getElementById("model-picker-modal");
  const body = document.getElementById("model-picker-body");
  const search = /** @type {HTMLInputElement|null} */ (
    document.getElementById("model-picker-search")
  );
  if (!modal || !body) return;
  const rawModels = Array.isArray(state.models) ? state.models : [];
  /** @type {ModelInfo[]} */
  const models = [];
  for (const m of rawModels) {
    if (!m || typeof m !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (m);
    const id = typeof o.id === "string" ? o.id : "";
    const provider = typeof o.provider === "string" ? o.provider : "";
    const name = typeof o.name === "string" ? o.name : id;
    if (!id || !provider) continue;
    models.push({ id, name, provider });
  }
  const cur =
    state.current && typeof state.current === "object"
      ? /** @type {Record<string, unknown>} */ (state.current)
      : null;
  modelPickerCurrent =
    cur && typeof cur.provider === "string" && typeof cur.id === "string"
      ? { provider: cur.provider, id: cur.id }
      : null;
  models.sort((a, b) => {
    const aCur =
      modelPickerCurrent &&
      a.provider === modelPickerCurrent.provider &&
      a.id === modelPickerCurrent.id;
    const bCur =
      modelPickerCurrent &&
      b.provider === modelPickerCurrent.provider &&
      b.id === modelPickerCurrent.id;
    if (aCur && !bCur) return -1;
    if (!aCur && bCur) return 1;
    const byProv = a.provider.localeCompare(b.provider);
    if (byProv !== 0) return byProv;
    return a.id.localeCompare(b.id);
  });
  modelPickerAll = models;
  modelPickerFiltered = models;
  modelPickerActiveIndex = 0;
  if (search) search.value = "";
  renderModelPickerList();
  ensureModelPickerGlobalHandlers();
  modal.style.display = "flex";
  modal.hidden = false;
  if (search) {
    setTimeout(() => search.focus(), 0);
  }
}

function closeModelPicker() {
  const modal = document.getElementById("model-picker-modal");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
}

/**
 * @param {string} query
 */
function filterModelPicker(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    modelPickerFiltered = modelPickerAll;
  } else {
    modelPickerFiltered = modelPickerAll.filter((m) => {
      const hay =
        `${m.id} ${m.provider} ${m.provider}/${m.id} ${m.name}`.toLowerCase();
      return hay.includes(q);
    });
  }
  modelPickerActiveIndex = 0;
  renderModelPickerList();
}

function renderModelPickerList() {
  const body = document.getElementById("model-picker-body");
  const currentEl = document.getElementById("model-picker-current");
  if (!body) return;
  body.textContent = "";
  if (modelPickerFiltered.length === 0) {
    const p = document.createElement("p");
    p.className = "tool-picker-hint tool-picker-empty";
    p.textContent = "No matching models.";
    body.appendChild(p);
    if (currentEl) currentEl.textContent = "";
    return;
  }
  for (let i = 0; i < modelPickerFiltered.length; i++) {
    const m = modelPickerFiltered[i];
    const isCurrent =
      !!modelPickerCurrent &&
      m.provider === modelPickerCurrent.provider &&
      m.id === modelPickerCurrent.id;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "model-picker-row";
    if (i === modelPickerActiveIndex)
      row.classList.add("model-picker-row-active");
    if (isCurrent) row.classList.add("model-picker-row-current");
    row.dataset.index = String(i);
    const idSpan = document.createElement("span");
    idSpan.className = "model-picker-id";
    idSpan.textContent = m.id;
    row.appendChild(idSpan);
    const provSpan = document.createElement("span");
    provSpan.className = "model-picker-provider";
    provSpan.textContent = `[${m.provider}]`;
    row.appendChild(provSpan);
    if (isCurrent) {
      const check = document.createElement("span");
      check.className = "model-picker-check";
      check.textContent = "\u2713";
      row.appendChild(check);
    }
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      modelPickerActiveIndex = i;
      applyModelPickerSelection();
    });
    row.addEventListener("mouseenter", () => {
      modelPickerActiveIndex = i;
      updateModelPickerActiveClass();
      updateModelPickerCurrentLabel();
    });
    body.appendChild(row);
  }
  updateModelPickerCurrentLabel();
}

function updateModelPickerActiveClass() {
  const body = document.getElementById("model-picker-body");
  if (!body) return;
  const rows = body.querySelectorAll(".model-picker-row");
  rows.forEach((row, i) => {
    row.classList.toggle(
      "model-picker-row-active",
      i === modelPickerActiveIndex,
    );
  });
  const active = rows[modelPickerActiveIndex];
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest" });
  }
}

function updateModelPickerCurrentLabel() {
  const currentEl = document.getElementById("model-picker-current");
  if (!currentEl) return;
  const sel = modelPickerFiltered[modelPickerActiveIndex];
  if (!sel) {
    currentEl.textContent = "";
    return;
  }
  currentEl.textContent = `Model Name: ${sel.name}`;
}

function applyModelPickerSelection() {
  const sel = modelPickerFiltered[modelPickerActiveIndex];
  if (!sel) return;
  closeModelPicker();
  vscode.postMessage({
    type: "model_picker_apply",
    provider: sel.provider,
    modelId: sel.id,
  });
}

let modelPickerGlobalHandlersBound = false;
function ensureModelPickerGlobalHandlers() {
  if (modelPickerGlobalHandlersBound) return;
  modelPickerGlobalHandlersBound = true;
  const modal = document.getElementById("model-picker-modal");
  const search = /** @type {HTMLInputElement|null} */ (
    document.getElementById("model-picker-search")
  );
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeModelPicker();
        vscode.postMessage({ type: "model_picker_cancel" });
      }
    });
  }
  if (search) {
    search.addEventListener("input", () => {
      filterModelPicker(search.value);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (modelPickerFiltered.length === 0) return;
        modelPickerActiveIndex = Math.min(
          modelPickerActiveIndex + 1,
          modelPickerFiltered.length - 1,
        );
        updateModelPickerActiveClass();
        updateModelPickerCurrentLabel();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (modelPickerFiltered.length === 0) return;
        modelPickerActiveIndex = Math.max(modelPickerActiveIndex - 1, 0);
        updateModelPickerActiveClass();
        updateModelPickerCurrentLabel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        applyModelPickerSelection();
        return;
      }
    });
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const m = document.getElementById("model-picker-modal");
      if (!m || m.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      closeModelPicker();
      vscode.postMessage({ type: "model_picker_cancel" });
    },
    true,
  );
}

function closeSkillPicker() {
  const modal = document.getElementById("skill-picker-modal");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
}

/** @param {Record<string, unknown>} state */
function openAgentPicker(state) {
  const modal = document.getElementById("agent-picker-modal");
  const body = document.getElementById("agent-picker-body");
  if (!modal || !body) return;
  body.textContent = "";
  const agents = Array.isArray(state.agents) ? state.agents : [];
  // Seed activatedAgentTokens with enabled agents
  let agentSeeded = false;
  for (const raw of agents) {
    if (raw && typeof raw === "object") {
      const a = /** @type {Record<string, unknown>} */ (raw);
      if (a.enabled === true && typeof a.name === "string" && a.name) {
        const tok = typeof a.tokensEstimated === "number" ? a.tokensEstimated : 0;
        activatedAgentTokens.set(a.name, tok);
        agentSeeded = true;
      }
    }
  }
  if (agentSeeded) saveSessionActivations();
  if (agents.length === 0) {
    const p = document.createElement("p");
    p.className = "tool-picker-hint tool-picker-empty";
    p.textContent = "No agents found in ~/.free-code/agents/.";
    body.appendChild(p);
  }
  for (const raw of agents) {
    if (!raw || typeof raw !== "object") continue;
    const a = /** @type {Record<string, unknown>} */ (raw);
    const name = typeof a.name === "string" ? a.name : "";
    if (!name) continue;
    const desc = typeof a.description === "string" ? a.description : "";
    const tok = typeof a.tokensEstimated === "number" && !Number.isNaN(a.tokensEstimated) ? a.tokensEstimated : 0;
    const row = document.createElement("label");
    row.className = "tool-picker-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = a.enabled === true;
    cb.dataset.agentName = name;
    const span = document.createElement("span");
    const line = desc.length > 0 ? `${name} (~${tok} tok est.) — ${desc}` : `${name} (~${tok} tok est.)`;
    span.textContent = line.length > 220 ? `${line.slice(0, 217)}…` : line;
    if (line.length > 220) row.title = line;
    row.appendChild(cb);
    row.appendChild(span);
    body.appendChild(row);
  }
  ensureAgentPickerGlobalHandlers();
  modal.style.display = "flex";
  modal.hidden = false;
}

function closeAgentPicker() {
  const modal = document.getElementById("agent-picker-modal");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
}

let agentPickerGlobalHandlersBound = false;
function ensureAgentPickerGlobalHandlers() {
  if (agentPickerGlobalHandlersBound) return;
  agentPickerGlobalHandlersBound = true;
  const modal = document.getElementById("agent-picker-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeAgentPicker();
        vscode.postMessage({ type: "agent_picker_cancel" });
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const m = document.getElementById("agent-picker-modal");
    if (!m || m.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    closeAgentPicker();
    vscode.postMessage({ type: "agent_picker_cancel" });
  });
}

let skillPickerGlobalHandlersBound = false;
function ensureSkillPickerGlobalHandlers() {
  if (skillPickerGlobalHandlersBound) return;
  skillPickerGlobalHandlersBound = true;
  const modal = document.getElementById("skill-picker-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeSkillPicker();
        vscode.postMessage({ type: "skill_picker_cancel" });
      }
    });
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const m = document.getElementById("skill-picker-modal");
      if (!m || m.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      closeSkillPicker();
      vscode.postMessage({ type: "skill_picker_cancel" });
    },
    true,
  );
}

let toolPickerGlobalHandlersBound = false;
function ensureToolPickerGlobalHandlers() {
  if (toolPickerGlobalHandlersBound) return;
  toolPickerGlobalHandlersBound = true;
  const modal = document.getElementById("tool-picker-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeToolPicker();
        vscode.postMessage({ type: "tool_picker_cancel" });
      }
    });
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const m = document.getElementById("tool-picker-modal");
      if (!m || m.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      closeToolPicker();
      vscode.postMessage({ type: "tool_picker_cancel" });
    },
    true,
  );
}

// === MODULE: working ===
// Queue, scroll pinning, working indicator, setBusy, commitChatInput.

/**
 * @param {{ text: string, attachments: string[] } | null} msg
 */
function setQueuedMessage(msg) {
  queuedMessage = msg;
  if (!queuePanelEl || !queueTextEl) return;
  if (msg) {
    const preview =
      msg.text ||
      (msg.attachments.length > 0 ? `[${msg.attachments.length} file(s)]` : "");
    queueTextEl.textContent = preview;
    queuePanelEl.hidden = false;
  } else {
    queuePanelEl.hidden = true;
  }
}

function isMessagesScrolledNearBottom() {
  const distance =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  return distance <= SCROLL_PIN_THRESHOLD_PX;
}

function scrollMessagesToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  isScrollPinnedToBottom = true;
}

function scrollMessagesAfterContentChange() {
  if (isScrollPinnedToBottom) scrollMessagesToBottom();
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function ensureWorkingIndicator() {
  if (!workingIndicatorEl) {
    workingIndicatorEl = document.createElement("div");
    workingIndicatorEl.className = "message working";
  }
  messagesEl.appendChild(workingIndicatorEl);
}

function renderWorkingIndicator() {
  if (!workingStartedAt || !workingIndicatorEl) return;
  const now = Date.now();
  const elapsed = formatElapsed(now - workingStartedAt);
  const idle = formatElapsed(now - workingLastActivityAt);
  const label = workingStatusText || "Working";
  workingIndicatorEl.textContent = `Agent working: ${label} (${elapsed}, updated ${idle} ago)`;
  scrollMessagesAfterContentChange();
}

/**
 * @param {string} text
 * @param {{ markActivity?: boolean }} [options]
 */
function setWorkingStatus(text, options = {}) {
  if (!workingStartedAt) {
    workingStartedAt = Date.now();
    workingLastActivityAt = workingStartedAt;
  }
  if (options.markActivity !== false) {
    workingLastActivityAt = Date.now();
  }
  workingStatusText = text || "Working";
  ensureWorkingIndicator();
  renderWorkingIndicator();
  if (!workingTimer) {
    workingTimer = setInterval(renderWorkingIndicator, 1000);
  }
}

function stopWorkingStatus() {
  if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = null;
  }
  workingStartedAt = 0;
  workingLastActivityAt = 0;
  workingStatusText = "";
  if (workingIndicatorEl) {
    workingIndicatorEl.remove();
    workingIndicatorEl = null;
  }
  statusEl.textContent = "";
}

function abortAgent() {
  setQueuedMessage(null);
  if (isBusy) setWorkingStatus("Cancelling");
  vscode.postMessage({ type: "abort" });
}

/**
 * Send message or queue while agent is busy (Enter uses this path).
 */
function commitChatInput() {
  if (!inputEl) return;
  const rawText = inputEl.value.trim();
  const attachments = [...attachedFiles.values()].filter(
    (p) => typeof p === "string" && p.length > 0,
  );
  if (!rawText && attachments.length === 0) return;
  if (isBusy) {
    setQueuedMessage({ text: rawText, attachments });
    inputEl.value = "";
    clearChips();
    syncInputHeight();
    return;
  }
  vscode.postMessage({ type: "prompt", text: rawText, attachments });
  inputEl.value = "";
  clearChips();
  inputEl.focus();
  syncInputHeight();
}

function syncSendOrStopButton() {
  if (!sendOrStopButton) return;
  const icon = sendOrStopButton.querySelector(".chat-actions-send-icon");
  if (isBusy) {
    sendOrStopButton.classList.add("chat-actions-send--stop");
    sendOrStopButton.title = "Stop generating (Escape)";
    sendOrStopButton.setAttribute("aria-label", "Stop generating");
    if (icon) icon.textContent = "\u25FC";
  } else {
    sendOrStopButton.classList.remove("chat-actions-send--stop");
    sendOrStopButton.title = "Send (Enter)";
    sendOrStopButton.setAttribute("aria-label", "Send");
    if (icon) icon.textContent = "\u2191";
  }
}

/**
 * @param {boolean} busy
 * @param {{ showWorking?: boolean }} [options]
 */
function setBusy(busy, options = {}) {
  isBusy = busy;
  if (busy) {
    if (options.showWorking === false) {
      document.body.classList.remove("busy");
      stopWorkingStatus();
    } else {
      document.body.classList.add("busy");
      setWorkingStatus(workingStatusText || "Working");
    }
  } else {
    document.body.classList.remove("busy");
    stopWorkingStatus();
    inputEl?.focus();
    syncInputHeight();
    if (queuedMessage) {
      const msg = queuedMessage;
      setQueuedMessage(null);
      vscode.postMessage({
        type: "prompt",
        text: msg.text,
        attachments: msg.attachments,
      });
    }
  }
  syncSendOrStopButton();
}


// === MODULE: messages ===
// Render user, assistant, thinking, subagent messages into the chat.

function clearMessages() {
  messagesEl.innerHTML =
    '<div id="empty-hint">Use /pick-tools to choose which MCPs and extensions are active in this session.</div>';
  assistantNodes.clear();
  thinkingNodes.clear();
  subagentWidgetNodes.clear();
  pendingToolEntriesByName.clear();
  pendingToolRows.clear();
}

/**
 * Append a thinking `<details>` block and return its streaming body. Defaults to
 * **open** so the user sees the model's reasoning live while it streams (useful
 * to debug long / failing turns where the final answer never arrives). When the
 * assistant's final-answer text starts streaming, any still-open thinking blocks
 * for the current turn are collapsed automatically (see `assistant_message_start`
 * handler) so the conversation stays focused on the answer afterwards.
 *
 * History restore (`restore_history`) passes `open=false` so re-rendered past
 * thinking blocks land collapsed — the user has already seen them stream, and
 * keeping them collapsed matches the post-collapse state from the live turn.
 *
 * @param {string} messageId
 * @param {boolean} [open]
 * @returns {HTMLElement}
 */
function addThinkingBlock(messageId, open = true) {
  const details = /** @type {HTMLDetailsElement} */ (
    document.createElement("details")
  );
  details.className = "message thinking";
  details.open = open;
  const summary = document.createElement("summary");
  summary.className = "thinking-summary";
  summary.textContent = "Thinking";
  // Clicking a <summary> toggles <details> and parks focus on the <summary>. In this
  // webview that steals focus from the chat input: the next Cmd+V / keystroke is
  // routed to the summary (or, in VS Code, to whatever editor had focus before the
  // webview), so paste "lands in the wrong place". Refocus the input on mousedown.
  // Keyboard navigation (Tab → Enter/Space) triggers `keydown`, not `mousedown`, so
  // users tabbing through the chat can still land on the summary to expand it.
  summary.addEventListener("mousedown", () => {
    setTimeout(() => inputEl?.focus({ preventScroll: true }), 0);
  });
  const body = document.createElement("pre");
  body.className = "thinking-body";
  details.appendChild(summary);
  details.appendChild(body);
  messagesEl.appendChild(details);
  thinkingNodes.set(messageId, body);
  lastTurnNodes.push(details);
  scrollMessagesAfterContentChange();
  return body;
}

/**
 * Collapse every currently-open `<details class="message thinking">` block.
 * Called when the assistant's final-answer text starts streaming, so the chat
 * stays focused on the answer once thinking is done. We only touch blocks that
 * are still `open`: if the user has manually collapsed an older block, leave it.
 */
function collapseOpenThinkingBlocks() {
  const open = messagesEl.querySelectorAll("details.message.thinking[open]");
  open.forEach((d) => {
    if (d instanceof HTMLDetailsElement) d.open = false;
  });
}

function addMessage(role, text) {
  const row = document.createElement("div");
  row.className = `message ${role}`;
  row.textContent = text;
  messagesEl.appendChild(row);
  scrollMessagesAfterContentChange();
  return row;
}

/** @type {HTMLElement | null} */
let mcpLoadingEl = null;
/** @type {ReturnType<typeof setInterval> | null} */
let mcpLoadingTimer = null;

/**
 * @param {number} seconds
 */
function addMcpLoadingMessage(seconds) {
  if (mcpLoadingEl) { mcpLoadingEl.remove(); mcpLoadingEl = null; }
  if (mcpLoadingTimer) { clearInterval(mcpLoadingTimer); mcpLoadingTimer = null; }

  const row = document.createElement("div");
  row.className = "message mcp-loading";

  const spinner = document.createElement("span");
  spinner.className = "mcp-loading-spinner";
  row.appendChild(spinner);

  const check = document.createElement("span");
  check.className = "mcp-loading-check";
  check.textContent = "✓";
  check.style.display = "none";
  row.appendChild(check);

  const text = document.createElement("span");
  let remaining = Math.max(0, seconds);
  text.textContent = `Loading MCPs, tools, agents and skills (${remaining}s)`;
  row.appendChild(text);

  // Store refs for completeMcpLoading
  row._mcpSpinner = spinner;
  row._mcpCheck = check;
  row._mcpText = text;

  messagesEl.appendChild(row);
  scrollMessagesAfterContentChange();
  mcpLoadingEl = row;

  mcpLoadingTimer = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    text.textContent = `Loading MCPs, tools, agents and skills (${remaining}s)`;
    if (remaining === 0) { clearInterval(mcpLoadingTimer); mcpLoadingTimer = null; }
  }, 1000);
}

function completeMcpLoading() {
  if (mcpLoadingTimer) { clearInterval(mcpLoadingTimer); mcpLoadingTimer = null; }
  if (!mcpLoadingEl) return;
  const row = mcpLoadingEl;
  mcpLoadingEl = null;
  row.classList.add("done");
  if (row._mcpSpinner) row._mcpSpinner.style.display = "none";
  if (row._mcpCheck) row._mcpCheck.style.display = "inline";
  if (row._mcpText) row._mcpText.textContent = "MCPs, tools, agents and skills loaded";
}

/**
 * @param {string} widgetKey
 * @param {string[]} lines
 * @param {string} tabId
 * @param {boolean} expanded
 * @returns {HTMLElement}
 */
function addOrUpdateSubagentWidget(widgetKey, lines, tabId, expanded = false) {
  let row = subagentWidgetNodes.get(widgetKey);
  if (!row) {
    row = document.createElement("button");
    row.type = "button";
    row.className = "message subagent-widget";
    row.dataset.widgetKey = widgetKey;
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (tabId) vscode.postMessage({ type: "select_tab", tabId });
    });
    messagesEl.appendChild(row);
    subagentWidgetNodes.set(widgetKey, row);
  }
  row.dataset.tabId = tabId;
  row.textContent = "";
  row.classList.toggle("subagent-widget-expanded", expanded);
  const safeLines = Array.isArray(lines)
    ? lines.filter((line) => typeof line === "string")
    : [];
  const first = safeLines[0] || "Subagent";
  const status = first.trim().slice(0, 1);
  row.classList.toggle("subagent-running", status === "\u25cf");
  row.classList.toggle("subagent-done", status === "\u2713");
  row.classList.toggle("subagent-error", status === "\u2717");
  const header = document.createElement("div");
  header.className = "subagent-widget-header";
  header.textContent = first;
  row.appendChild(header);
  if (safeLines.length > 1 && !expanded) {
    const body = document.createElement("div");
    body.className = "subagent-widget-body";
    body.textContent = safeLines[1];
    row.appendChild(body);
  } else if (safeLines.length > 1) {
    const details = document.createElement("div");
    details.className = "subagent-widget-details";
    const resultStart = safeLines.findIndex((line) =>
      /^Subagent #\d+/.test(line),
    );
    const detailLines = safeLines
      .slice(1, resultStart === -1 ? undefined : resultStart)
      .filter((line) => line.trim());
    for (const line of detailLines) {
      const item = document.createElement("div");
      item.className = "subagent-widget-detail-line";
      item.textContent = line;
      details.appendChild(item);
    }
    row.appendChild(details);
  }
  scrollMessagesAfterContentChange();
  return row;
}

/**
 * Render a user message with optional attachment chips. The chips show only the
 * file basename, are clickable (open in the editor via `open_file`), and the
 * tooltip carries the full absolute path. The typed text is rendered below in a
 * `pre-wrap` block so multi-line prompts keep their layout. The LLM still sees
 * the absolute path — that part is appended host-side in `handlePrompt`.
 *
 * @param {string} text
 * @param {string[] | undefined} attachments
 * @returns {HTMLDivElement}
 */
function addUserMessage(text, attachments) {
  const row = document.createElement("div");
  row.className = "message user";
  const paths = Array.isArray(attachments)
    ? attachments.filter((p) => typeof p === "string" && p.length > 0)
    : [];
  if (paths.length > 0) {
    const chips = document.createElement("div");
    chips.className = "file-chips-inline";
    for (const p of paths) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "file-chip-link";
      chip.title = p;
      const base = String(p).split(/[/\\]/).pop() || p;
      chip.textContent = base;
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: "open_file", path: p });
      });
      chips.appendChild(chip);
    }
    row.appendChild(chips);
  }
  if (typeof text === "string" && text.length > 0) {
    const textEl = document.createElement("div");
    textEl.className = "message-text";
    textEl.textContent = text;
    row.appendChild(textEl);
  }
  messagesEl.appendChild(row);
  scrollMessagesAfterContentChange();
  return row;
}


// === MODULE: tools ===
// Tool call/result lifecycle, diff rendering, payload formatting.

/**
 * @param {string} toolName
 * @param {ToolEntry} entry
 */
function enqueuePendingToolEntry(toolName, entry) {
  const queue = pendingToolEntriesByName.get(toolName) || [];
  queue.push(entry);
  pendingToolEntriesByName.set(toolName, queue);
}

/**
 * @param {string} toolName
 * @returns {ToolEntry | null}
 */
function dequeuePendingToolEntry(toolName) {
  const queue = pendingToolEntriesByName.get(toolName);
  if (!queue || queue.length === 0) return null;
  const entry = queue.shift() || null;
  if (queue.length === 0) pendingToolEntriesByName.delete(toolName);
  return entry;
}

/**
 * @param {ToolEntry} entry
 * @param {"running" | "success" | "error"} state
 */
function setToolEntryState(entry, state) {
  entry.row.classList.remove(
    "tool-event-running",
    "tool-event-success",
    "tool-event-error",
  );
  entry.row.classList.add(`tool-event-${state}`);
  entry.statusDot.classList.remove(
    "tool-status-running",
    "tool-status-success",
    "tool-status-error",
  );
  entry.statusDot.classList.add(`tool-status-${state}`);
  if (state === "running") entry.label.textContent = `${entry.toolName}`;
  else if (state === "error")
    entry.label.textContent = `${entry.toolName} (error)`;
  else entry.label.textContent = `${entry.toolName} (result)`;
}

/**
 * @param {string} toolName
 * @param {unknown} args
 * @returns {ToolEntry}
 */
function createToolEntry(toolName, args) {
  const row = /** @type {HTMLDetailsElement} */ (
    document.createElement("details")
  );
  row.className = "message tool-event collapsed-tool tool-event-running";
  const head = document.createElement("summary");
  head.className = "tool-head";
  const statusDot = document.createElement("span");
  statusDot.className = "tool-status-dot tool-status-running";
  const label = document.createElement("span");
  label.className = "tool-label";
  label.textContent = toolName;
  head.appendChild(statusDot);
  head.appendChild(label);
  row.appendChild(head);
  const payload = formatToolPayload(args);
  if (payload) {
    row.classList.add("tool-has-payload");
    const pre = document.createElement("pre");
    pre.textContent = payload;
    row.appendChild(pre);
  }
  const resultHost = document.createElement("div");
  resultHost.className = "tool-result-host";
  row.appendChild(resultHost);
  messagesEl.appendChild(row);
  scrollMessagesAfterContentChange();
  return { row, toolName, label, statusDot, resultHost, hasResult: false };
}

/**
 * @param {ToolEntry} entry
 * @param {unknown} result
 * @param {boolean} isError
 */
function finalizeToolEntry(entry, result, isError) {
  setToolEntryState(entry, isError ? "error" : "success");
  entry.resultHost.textContent = "";
  const diff =
    !isError && (entry.toolName === "edit" || entry.toolName === "write")
      ? getDiffFromResult(result)
      : null;
  if (diff) {
    entry.resultHost.appendChild(renderDiffBlock(diff));
  } else {
    const pre = document.createElement("pre");
    pre.textContent = formatToolResult(result);
    entry.resultHost.appendChild(pre);
  }
  entry.hasResult = true;
  pendingToolRows.delete(entry.row);
  if ((entry.toolName === "edit" || entry.toolName === "write") && !isError) {
    entry.row.open = true;
  }
  scrollMessagesAfterContentChange();
}


function addToolCallMessage(toolName, args) {
  const entry = createToolEntry(toolName, args);
  enqueuePendingToolEntry(toolName, entry);
  pendingToolRows.add(entry.row);
  return entry.row;
}

/**
 * Render a tool result row (head + truncated text body).
 * @param {string} toolName
 * @param {unknown} result
 * @param {boolean} isError
 * @returns {{ row: HTMLDetailsElement, created: boolean }}
 */
function addToolResultMessage(toolName, result, isError) {
  const existing = dequeuePendingToolEntry(toolName);
  if (existing) {
    finalizeToolEntry(existing, result, isError);
    return { row: existing.row, created: false };
  }
  const entry = createToolEntry(toolName, null);
  finalizeToolEntry(entry, result, isError);
  return { row: entry.row, created: true };
}

/**
 * Parse and render a colored diff block from the custom free-code diff format.
 * Format per line: first char is '+' (added), '-' (removed), or ' ' (context).
 * Followed by a padded line number, a space, then the content.
 * Ellipsis lines look like `   ...`.
 * @param {string} diffStr
 * @returns {HTMLElement}
 */
function renderDiffBlock(diffStr) {
  const container = document.createElement("div");
  container.className = "diff-block";
  const lines = diffStr.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const kind = line[0];
    const rest = line.slice(1);
    const row = document.createElement("div");
    const trimmed = rest.trimStart();
    if (trimmed === "..." || trimmed.endsWith(" ...")) {
      row.className = "diff-line diff-line-ellipsis";
      row.textContent = "  \u2026";
      container.appendChild(row);
      continue;
    }
    const spaceIdx = trimmed.indexOf(" ");
    const content = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    if (kind === "+") {
      row.className = "diff-line diff-line-add";
      row.textContent = `+ ${content}`;
    } else if (kind === "-") {
      row.className = "diff-line diff-line-del";
      row.textContent = `\u2212 ${content}`;
    } else {
      row.className = "diff-line diff-line-ctx";
      row.textContent = `  ${content}`;
    }
    container.appendChild(row);
  }
  return container;
}

/**
 * Extract diff string from a tool result object (edit tool only).
 * @param {unknown} result
 * @returns {string | null}
 */
function getDiffFromResult(result) {
  if (!result || typeof result !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (result);
  const details = r.details;
  if (!details || typeof details !== "object") return null;
  const d = /** @type {Record<string, unknown>} */ (details);
  return typeof d.diff === "string" && d.diff.length > 0 ? d.diff : null;
}

/**
 * Pretty-print tool arguments. Falls back to String() if JSON.stringify throws.
 * @param {unknown} payload
 * @returns {string}
 */
function formatToolPayload(payload) {
  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/**
 * Tool results have the shape `{ content: [{ type, text }], details }`.
 * Concatenate text parts (or fall back to JSON). Truncate to keep the chat readable.
 * @param {unknown} result
 * @returns {string}
 */
function formatToolResult(result) {
  if (
    result &&
    typeof result === "object" &&
    Array.isArray(/** @type {Record<string, unknown>} */ (result).content)
  ) {
    const parts = /** @type {unknown[]} */ (
      /** @type {Record<string, unknown>} */ (result).content
    );
    const texts = [];
    for (const p of parts) {
      if (p && typeof p === "object") {
        const o = /** @type {Record<string, unknown>} */ (p);
        if (typeof o.text === "string") texts.push(o.text);
        else if (o.type === "image") texts.push("[image]");
      }
    }
    const joined = texts.join("\n");
    return truncateForChat(joined || formatToolPayload(result));
  }
  return truncateForChat(formatToolPayload(result));
}

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function truncateForChat(text, max = 4000) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more chars hidden)`;
}


// === MODULE: questionnaire ===
// Render inline questionnaire cards with tab strip, radio options, and free-text input.

/**
 * Render an inline questionnaire card inside the chat. The card collects
 * answers locally and posts a single `questionnaire_response` back to the
 * extension when the user submits or cancels. Mirrors the bundled TUI tool's
 * UX: option list per question, a "Type something" free-text escape hatch,
 * and a tab strip + submit step when there are multiple questions.
 *
 * @param {string} requestId
 * @param {Array<{ id: string, prompt: string, options: Array<{ value: string, label: string, description?: string }>, label?: string, allowOther?: boolean }>} questions
 */
function renderQuestionnaireCard(requestId, questions) {
  const isMulti = questions.length > 1;
  /** @type {Map<string, { value: string, label: string, wasCustom: boolean, index?: number }>} */
  const answers = new Map();
  let activeIndex = 0;
  let submitted = false;

  const card = document.createElement("section");
  card.className = "message questionnaire-card";
  card.dataset.requestId = requestId;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Questionnaire");

  const header = document.createElement("header");
  header.className = "questionnaire-header";
  const title = document.createElement("strong");
  title.textContent = isMulti
    ? `Questionnaire — ${questions.length} questions`
    : "Question";
  header.appendChild(title);
  card.appendChild(header);

  let tabStrip = null;
  if (isMulti) {
    tabStrip = document.createElement("nav");
    tabStrip.className = "questionnaire-tabs";
    tabStrip.setAttribute("role", "tablist");
    card.appendChild(tabStrip);
  }

  const body = document.createElement("div");
  body.className = "questionnaire-body";
  card.appendChild(body);

  const footer = document.createElement("footer");
  footer.className = "questionnaire-footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "questionnaire-btn questionnaire-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => sendResponse(true));
  footer.appendChild(cancelBtn);

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "questionnaire-btn questionnaire-submit";
  submitBtn.textContent = isMulti ? "Submit answers" : "Submit";
  submitBtn.addEventListener("click", () => sendResponse(false));
  footer.appendChild(submitBtn);

  card.appendChild(footer);
  messagesEl.appendChild(card);
  scrollMessagesAfterContentChange();

  render();

  function sendResponse(cancelled) {
    if (submitted) return;
    if (!cancelled && !allAnswered()) {
      // Highlight the first unanswered question to nudge the user.
      const firstUnanswered = questions.findIndex((q) => !answers.has(q.id));
      if (firstUnanswered >= 0) {
        activeIndex = firstUnanswered;
        render();
      }
      return;
    }
    submitted = true;
    card.classList.add("questionnaire-disabled");
    // Disable inputs after submission so the user can't change answers post-hoc.
    for (const input of card.querySelectorAll("input, button")) {
      /** @type {HTMLInputElement | HTMLButtonElement} */ (input).disabled =
        true;
    }
    const summary = document.createElement("p");
    summary.className = "questionnaire-summary";
    if (cancelled) {
      summary.textContent = "Cancelled";
    } else {
      const lines = questions.map((q) => {
        const a = answers.get(q.id);
        if (!a) return `${q.label || q.id}: —`;
        return a.wasCustom
          ? `${q.label || q.id}: (wrote) ${a.label}`
          : `${q.label || q.id}: ${a.index ? `${a.index}. ` : ""}${a.label}`;
      });
      summary.textContent = lines.join("\n");
    }
    card.replaceChild(summary, footer);
    vscode.postMessage(
      cancelled
        ? { type: "questionnaire_response", requestId, cancelled: true }
        : {
            type: "questionnaire_response",
            requestId,
            cancelled: false,
            answers: Array.from(answers.entries()).map(([id, a]) => ({
              id,
              value: a.value,
              label: a.label,
              wasCustom: a.wasCustom,
              index: a.index,
            })),
          },
    );
  }

  function allAnswered() {
    return questions.every((q) => answers.has(q.id));
  }

  function render() {
    if (tabStrip) renderTabs();
    renderBody();
    submitBtn.disabled = !allAnswered();
  }

  function renderTabs() {
    if (!tabStrip) return;
    tabStrip.replaceChildren();
    questions.forEach((q, idx) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "questionnaire-tab";
      tab.setAttribute("role", "tab");
      if (idx === activeIndex) tab.classList.add("active");
      if (answers.has(q.id)) tab.classList.add("answered");
      const marker = document.createElement("span");
      marker.className = "questionnaire-tab-marker";
      marker.textContent = answers.has(q.id) ? "■" : "□";
      tab.appendChild(marker);
      tab.appendChild(document.createTextNode(` ${q.label || `Q${idx + 1}`}`));
      tab.addEventListener("click", () => {
        activeIndex = idx;
        render();
      });
      tabStrip.appendChild(tab);
    });
  }

  function renderBody() {
    body.replaceChildren();
    const q = questions[activeIndex];
    if (!q) return;
    const prompt = document.createElement("p");
    prompt.className = "questionnaire-prompt";
    prompt.textContent = q.prompt;
    body.appendChild(prompt);

    const list = document.createElement("div");
    list.className = "questionnaire-options";
    list.setAttribute("role", "radiogroup");
    body.appendChild(list);

    const groupName = `q-${requestId}-${q.id}`;
    const current = answers.get(q.id);

    q.options.forEach((opt, idx) => {
      const optionId = `${groupName}-opt-${idx}`;
      const wrapper = document.createElement("label");
      wrapper.className = "questionnaire-option";
      wrapper.setAttribute("for", optionId);

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = groupName;
      radio.id = optionId;
      radio.value = opt.value;
      radio.checked =
        !!current && !current.wasCustom && current.index === idx + 1;
      radio.addEventListener("change", () => {
        answers.set(q.id, {
          value: opt.value,
          label: opt.label,
          wasCustom: false,
          index: idx + 1,
        });
        if (isMulti && activeIndex < questions.length - 1) {
          activeIndex += 1;
        }
        render();
      });
      wrapper.appendChild(radio);

      const label = document.createElement("span");
      label.className = "questionnaire-option-label";
      label.textContent = `${idx + 1}. ${opt.label}`;
      wrapper.appendChild(label);

      if (opt.description) {
        const desc = document.createElement("span");
        desc.className = "questionnaire-option-desc";
        desc.textContent = opt.description;
        wrapper.appendChild(desc);
      }

      list.appendChild(wrapper);
    });

    if (q.allowOther !== false) {
      const otherWrapper = document.createElement("label");
      otherWrapper.className =
        "questionnaire-option questionnaire-option-other";
      const otherId = `${groupName}-other`;
      otherWrapper.setAttribute("for", otherId);

      const otherRadio = document.createElement("input");
      otherRadio.type = "radio";
      otherRadio.name = groupName;
      otherRadio.id = otherId;
      otherRadio.value = "__other__";
      otherRadio.checked = !!current && current.wasCustom;
      otherWrapper.appendChild(otherRadio);

      const label = document.createElement("span");
      label.className = "questionnaire-option-label";
      label.textContent = "Type something.";
      otherWrapper.appendChild(label);

      const textarea = document.createElement("textarea");
      textarea.className = "questionnaire-other-input";
      textarea.rows = 2;
      textarea.placeholder = "Your answer…";
      textarea.value = current && current.wasCustom ? current.value : "";
      otherRadio.addEventListener("change", () => {
        if (otherRadio.checked) {
          textarea.focus();
          updateOtherAnswer();
        }
      });
      textarea.addEventListener("input", () => {
        if (!otherRadio.checked) otherRadio.checked = true;
        updateOtherAnswer();
      });
      otherWrapper.appendChild(textarea);

      list.appendChild(otherWrapper);

      function updateOtherAnswer() {
        const trimmed = textarea.value.trim();
        if (trimmed.length === 0) {
          answers.delete(q.id);
        } else {
          answers.set(q.id, {
            value: trimmed,
            label: trimmed,
            wasCustom: true,
          });
        }
        submitBtn.disabled = !allAnswered();
        if (tabStrip) renderTabs();
      }
    }
  }
}


// === MODULE: tabs ===
// Chat drawer: open/close/pin, inline rename, conversation switching.

const DRAWER_PIN_KEY = "free-code-drawer-pinned";
const LEGACY_DRAWER_PIN_KEY = "edo-drawer-pinned";
let drawerPinned = readMigratedLocalStorage(DRAWER_PIN_KEY, LEGACY_DRAWER_PIN_KEY) === "true";

const SVG_PENCIL = `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708zm.646 6.061L9.793 2.5 3.293 9H3.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.207zm-7.468 7.468A.5.5 0 0 1 6 13.5V13h-.5a.5.5 0 0 1-.5-.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.499.499 0 0 1-.175-.032l-.179.178a.5.5 0 0 0-.11.168l-2 5a.5.5 0 0 0 .65.65l5-2a.5.5 0 0 0 .168-.11z"/></svg>`;

// Apply persisted pin state immediately (before first renderTabStrip call)
if (drawerPinned) {
  document.body.classList.add("drawer-pinned");
  chatListPanelEl?.classList.add("open");
  chatNavToggleEl?.setAttribute("aria-expanded", "true");
  if (chatListPinBtnEl) {
    chatListPinBtnEl.setAttribute("aria-pressed", "true");
    chatListPinBtnEl.title = "Unpin sidebar";
  }
}

function _forceCloseDrawer() {
  chatListPanelEl?.classList.remove("open");
  chatListBackdropEl?.classList.remove("open");
  chatNavToggleEl?.setAttribute("aria-expanded", "false");
}

function openDrawer() {
  chatListPanelEl?.classList.add("open");
  if (!drawerPinned) chatListBackdropEl?.classList.add("open");
  chatNavToggleEl?.setAttribute("aria-expanded", "true");
}

function closeDrawer() {
  if (drawerPinned) return;
  _forceCloseDrawer();
}

function pinDrawer() {
  drawerPinned = true;
  document.body.classList.add("drawer-pinned");
  writeLocalStorage(DRAWER_PIN_KEY, "true");
  if (chatListPinBtnEl) {
    chatListPinBtnEl.setAttribute("aria-pressed", "true");
    chatListPinBtnEl.title = "Unpin sidebar";
  }
  chatListBackdropEl?.classList.remove("open");
  openDrawer();
}

function unpinDrawer() {
  drawerPinned = false;
  document.body.classList.remove("drawer-pinned");
  writeLocalStorage(DRAWER_PIN_KEY, "false");
  if (chatListPinBtnEl) {
    chatListPinBtnEl.setAttribute("aria-pressed", "false");
    chatListPinBtnEl.title = "Keep sidebar open";
  }
  _forceCloseDrawer();
}

function startRename(item) {
  if (item.classList.contains("renaming")) return;
  item.classList.add("renaming");

  const labelEl = item.querySelector(".chat-list-label");
  if (!labelEl) { item.classList.remove("renaming"); return; }

  const currentName = labelEl.textContent || "";
  const tabId = item.dataset.tabId || "";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "chat-list-rename-input";
  input.value = currentName;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim() || currentName;
    const newLabel = document.createElement("span");
    newLabel.className = "chat-list-label";
    newLabel.textContent = newName;
    newLabel.addEventListener("dblclick", (e) => { e.stopPropagation(); startRename(item); });
    input.replaceWith(newLabel);
    item.classList.remove("renaming");
    if (item.classList.contains("active") && chatNavTitleEl) {
      chatNavTitleEl.textContent = newName;
    }
    if (tabId && newName !== currentName) {
      vscode.postMessage({ type: "rename_tab", tabId, label: newName });
    }
  }

  function cancel() {
    const restored = document.createElement("span");
    restored.className = "chat-list-label";
    restored.textContent = currentName;
    restored.addEventListener("dblclick", (e) => { e.stopPropagation(); startRename(item); });
    input.replaceWith(restored);
    item.classList.remove("renaming");
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { e.preventDefault(); input.removeEventListener("blur", commit); cancel(); }
    e.stopPropagation();
  });
}

function wireDrawerItem(item) {
  item.addEventListener("click", (e) => {
    if (/** @type {Element} */ (e.target).closest(".chat-list-actions")) return;
    if (item.classList.contains("renaming")) return;
    const tabId = item.dataset.tabId;
    if (tabId) vscode.postMessage({ type: "select_tab", tabId });
    if (!drawerPinned) closeDrawer();
  });

  item.querySelector(".chat-list-label")?.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startRename(item);
  });

  item.querySelector(".rename")?.addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(item);
  });

  item.querySelector(".delete")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const tabId = item.dataset.tabId;
    if (tabId) vscode.postMessage({ type: "close_tab", tabId });
  });
}

/**
 * @param {{ id: string, label: string }[]} tabs
 * @param {string} activeId
 */
function renderTabStrip(tabs, activeId) {
  if (!chatListBodyEl) return;
  chatListBodyEl.textContent = "";

  const activeTab = tabs.find((t) => t.id === activeId);
  if (chatNavTitleEl) {
    chatNavTitleEl.textContent = activeTab?.label || "New chat";
  }

  const countEl = document.getElementById("chat-list-count");
  if (countEl) countEl.textContent = String(tabs.length);

  for (const t of tabs) {
    const item = document.createElement("div");
    item.className = "chat-list-item" + (t.id === activeId ? " active" : "");
    item.setAttribute("role", "menuitem");
    item.tabIndex = 0;
    item.dataset.tabId = t.id;

    const dot = document.createElement("span");
    dot.className = "chat-list-dot";

    const label = document.createElement("span");
    label.className = "chat-list-label";
    label.textContent = t.label || "New chat";

    const actions = document.createElement("span");
    actions.className = "chat-list-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "chat-list-action-btn rename";
    renameBtn.title = "Rename";
    renameBtn.innerHTML = SVG_PENCIL;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "chat-list-action-btn delete";
    deleteBtn.title = "Close";
    deleteBtn.textContent = "×";

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(dot);
    item.appendChild(label);
    item.appendChild(actions);
    chatListBodyEl.appendChild(item);

    wireDrawerItem(item);
  }
}

// ── Event listeners ──

chatNavToggleEl?.addEventListener("click", () => {
  if (drawerPinned) {
    unpinDrawer();
  } else {
    chatListPanelEl?.classList.contains("open") ? closeDrawer() : openDrawer();
  }
});

chatListBackdropEl?.addEventListener("click", closeDrawer);

chatListPinBtnEl?.addEventListener("click", () => {
  drawerPinned ? unpinDrawer() : pinDrawer();
});

chatNavNewEl?.addEventListener("click", () => {
  vscode.postMessage({ type: "new_tab" });
  if (!drawerPinned) closeDrawer();
});

document.getElementById("chat-list-new-btn")?.addEventListener("click", () => {
  vscode.postMessage({ type: "new_tab" });
  if (!drawerPinned) closeDrawer();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !drawerPinned) closeDrawer();
});

// Scroll pinning (kept from original)
messagesEl.addEventListener("scroll", () => {
  isScrollPinnedToBottom = isMessagesScrolledNearBottom();
});

// === MODULE: message-handler ===
// Main dispatcher for messages received from the VS Code extension host.

window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "user_message": {
      const userNode = addUserMessage(message.text, message.attachments);
      lastTurnNodes = [userNode];
      setWorkingStatus("Starting agent");
      break;
    }
    case "assistant_message_start": {
      // Final answer is starting to stream — collapse any still-open thinking
      // blocks so the chat focuses on the answer. Blocks belonging to a turn
      // that never produced an answer (model errored / "broke" mid-thinking)
      // stay open since this branch never fires for them.
      setWorkingStatus("Writing response");
      collapseOpenThinkingBlocks();
      const node = addMessage("assistant", "");
      assistantNodes.set(message.messageId, node);
      lastTurnNodes.push(node);
      break;
    }
    case "assistant_message_delta": {
      const node = assistantNodes.get(message.messageId);
      if (node) node.textContent += message.text;
      setWorkingStatus("Writing response");
      scrollMessagesAfterContentChange();
      break;
    }
    case "thinking_start": {
      if (typeof message.messageId === "string") {
        setWorkingStatus("Reasoning");
        addThinkingBlock(message.messageId);
      }
      break;
    }
    case "thinking_delta": {
      if (
        typeof message.messageId === "string" &&
        typeof message.text === "string"
      ) {
        let body = thinkingNodes.get(message.messageId);
        if (!body) body = addThinkingBlock(message.messageId);
        body.textContent += message.text;
        setWorkingStatus("Reasoning");
        scrollMessagesAfterContentChange();
      }
      break;
    }
    case "status":
      // Only drive the "Agent working" spinner while a turn is actually in
      // flight. Status events also arrive outside a turn — e.g. profile-manager
      // emits setStatus("profile", "- profile:<name>") on startup/session
      // restore. Without the isBusy gate those would call setWorkingStatus and
      // start a spinner that never stops, because no agent_end/busy:false ever
      // follows (there was no turn) and the recovery watchdog was never armed.
      if (isBusy) {
        if (message.text) {
          setWorkingStatus(message.text);
        } else {
          setWorkingStatus(workingStatusText || "Working", {
            markActivity: false,
          });
        }
      } else {
        statusEl.textContent = message.text || "";
      }
      break;
    case "token_usage":
      // Show token usage (TPS) as a static status line after agent_end.
      // Written directly to statusEl so it persists after the working indicator is gone.
      if (typeof message.text === "string" && message.text) {
        statusEl.textContent = message.text;
      }
      break;
    case "focus_input":
      // Sent by the extension host after a native modal dialog (MCP authorization,
      // select/input/editor). VS Code returns focus to its last active panel
      // (often the editor), not the webview, so the next paste ends up in the wrong
      // place. Explicitly pull focus back to the chat input.
      inputEl?.focus({ preventScroll: true });
      break;
    case "tool_call": {
      const name =
        typeof message.toolName === "string" ? message.toolName : "tool";
      setWorkingStatus(`Running tool: ${name}`);
      const node = addToolCallMessage(name, message.args);
      lastTurnNodes.push(node);
      break;
    }
    case "tool_result": {
      const name =
        typeof message.toolName === "string" ? message.toolName : "tool";
      setWorkingStatus(
        message.isError === true
          ? `Tool failed: ${name}`
          : `Finished tool: ${name}`,
      );
      const { row, created } = addToolResultMessage(
        name,
        message.result,
        message.isError === true,
      );
      if (created) lastTurnNodes.push(row);
      break;
    }
    case "hint":
      if (typeof message.text === "string") {
        addMessage("hint", message.text);
      }
      break;
    case "mcp_loading_start":
      if (typeof message.seconds === "number" && message.seconds > 0) {
        addMcpLoadingMessage(message.seconds);
      }
      break;
    case "mcp_loading_done":
      completeMcpLoading();
      break;
    case "custom_message":
      if (typeof message.text === "string") {
        addMessage("custom", message.text);
      }
      break;
    case "subagent_widget": {
      const widgetKey =
        typeof message.widgetKey === "string" ? message.widgetKey : "";
      const tabId = typeof message.tabId === "string" ? message.tabId : "";
      const lines = Array.isArray(message.lines)
        ? message.lines.filter((line) => typeof line === "string")
        : [];
      if (widgetKey)
        addOrUpdateSubagentWidget(
          widgetKey,
          lines,
          tabId,
          message.expanded === true,
        );
      break;
    }
    case "questionnaire_request": {
      const requestId =
        typeof message.requestId === "string" ? message.requestId : "";
      const questions = Array.isArray(message.questions)
        ? message.questions
        : [];
      if (requestId && questions.length > 0) {
        renderQuestionnaireCard(requestId, questions);
      }
      break;
    }
    case "error":
      addMessage("error", message.text);
      statusEl.textContent = "";
      break;
    case "session_info":
      if (typeof message.text === "string") {
        // Extract session ID from text to sync currentSessionId (restores localStorage state)
        const sessionIdMatch = message.text.match(/\bID:\s*([0-9a-f-]{36})\b/i);
        const textSessionId = sessionIdMatch ? sessionIdMatch[1] : null;
        if (textSessionId && textSessionId !== currentSessionId) {
          if (currentSessionId) {
            sessionActivations.set(currentSessionId, { mcpTokens: activatedMcpTokens, skillTokens: activatedSkillTokens, agentTokens: activatedAgentTokens });
          }
          const saved = sessionActivations.get(textSessionId);
          if (saved) {
            activatedMcpTokens = saved.mcpTokens;
            activatedSkillTokens = saved.skillTokens;
            activatedAgentTokens = saved.agentTokens ?? new Map();
          }
          currentSessionId = textSessionId;
        }
        // Seed MCP, Skill, Agent tokens from session text lines
        let seeded = false;
        for (const m of message.text.matchAll(/^(MCP: [^:]+|Skill: [^:]+|Agent: [^:]+):\s+~([\d,]+)\s+tok/gm)) {
          const label = m[1].trim();
          const tok = parseInt(m[2].replace(/,/g, ""), 10) || 0;
          if (label.startsWith("MCP: ")) {
            const key = label.slice(5).trim();
            if (key && !activatedMcpTokens.has(key)) { activatedMcpTokens.set(key, tok); seeded = true; }
          } else if (label.startsWith("Skill: ")) {
            const name = label.slice(7).trim();
            if (name && !activatedSkillTokens.has(name)) { activatedSkillTokens.set(name, tok); seeded = true; }
          } else if (label.startsWith("Agent: ")) {
            const name = label.slice(7).trim();
            if (name && !activatedAgentTokens.has(name)) { activatedAgentTokens.set(name, tok); seeded = true; }
          }
        }
        if (seeded) { saveSessionActivations(); updateSessionMonitor({ stats: {} }); }
        addMessage("session", message.text);
        statusEl.textContent = "";
      }
      break;
    case "tools_info":
      if (typeof message.text === "string") {
        // Seed token maps from picker result text
        let toolsInfoSeeded = false;
        const txt = message.text;
        if (txt.startsWith("Active tools")) {
          for (const m of txt.matchAll(/^\s+\[on\]\s+(MCP:\s+\S+)\s+\(\d+ tools,\s+~([\d,]+) tok/gm)) {
            const key = m[1].trim();
            const tok = parseInt(m[2].replace(/,/g, ""), 10) || 0;
            activatedMcpTokens.set(key, tok);
            toolsInfoSeeded = true;
          }
        } else if (txt.startsWith("Skills (system prompt)")) {
          for (const m of txt.matchAll(/^\s+\[on\]\s+(\S+)\s+\(~([\d,]+) tok/gm)) {
            const name = m[1].trim();
            const tok = parseInt(m[2].replace(/,/g, ""), 10) || 0;
            activatedSkillTokens.set(name, tok);
            toolsInfoSeeded = true;
          }
        } else if (txt.startsWith("Active agents")) {
          for (const m of txt.matchAll(/^\s+\[on\]\s+(\S+)\s+\(~([\d,]+) tok/gm)) {
            const name = m[1].trim();
            const tok = parseInt(m[2].replace(/,/g, ""), 10) || 0;
            activatedAgentTokens.set(name, tok);
            toolsInfoSeeded = true;
          }
        }
        if (toolsInfoSeeded) { saveSessionActivations(); updateSessionMonitor({ stats: {} }); }
        addMessage("tools", message.text);
        statusEl.textContent = "";
      }
      break;
    case "open_tool_picker":
      if (message.state && typeof message.state === "object") {
        openToolPicker(/** @type {Record<string, unknown>} */ (message.state));
      }
      break;
    case "tool_picker_close":
      closeToolPicker();
      break;
    case "open_skill_picker":
      if (message.state && typeof message.state === "object") {
        openSkillPicker(/** @type {Record<string, unknown>} */ (message.state));
      }
      break;
    case "skill_picker_close":
      closeSkillPicker();
      break;
    case "open_agent_picker":
      if (message.state && typeof message.state === "object") {
        openAgentPicker(/** @type {Record<string, unknown>} */ (message.state));
      }
      break;
    case "agent_picker_close":
      closeAgentPicker();
      break;
    case "open_model_picker":
      if (message.state && typeof message.state === "object") {
        openModelPicker(/** @type {Record<string, unknown>} */ (message.state));
      }
      break;
    case "model_picker_close":
      closeModelPicker();
      break;
    case "model_indicator":
      setModelIndicator(
        message.model && typeof message.model === "object"
          ? /** @type {{ id: string, provider: string, name: string }} */ (
              message.model
            )
          : null,
      );
      break;
    case "profile_indicator":
      setProfileIndicator(
        typeof message.profile === "string" ? message.profile : null,
      );
      break;
    case "workspace_indicator":
      setWorkspaceIndicator(
        message.workspace && typeof message.workspace === "object"
          ? /** @type {{ path: string, displayPath: string, name: string, branch: string | null }} */ (
              message.workspace
            )
          : null,
      );
      break;
    case "mode_indicator":
      setModeIndicator(typeof message.mode === "string" ? message.mode : "");
      break;
    case "agent_end":
      pendingToolEntriesByName.clear();
      pendingToolRows.clear();
      stopWorkingStatus();
      lastTurnNodes = [];
      break;
    case "abort_undo": {
      for (const node of lastTurnNodes) {
        if (node && node.parentNode) node.remove();
      }
      lastTurnNodes = [];
      assistantNodes.clear();
      pendingToolEntriesByName.clear();
      pendingToolRows.clear();
      if (inputEl && typeof message.text === "string") {
        inputEl.value = message.text;
        syncInputHeight();
      }
      if (Array.isArray(message.attachments)) {
        const paths = message.attachments.filter(
          (p) => typeof p === "string" && p.length > 0,
        );
        if (paths.length > 0) insertChipsForPaths(paths);
      }
      statusEl.textContent = "";
      break;
    }
    case "set_tabs": {
      const tabs = Array.isArray(message.tabs) ? message.tabs : [];
      const activeId =
        typeof message.activeId === "string" ? message.activeId : "";
      renderTabStrip(tabs, activeId);
      break;
    }
    case "restore_history": {
      clearMessages();
      setQueuedMessage(null);
      const list = Array.isArray(message.messages) ? message.messages : [];
      for (const m of list) {
        if (!m || typeof m.role !== "string") continue;
        const txt = typeof m.text === "string" ? m.text : "";
        const att = Array.isArray(m.attachments)
          ? m.attachments.filter((p) => typeof p === "string" && p.length > 0)
          : [];
        if (m.role === "user") {
          if (!txt && att.length === 0) continue;
          addUserMessage(txt, att);
        } else if (m.role === "thinking") {
          if (!txt) continue;
          // Re-render historical thinking as a collapsed details block so the
          // chat stays focused on the past answers; the user can still expand
          // to inspect the model's reasoning. Each restored block needs its
          // own id so streaming a NEW thinking block in this same view (after
          // reload) doesn't accidentally append into a restored body.
          const body = addThinkingBlock(
            `thinking-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            false,
          );
          body.textContent = txt;
        } else if (m.role === "tool_call") {
          if (!txt) continue;
          try {
            const data = JSON.parse(txt);
            addToolCallMessage(
              typeof data.toolName === "string" ? data.toolName : "tool",
              data.args,
            );
          } catch {
            /* skip malformed */
          }
        } else if (m.role === "tool_result") {
          if (!txt) continue;
          try {
            const data = JSON.parse(txt);
            addToolResultMessage(
              typeof data.toolName === "string" ? data.toolName : "tool",
              data.result,
              data.isError === true,
            );
          } catch {
            /* skip malformed */
          }
        } else if (m.role === "subagent_widget") {
          if (!txt) continue;
          try {
            const data = JSON.parse(txt);
            const widgetKey =
              typeof data.widgetKey === "string" ? data.widgetKey : "";
            const tabId = typeof data.tabId === "string" ? data.tabId : "";
            const lines = Array.isArray(data.lines)
              ? data.lines.filter((line) => typeof line === "string")
              : [];
            if (widgetKey)
              addOrUpdateSubagentWidget(
                widgetKey,
                lines,
                tabId,
                data.expanded === true,
              );
          } catch {
            /* skip malformed */
          }
        } else if (txt) {
          addMessage(m.role, txt);
        }
      }
      break;
    }
    case "clear":
      clearMessages();
      statusEl.textContent = "";
      setQueuedMessage(null);
      break;
    case "busy":
      setBusy(!!message.busy, { showWorking: message.showWorking !== false });
      break;
    case "insert_paths": {
      const p = message.paths;
      if (Array.isArray(p) && p.length > 0) {
        const strs = p.filter((x) => typeof x === "string" && x.length > 0);
        if (strs.length > 0) insertChipsForPaths(strs);
      }
      break;
    }
    case "slash_commands": {
      /** @type {unknown} */
      const rawCmd = message.commands;
      /** @type {unknown} */
      const rawSk = message.skills;
      const norm = (x) => {
        if (!x || typeof x !== "object") return null;
        const o = /** @type {Record<string, unknown>} */ (x);
        const slash =
          typeof o.slash === "string"
            ? o.slash
            : typeof o.label === "string"
              ? o.label
              : "";
        if (!slash || slash[0] !== "/") return null;
        return {
          label: typeof o.label === "string" ? o.label : slash,
          slash,
          description: typeof o.description === "string" ? o.description : "",
        };
      };
      slashCommandItems = Array.isArray(rawCmd)
        ? rawCmd.map(norm).filter((x) => x != null)
        : [];
      slashSkillItems = Array.isArray(rawSk)
        ? rawSk.map(norm).filter((x) => x != null)
        : [];
      updateSlashMenuFromInput();
      break;
    }
    case "zoom_in": {
      setFreeCodeZoom(getFreeCodeZoom() + 0.1);
      break;
    }
    case "zoom_out": {
      setFreeCodeZoom(getFreeCodeZoom() - 0.1);
      break;
    }
    case "zoom_reset": {
      setFreeCodeZoom(1);
      break;
    }
    case "terminal_toggle": {
      if (!terminalPanelEl) break;
      terminalPanelEl.hidden = !terminalPanelEl.hidden;
      if (!terminalPanelEl.hidden) terminalInputEl?.focus();
      break;
    }
    case "terminal_set_docked": {
      if (!terminalPanelEl) break;
      terminalPanelEl.hidden = message.docked !== true;
      if (!terminalPanelEl.hidden) terminalInputEl?.focus();
      break;
    }
    case "session_stats_update": {
      updateSessionMonitor(message);
      break;
    }
    case "session_monitor_toggle": {
      if (!sessionMonitorEl) break;
      sessionMonitorEl.hidden = !sessionMonitorEl.hidden;
      if (!sessionMonitorEl.hidden) {
        setSessionMonitorLoadingState();
        vscode.postMessage({ type: "request_session_stats" });
        vscode.postMessage({ type: "session_polling", enabled: true });
      } else {
        vscode.postMessage({ type: "session_polling", enabled: false });
      }
      break;
    }
    case "terminal_output": {
      if (typeof message.text === "string") appendTerminalOutput(message.text);
      break;
    }
    case "terminal_error": {
      if (typeof message.text === "string") appendTerminalError(message.text);
      break;
    }
    case "terminal_clear": {
      if (terminalOutputEl) terminalOutputEl.textContent = "";
      break;
    }
    default:
      break;
  }
});

// === MODULE: button-events ===
// Click/keyboard/drag event listeners for send/stop, queue, pickers, input, form, attach buttons.

if (sendOrStopButton) {
  sendOrStopButton.addEventListener("click", () => {
    if (isBusy) {
      abortAgent();
      return;
    }
    commitChatInput();
  });
}

if (queueEditBtn) {
  queueEditBtn.addEventListener("click", () => {
    if (!queuedMessage || !inputEl) return;
    inputEl.value = queuedMessage.text;
    setQueuedMessage(null);
    inputEl.focus();
    syncInputHeight();
  });
}

if (queueDeleteBtn) {
  queueDeleteBtn.addEventListener("click", () => {
    setQueuedMessage(null);
  });
}

{
  const toolPickerCancel = document.getElementById("tool-picker-cancel");
  const toolPickerApply = document.getElementById("tool-picker-apply");
  if (toolPickerCancel) {
    toolPickerCancel.addEventListener("click", () => {
      closeToolPicker();
      vscode.postMessage({ type: "tool_picker_cancel" });
    });
  }
  if (toolPickerApply) {
    toolPickerApply.addEventListener("click", () => {
      const body = document.getElementById("tool-picker-body");
      if (!body) return;
      const cbs = body.querySelectorAll(
        "input[type='checkbox'][data-group-key]",
      );
      /** @type {string[]} */
      const keys = [];
      cbs.forEach((el) => {
        if (
          el instanceof HTMLInputElement &&
          el.checked &&
          el.dataset.groupKey
        ) {
          keys.push(el.dataset.groupKey);
        }
      });
      // Update toolGroups locally with the new enabled state
      if (Array.isArray(toolGroups)) {
        for (const group of toolGroups) {
          if (group && typeof group === "object") {
            const g = /** @type {Record<string, unknown>} */ (group);
            const key = String(g.key || "");
            const isEnabled = keys.includes(key);
            g.enabled = isEnabled;
            if (isEnabled) {
              const tok = typeof g.tokensEstimated === "number" ? g.tokensEstimated : 0;
              activatedMcpTokens.set(key, tok);
            }
          }
        }
      }
      saveSessionActivations();
      updateSessionMonitor({ stats: {} });
      closeToolPicker();
      vscode.postMessage({ type: "tool_picker_apply", enabledGroupKeys: keys });
    });
  }
  const skillPickerCancel = document.getElementById("skill-picker-cancel");
  const skillPickerApply = document.getElementById("skill-picker-apply");
  if (skillPickerCancel) {
    skillPickerCancel.addEventListener("click", () => {
      closeSkillPicker();
      vscode.postMessage({ type: "skill_picker_cancel" });
    });
  }
  if (skillPickerApply) {
    skillPickerApply.addEventListener("click", () => {
      const body = document.getElementById("skill-picker-body");
      if (!body) return;
      const cbs = body.querySelectorAll(
        "input[type='checkbox'][data-skill-name]",
      );
      /** @type {string[]} */
      const enabled = [];
      cbs.forEach((el) => {
        if (
          el instanceof HTMLInputElement &&
          el.checked &&
          el.dataset.skillName
        ) {
          enabled.push(el.dataset.skillName);
        }
      });
      // Update loadedSkills locally with the new enabled state
      if (Array.isArray(loadedSkills)) {
        for (const skill of loadedSkills) {
          if (skill && typeof skill === "object") {
            const s = /** @type {Record<string, unknown>} */ (skill);
            const name = String(s.name || "");
            const isEnabled = enabled.includes(name);
            s.enabled = isEnabled;
            if (isEnabled) {
              const tok = typeof s.tokensEstimated === "number" ? s.tokensEstimated : 0;
              activatedSkillTokens.set(name, tok);
            }
          }
        }
      }
      saveSessionActivations();
      updateSessionMonitor({ stats: {} });
      closeSkillPicker();
      vscode.postMessage({
        type: "skill_picker_apply",
        enabledSkillNames: enabled,
      });
    });
  }
  const agentPickerCancel = document.getElementById("agent-picker-cancel");
  const agentPickerApply = document.getElementById("agent-picker-apply");
  if (agentPickerCancel) {
    agentPickerCancel.addEventListener("click", () => {
      closeAgentPicker();
      vscode.postMessage({ type: "agent_picker_cancel" });
    });
  }
  if (agentPickerApply) {
    agentPickerApply.addEventListener("click", () => {
      const body = document.getElementById("agent-picker-body");
      if (!body) return;
      const cbs = body.querySelectorAll("input[type='checkbox'][data-agent-name]");
      /** @type {string[]} */
      const enabled = [];
      cbs.forEach((el) => {
        if (el instanceof HTMLInputElement && el.checked && el.dataset.agentName) {
          enabled.push(el.dataset.agentName);
        }
      });
      // Update activatedAgentTokens for enabled agents
      const allRows = body.querySelectorAll("label.tool-picker-row");
      allRows.forEach((row) => {
        const cb = row.querySelector("input[data-agent-name]");
        if (cb instanceof HTMLInputElement && cb.dataset.agentName) {
          if (cb.checked) {
            // token from span text — we use the map if already seeded
            if (!activatedAgentTokens.has(cb.dataset.agentName)) {
              activatedAgentTokens.set(cb.dataset.agentName, 0);
            }
          }
        }
      });
      saveSessionActivations();
      updateSessionMonitor({ stats: {} });
      closeAgentPicker();
      vscode.postMessage({ type: "agent_picker_apply", enabledAgentNames: enabled });
    });
  }
  const modelPickerCancel = document.getElementById("model-picker-cancel");
  const modelPickerApply = document.getElementById("model-picker-apply");
  if (modelPickerCancel) {
    modelPickerCancel.addEventListener("click", () => {
      closeModelPicker();
      vscode.postMessage({ type: "model_picker_cancel" });
    });
  }
  if (modelPickerApply) {
    modelPickerApply.addEventListener("click", () => {
      applyModelPickerSelection();
    });
  }
}

if (inputEl) {
  inputEl.addEventListener("input", () => {
    syncInputHeight();
    updateSlashMenuFromInput();
  });
  // For text inserted from the extension (`paste_text`), we use `setRangeText` so
  // the change participates in the browser undo stack. Do not use stopPropagation
  // on mod+key in this webview: Electron/Cursor can fail to run the default action.
  inputEl.addEventListener("keydown", (e) => {
    const menuOpen =
      slashMenuEl && !slashMenuEl.hidden && slashFlatItems.length > 0;
    if (menuOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        hideSlashMenu();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashMenuActiveIndex = Math.min(
          slashMenuActiveIndex + 1,
          slashFlatItems.length - 1,
        );
        updateSlashActiveClass();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashMenuActiveIndex = Math.max(slashMenuActiveIndex - 1, 0);
        updateSlashActiveClass();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        applySlashAtIndex(slashMenuActiveIndex);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        applySlashAtIndex(slashMenuActiveIndex);
        return;
      }
    }
    if (e.key !== "Enter") return;
    if (e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (inputEl.disabled) return;
    commitChatInput();
  });
  inputEl.addEventListener("click", () => {
    updateSlashMenuFromInput();
  });
  inputEl.addEventListener("keyup", (e) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === "Escape") return;
    updateSlashMenuFromInput();
  });
}

if (formEl) {
  ["dragenter", "dragover"].forEach((ev) => {
    formEl.addEventListener(
      ev,
      (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        if (ev === "dragenter" && inputEl)
          inputEl.classList.add("input-drag-over");
      },
      false,
    );
  });
  formEl.addEventListener("dragleave", (e) => {
    if (e.currentTarget === formEl && e.target === formEl) {
      if (inputEl) inputEl.classList.remove("input-drag-over");
    }
  });
  formEl.addEventListener("dragend", () => {
    if (inputEl) inputEl.classList.remove("input-drag-over");
  });
  formEl.addEventListener("drop", (e) => {
    // The document-level capture handler processes the actual drop.
    // This handler only runs if stopPropagation was NOT called there (should not happen),
    // so just ensure visual state is cleared.
    if (inputEl) inputEl.classList.remove("input-drag-over");
  });
}

// Webview/Electron: allow file drops; prevent browser default (navigate / noop).
if (typeof document !== "undefined") {
  document.addEventListener(
    "dragover",
    (e) => {
      // Always prevent default so the webview never shows a "not allowed" cursor
      // and the drop event is guaranteed to fire regardless of the drag source
      // (VS Code Explorer, Finder, or other apps may use non-standard MIME types).
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    },
    true,
  );
  document.addEventListener(
    "drop",
    (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      e.preventDefault();
      // Stop propagation so the form bubble-phase handler does not also run.
      e.stopPropagation();
      if (inputEl) inputEl.classList.remove("input-drag-over");
      if (!inputEl || inputEl.disabled) return;
      void (async () => {
        const paths = await collectDropPathsFromDataTransferAsync(dt);
        if (paths.length > 0) {
          insertChipsForPaths(paths);
        } else {
          // The webview sandbox could not read file paths from the dataTransfer.
          // Fall back to the extension host file picker.
          vscode.postMessage({ type: "drop_request" });
        }
      })();
    },
    true,
  );
}

if (attachButton) {
  attachButton.addEventListener("click", () => {
    vscode.postMessage({ type: "drop_request" });
  });
}

if (exportChatButton) {
  exportChatButton.addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({ type: "export_conversation" });
  });
}

if (agentBrowserToggle) {
  // Browser button now launches a real Chrome instance with remote debugging
  // on port 9222 and a dedicated user-data-dir, instead of toggling the
  // agent_browser URL panel. The host runs the command detached so the
  // Chrome window keeps running even if the webview/extension is reloaded.
  agentBrowserToggle.addEventListener("click", () => {
    vscode.postMessage({ type: "launch_chrome_debug" });
  });
}

if (agentBrowserOpenButton) {
  agentBrowserOpenButton.addEventListener("click", submitAgentBrowserOpen);
}

if (agentBrowserCancelButton) {
  agentBrowserCancelButton.addEventListener("click", hideAgentBrowserPanel);
}

for (const el of [agentBrowserUrlInput, agentBrowserInstructionInput]) {
  el?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitAgentBrowserOpen();
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideAgentBrowserPanel();
    }
  });
}


// === MODULE: indicators ===
// Footer indicators for active model, profile, and workspace folder.

/**
 * Update the model indicator button next to the attach control. Hidden until
 * the host pushes a model. Click opens the same picker `/model` opens, but
 * without writing `/model` to the chat history.
 * @param {{ id: string, provider: string, name: string } | null | undefined} model
 */
function setModelIndicator(model) {
  if (!modelIndicatorEl || !modelIndicatorLabelEl) return;
  if (!model || typeof model !== "object" || !model.id) {
    modelIndicatorEl.hidden = true;
    modelIndicatorLabelEl.textContent = "—";
    modelIndicatorEl.removeAttribute("title");
    return;
  }
  modelIndicatorEl.hidden = false;
  modelIndicatorLabelEl.textContent = model.id;
  const provider = typeof model.provider === "string" ? model.provider : "";
  const name =
    typeof model.name === "string" && model.name ? model.name : model.id;
  const tip = provider
    ? `${name} — ${model.id} [${provider}]\nClick to change model`
    : `${name}\nClick to change model`;
  modelIndicatorEl.title = tip;
}

/**
 * Update the active profile indicator in the footer action bar.
 * @param {string | null | undefined} profile
 */
function setProfileIndicator(profile) {
  if (!profileIndicatorEl || !profileIndicatorLabelEl) return;
  if (typeof profile !== "string" || !profile) {
    profileIndicatorEl.hidden = true;
    profileIndicatorLabelEl.textContent = "—";
    profileIndicatorEl.removeAttribute("title");
    return;
  }
  profileIndicatorEl.hidden = false;
  profileIndicatorLabelEl.textContent = profile;
  profileIndicatorEl.title = `Active profile: ${profile}`;
}

if (modelIndicatorEl) {
  modelIndicatorEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: "open_model" });
  });
}

/**
 * Update the workspace indicator next to the model indicator. Mirrors the CLI footer
 * line `~/Documents/repositories/free-code (main)`: shows the workspace folder name and the
 * git branch when available, with the home-relative path in the tooltip. Hidden when no
 * workspace folder is open. Click opens host actions: open another folder, set free-code.cwd, or reveal in OS.
 * @param {{ path: string, displayPath: string, name: string, branch: string | null } | null | undefined} info
 */
function setWorkspaceIndicator(info) {
  if (!workspaceIndicatorEl || !workspaceIndicatorLabelEl) return;
  if (
    !info ||
    typeof info !== "object" ||
    typeof info.path !== "string" ||
    !info.path
  ) {
    workspaceIndicatorEl.hidden = true;
    workspaceIndicatorLabelEl.textContent = "—";
    workspaceIndicatorEl.removeAttribute("title");
    return;
  }
  const name =
    typeof info.name === "string" && info.name ? info.name : info.path;
  const branch =
    typeof info.branch === "string" && info.branch ? info.branch : "";
  const displayPath =
    typeof info.displayPath === "string" && info.displayPath
      ? info.displayPath
      : info.path;
  workspaceIndicatorEl.hidden = false;
  workspaceIndicatorLabelEl.textContent = branch ? `${name} (${branch})` : name;
  const tipPath = branch ? `${displayPath} (${branch})` : displayPath;
  workspaceIndicatorEl.title = `${tipPath}\nClick to change folder or reveal in OS`;
}

if (workspaceIndicatorEl) {
  workspaceIndicatorEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: "workspace_indicator_click" });
  });
}

/**
 * Update plan/agent mode badge above input.
 * @param {string | null | undefined} mode
 */
function setModeIndicator(mode) {
  if (!modeIndicatorBarEl || !modeIndicatorValueEl) return;
  const normalized = typeof mode === "string" ? mode.trim() : "";
  if (!normalized) {
    modeIndicatorBarEl.hidden = true;
    modeIndicatorValueEl.textContent = "agent";
    modeIndicatorBarEl.removeAttribute("data-mode");
    return;
  }
  const modeToken = normalized.split(/\s+/)[0]?.toLowerCase() || normalized.toLowerCase();
  modeIndicatorBarEl.hidden = false;
  modeIndicatorBarEl.dataset.mode = modeToken;
  modeIndicatorValueEl.textContent = normalized;
}


// === MODULE: session-monitor ===
// Session statistics panel (context usage, tool calls, tokens) and terminal panel events.

if (sessionMonitorCloseBtn) {
  sessionMonitorCloseBtn.addEventListener("click", () => {
    sessionMonitorStatsHoldActive = false;
    sessionMonitorStatsHoldDeadline = 0;
    if (sessionMonitorEl) sessionMonitorEl.hidden = true;
    vscode.postMessage({ type: "session_polling", enabled: false });
  });
}

const sessionMonitorLoadBtn = document.getElementById("session-monitor-load");
if (sessionMonitorLoadBtn) {
  sessionMonitorLoadBtn.addEventListener("click", () => {
    if (sessionMonitorLoadBtn.disabled) return;
    sessionMonitorLoadBtn.disabled = true;
    setSessionMonitorLoadingState();
    vscode.postMessage({ type: "request_session_stats" });
  });
}

function fmtNum(n) {
  if (typeof n !== "number" || isNaN(n)) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function setSessionMonitorLoadingState() {
  sessionMonitorStatsHoldActive = true;
  sessionMonitorStatsHoldDeadline = Date.now() + SESSION_MONITOR_STATS_HOLD_MS;
  const dataEl = document.getElementById("session-monitor-data");
  const waitEl = document.getElementById("session-monitor-wait");
  const waitTextEl = document.getElementById("session-monitor-wait-text");
  const loadBtn = document.getElementById("session-monitor-load");
  if (dataEl) dataEl.hidden = true;
  if (waitEl) waitEl.hidden = false;
  if (waitTextEl) {
    waitTextEl.textContent = SESSION_MONITOR_LOADING_TEXT;
  }
  if (loadBtn) {
    loadBtn.hidden = true;
    loadBtn.disabled = true;
  }
}

/**
 * @param {{ stats?: Record<string, unknown>; unavailable?: boolean; hint?: string; sessionId?: string }} message
 */
function updateSessionMonitor(message) {
  if (!sessionMonitorEl) return;

  const stats =
    message && message.stats && typeof message.stats === "object"
      ? message.stats
      : {};

  // Detect when session changes (different conversation) and save/restore accumulators
  const newSessionId = typeof stats.sessionId === "string" ? stats.sessionId : null;
  if (newSessionId && newSessionId !== currentSessionId) {
    if (currentSessionId) {
      sessionActivations.set(currentSessionId, { mcpTokens: activatedMcpTokens, skillTokens: activatedSkillTokens, agentTokens: activatedAgentTokens });
    }
    const saved = sessionActivations.get(newSessionId);
    if (saved) {
      activatedMcpTokens = saved.mcpTokens;
      activatedSkillTokens = saved.skillTokens;
      activatedAgentTokens = saved.agentTokens ?? new Map();
    } else {
      activatedMcpTokens = new Map();
      activatedSkillTokens = new Map();
      activatedAgentTokens = new Map();
    }
    currentSessionId = newSessionId;
    saveSessionActivations();
  }

  const dataEl = document.getElementById("session-monitor-data");
  const waitEl = document.getElementById("session-monitor-wait");
  const waitTextEl = document.getElementById("session-monitor-wait-text");
  const loadBtn = document.getElementById("session-monitor-load");
  const unavailable = message && message.unavailable === true;
  if (unavailable) {
    sessionMonitorStatsHoldActive = false;
    sessionMonitorStatsHoldDeadline = 0;
    if (dataEl) dataEl.hidden = true;
    if (waitEl) waitEl.hidden = false;
    if (waitTextEl) {
      const h =
        typeof message.hint === "string" && message.hint.trim()
          ? message.hint.trim()
          : "The free-code RPC agent is not connected. Click Load to start it and fetch live session stats.";
      waitTextEl.textContent = h;
    }
    if (loadBtn) {
      loadBtn.hidden = false;
      loadBtn.disabled = false;
    }
    return;
  }
  const tok = stats.tokens && typeof stats.tokens === "object" ? stats.tokens : {};
  const cu = stats.contextUsage && typeof stats.contextUsage === "object" ? stats.contextUsage : {};
  const pct = typeof cu.percent === "number" && !isNaN(cu.percent) ? cu.percent : null;
  const ctxTokens = typeof cu.tokens === "number" && !isNaN(cu.tokens) ? cu.tokens : null;
  const ctxWindow = typeof cu.contextWindow === "number" ? cu.contextWindow : 0;
  const totalMsg = typeof stats.totalMessages === "number" ? stats.totalMessages : 0;
  const toolCalls = typeof stats.toolCalls === "number" ? stats.toolCalls : 0;
  const tokIn = typeof tok.input === "number" ? tok.input : 0;
  const tokOut = typeof tok.output === "number" ? tok.output : 0;
  const cr = typeof tok.cacheRead === "number" ? tok.cacheRead : 0;
  const cw = typeof tok.cacheWrite === "number" ? tok.cacheWrite : 0;
  const cacheRW = Math.round(cw + cr * 0.1);
  const clampedPct =
    pct != null ? Math.min(100, Math.max(0, pct)) : 0;

  const trivialStats = totalMsg === 0 || tokOut === 0;
  const holdPending =
    sessionMonitorStatsHoldActive &&
    trivialStats &&
    Date.now() < sessionMonitorStatsHoldDeadline;

  if (holdPending) {
    if (waitEl) waitEl.hidden = false;
    if (dataEl) dataEl.hidden = true;
    if (waitTextEl) waitTextEl.textContent = SESSION_MONITOR_LOADING_TEXT;
    if (loadBtn) {
      loadBtn.hidden = true;
      loadBtn.disabled = true;
    }
  } else {
    if (sessionMonitorStatsHoldActive) {
      sessionMonitorStatsHoldActive = false;
    }
    if (waitEl) waitEl.hidden = true;
    if (dataEl) dataEl.hidden = false;
    if (loadBtn) {
      loadBtn.hidden = false;
      loadBtn.disabled = false;
    }
  }

  if (sessionCtxBar) {
    sessionCtxBar.style.width = clampedPct + "%";
    sessionCtxBar.className =
      "session-monitor-bar-fill" +
      (pct != null && pct >= 75
        ? " ctx-danger"
        : pct != null && pct >= 50
          ? " ctx-warn"
          : "");
  }
  if (sessionCtxText) {
    sessionCtxText.textContent = pct != null ? pct.toFixed(1) + "%" : "—";
    sessionCtxText.className =
      "session-monitor-context-pct" +
      (pct != null && pct >= 75
        ? " ctx-danger"
        : pct != null && pct >= 50
          ? " ctx-warn"
          : "");
  }
  if (sessionMsgTotal) sessionMsgTotal.textContent = fmtNum(totalMsg);
  if (sessionToolCalls) sessionToolCalls.textContent = fmtNum(toolCalls);

  // Calculate total tokens for MCPs ever activated — refresh from toolGroups when available
  let mcpTokensTotal = 0;
  if (Array.isArray(toolGroups) && toolGroups.length > 0) {
    for (const group of toolGroups) {
      if (group && typeof group === "object") {
        const g = /** @type {Record<string, unknown>} */ (group);
        const key = String(g.key || "");
        if (activatedMcpTokens.has(key)) {
          const tokens = typeof g.tokensEstimated === "number" ? g.tokensEstimated : 0;
          activatedMcpTokens.set(key, tokens);
          mcpTokensTotal += tokens;
        }
      }
    }
  } else {
    for (const tokens of activatedMcpTokens.values()) mcpTokensTotal += tokens;
  }
  if (sessionMcpTools) sessionMcpTools.textContent = mcpTokensTotal > 0 ? "~" + fmtNum(mcpTokensTotal) : "0";

  // Calculate total tokens for skills ever activated — refresh from loadedSkills when available
  let skillsTokensTotal = 0;
  if (Array.isArray(loadedSkills) && loadedSkills.length > 0) {
    for (const skill of loadedSkills) {
      if (skill && typeof skill === "object") {
        const s = /** @type {Record<string, unknown>} */ (skill);
        const name = String(s.name || "");
        if (activatedSkillTokens.has(name)) {
          const tokens = typeof s.tokensEstimated === "number" ? s.tokensEstimated : 0;
          activatedSkillTokens.set(name, tokens);
          skillsTokensTotal += tokens;
        }
      }
    }
  } else {
    for (const tokens of activatedSkillTokens.values()) skillsTokensTotal += tokens;
  }
  if (sessionSkills) sessionSkills.textContent = skillsTokensTotal > 0 ? "~" + fmtNum(skillsTokensTotal) : "0";

  // Calculate total tokens for agents ever activated
  let agentsTokensTotal = 0;
  for (const tokens of activatedAgentTokens.values()) agentsTokensTotal += tokens;
  if (sessionAgents) sessionAgents.textContent = agentsTokensTotal > 0 ? "~" + fmtNum(agentsTokensTotal) : "0";

  // Update context window total
  const ctxWindowDisplay = ctxWindow > 0 ? fmtNum(ctxWindow) : "200k";
  const ctxTotalEl = document.getElementById("session-ctx-total");
  if (ctxTotalEl) {
    const ctxDisplay = ctxTokens != null ? ctxTokens : 0;
    ctxTotalEl.textContent = (ctxDisplay > 0 ? fmtNum(ctxDisplay) : "0") + " / " + ctxWindowDisplay;
  }

  if (sessionCtxDetail) {
    if (ctxWindow > 0 && ctxTokens != null) {
      sessionCtxDetail.textContent =
        fmtNum(ctxTokens) + " / " + fmtNum(ctxWindow) + " tokens";
    } else if (ctxWindow > 0 && ctxTokens === null) {
      sessionCtxDetail.textContent = "unknown until next model response";
    } else {
      sessionCtxDetail.textContent = "";
    }
  }
}

if (terminalPopoutBtn) {
  terminalPopoutBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "terminal_detach" });
  });
}
if (terminalClearBtn) {
  terminalClearBtn.addEventListener("click", () => {
    if (terminalOutputEl) terminalOutputEl.textContent = "";
  });
}
if (terminalCloseBtn && terminalPanelEl) {
  terminalCloseBtn.addEventListener("click", () => {
    terminalPanelEl.hidden = true;
  });
}
if (terminalInputEl) {
  terminalInputEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const cmd = terminalInputEl.value.trim();
    terminalInputEl.value = "";
    if (!cmd) return;
    vscode.postMessage({ type: "terminal_exec", command: cmd });
  });
}


// === MODULE: events ===
// Input drag-to-resize, Escape abort, webview_ready signal, and zoom restore.

// ===== Input drag-to-resize =====
(function initInputDragHandle() {
  const handle = document.getElementById("input-drag-handle");
  if (!handle || !inputEl) return;
  let startY = 0;
  let startH = 0;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = inputEl.offsetHeight;
    handle.classList.add("dragging");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  function onMove(e) {
    const delta = startY - e.clientY;
    const newH = Math.max(60, Math.min(startH + delta, window.innerHeight * 0.6));
    inputManualHeight = newH;
    inputEl.style.height = `${newH}px`;
    inputEl.style.overflowY = "auto";
  }

  function onUp() {
    handle.classList.remove("dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (inputManualHeight <= 80) {
      inputManualHeight = 0;
      inputEl.style.height = "";
      inputEl.style.overflowY = "";
      syncInputHeight();
    }
  }
})();

// Escape key aborts the running agent. Modals (tool-picker, model-picker, skill-picker)
// use capture phase + stopPropagation so they take priority when open. The slash-menu
// Escape is on inputEl (bubble phase). We also fire abort even when `isBusy` is false:
// the UI can drift out of sync with the backend (e.g. "Agent is already processing"
// error path emits busy:false while the backend may still be streaming). The backend
// abort is idempotent and a no-op when nothing is running.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  abortAgent();
});

vscode.postMessage({ type: "webview_ready" });
requestAnimationFrame(() => {
  try {
    const z = readMigratedLocalStorage(FREE_CODE_UI_ZOOM_KEY, LEGACY_UI_ZOOM_KEY);
    if (z) {
      const n = Number.parseFloat(z);
      if (!Number.isNaN(n) && n >= 0.6 && n <= 2) {
        document.documentElement.style.setProperty(FREE_CODE_ZOOM_CSS_VAR, String(n));
      }
    }
  } catch {
    /* ignore */
  }
  ensureInputBaseMinH();
  syncInputHeight();
  syncSendOrStopButton();
});

// === MODULE: theme ===
// Light/dark theme toggle. Only active in FreeCodeMac (WKWebView) — in the
// VS Code webview the IDE controls theme variables so we hide the button.

const themeBtnEl = document.getElementById("theme-toggle");
const isFreeCodeMac = !!window.webkit?.messageHandlers?.freeCodeBridge;

if (!isFreeCodeMac) {
  // Running inside VS Code: theme is owned by the IDE, hide the button.
  if (themeBtnEl) themeBtnEl.hidden = true;
} else {
  const THEME_KEY = "free-code-theme";
  const LEGACY_THEME_KEY = "edo-theme";

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (themeBtnEl) {
      themeBtnEl.textContent = theme === "light" ? "☾" : "☀";
      themeBtnEl.title = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
      themeBtnEl.setAttribute("aria-label", themeBtnEl.title);
    }
  }

  // Restore persisted theme on load
  try {
    const saved = readMigratedLocalStorage(THEME_KEY, LEGACY_THEME_KEY);
    if (saved === "light" || saved === "dark") applyTheme(saved);
  } catch { /* ignore */ }

  themeBtnEl?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    writeLocalStorage(THEME_KEY, next);
  });
}
