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
