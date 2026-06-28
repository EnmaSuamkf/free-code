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
