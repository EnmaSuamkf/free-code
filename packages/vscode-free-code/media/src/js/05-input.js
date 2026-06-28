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
