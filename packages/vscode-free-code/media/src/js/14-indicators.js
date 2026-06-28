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

