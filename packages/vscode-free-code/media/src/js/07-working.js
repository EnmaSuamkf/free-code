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

