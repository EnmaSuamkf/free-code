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
