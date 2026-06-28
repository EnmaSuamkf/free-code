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
