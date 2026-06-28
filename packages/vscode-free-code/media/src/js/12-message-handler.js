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
