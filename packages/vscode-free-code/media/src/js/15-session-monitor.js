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

