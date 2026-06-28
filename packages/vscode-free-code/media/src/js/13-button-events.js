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

