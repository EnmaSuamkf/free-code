// === MODULE: pickers ===
// Tool, skill, model, and agent picker modals.

/**
 * @param {Record<string, unknown>} state
 */
function openToolPicker(state) {
  const modal = document.getElementById("tool-picker-modal");
  const body = document.getElementById("tool-picker-body");
  if (!modal || !body) return;
  body.textContent = "";
  const groups = Array.isArray(state.groups) ? state.groups : [];
  // Store tool groups globally for session monitor
  toolGroups = groups;
  // Seed activatedMcpTokens with any groups already enabled (e.g. after reloading)
  let mcpSeeded = false;
  for (const g of groups) {
    if (g && typeof g === "object") {
      const o = /** @type {Record<string, unknown>} */ (g);
      if (o.enabled === true && typeof o.key === "string" && o.key) {
        const tok = typeof o.tokensEstimated === "number" ? o.tokensEstimated : 0;
        activatedMcpTokens.set(o.key, tok);
        mcpSeeded = true;
      }
    }
  }
  if (mcpSeeded) saveSessionActivations();
  if (groups.length === 0) {
    const p = document.createElement("p");
    p.className = "tool-picker-hint tool-picker-empty";
    p.textContent =
      "No optional tool groups in this session (e.g. embedded agent with --no-extensions). See /tools.";
    body.appendChild(p);
  }
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (g);
    const key = typeof o.key === "string" ? o.key : "";
    const row = document.createElement("label");
    row.className = "tool-picker-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = o.enabled === true;
    cb.dataset.groupKey = key;
    const span = document.createElement("span");
    const tc = typeof o.toolCount === "number" ? o.toolCount : 0;
    const te = typeof o.tokensEstimated === "number" ? o.tokensEstimated : 0;
    span.textContent = `${key} (${tc} tools, ~${te} tok est.)`;
    row.appendChild(cb);
    row.appendChild(span);
    body.appendChild(row);
  }
  ensureToolPickerGlobalHandlers();
  modal.style.display = "flex";
  modal.hidden = false;
}

function closeToolPicker() {
  const modal = document.getElementById("tool-picker-modal");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
}

/**
 * Skill picker modal (RPC get_skill_picker_state / set_skill_picker), same styling as tool groups.
 * @param {Record<string, unknown>} state
 */
function openSkillPicker(state) {
  const modal = document.getElementById("skill-picker-modal");
  const hintEl = document.getElementById("skill-picker-hint");
  const body = document.getElementById("skill-picker-body");
  if (!modal || !body) return;
  body.textContent = "";
  const hint =
    state &&
    typeof state === "object" &&
    typeof (/** @type {Record<string, unknown>} */ (state).hint) === "string"
      ? String(/** @type {Record<string, unknown>} */ (state).hint)
      : "Skills merged into the system prompt. Toggle entries to omit skill XML blocks from prompts sent to the model.";
  if (hintEl) hintEl.textContent = hint;
  const skills = Array.isArray(state.skills) ? state.skills : [];
  // Store skills globally for session monitor
  loadedSkills = skills;
  // Seed activatedSkillTokens with any skills already enabled (e.g. after reloading)
  let skillSeeded = false;
  for (const raw of skills) {
    if (raw && typeof raw === "object") {
      const s = /** @type {Record<string, unknown>} */ (raw);
      if (s.enabled === true && typeof s.name === "string" && s.name) {
        const tok = typeof s.tokensEstimated === "number" ? s.tokensEstimated : 0;
        activatedSkillTokens.set(s.name, tok);
        skillSeeded = true;
      }
    }
  }
  if (skillSeeded) saveSessionActivations();
  if (skills.length === 0) {
    const p = document.createElement("p");
    p.className = "tool-picker-hint tool-picker-empty";
    p.textContent = "No skills in this session system prompt.";
    body.appendChild(p);
  }
  for (const raw of skills) {
    if (!raw || typeof raw !== "object") continue;
    const s = /** @type {Record<string, unknown>} */ (raw);
    const name = typeof s.name === "string" ? s.name : "";
    if (!name) continue;
    const desc = typeof s.description === "string" ? s.description : "";
    const tok =
      typeof s.tokensEstimated === "number" && !Number.isNaN(s.tokensEstimated)
        ? s.tokensEstimated
        : 0;
    const row = document.createElement("label");
    row.className = "tool-picker-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s.enabled === true;
    cb.dataset.skillName = name;
    const span = document.createElement("span");
    const line =
      desc.length > 0
        ? `${name} (~${tok} tok est.) \u2014 ${desc}`
        : `${name} (~${tok} tok est.)`;
    span.textContent = line.length > 220 ? `${line.slice(0, 217)}\u2026` : line;
    if (line.length > 220) row.title = line;
    row.appendChild(cb);
    row.appendChild(span);
    body.appendChild(row);
  }
  ensureSkillPickerGlobalHandlers();
  modal.style.display = "flex";
  modal.hidden = false;
}

/**
 * Single-select model picker. Mirrors the CLI `/model` selector: a list of
 * `<id> [provider]` rows with a ✓ on the currently active model, plus a
 * filter input that matches against id, provider, and name. Click a row or
 * hit Enter on the highlighted row to apply (sends `model_picker_apply`).
 * @typedef {{ id: string, name: string, provider: string }} ModelInfo
 */

/** @type {ModelInfo[]} */
let modelPickerAll = [];
/** @type {ModelInfo[]} */
let modelPickerFiltered = [];
let modelPickerActiveIndex = 0;
/** @type {{ provider: string, id: string } | null} */
let modelPickerCurrent = null;

/**
 * @param {Record<string, unknown>} state shape: { models: ModelInfo[], current?: { provider, id } }
 */
function openModelPicker(state) {
  const modal = document.getElementById("model-picker-modal");
  const body = document.getElementById("model-picker-body");
  const search = /** @type {HTMLInputElement|null} */ (
    document.getElementById("model-picker-search")
  );
  if (!modal || !body) return;
  const rawModels = Array.isArray(state.models) ? state.models : [];
  /** @type {ModelInfo[]} */
  const models = [];
  for (const m of rawModels) {
    if (!m || typeof m !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (m);
    const id = typeof o.id === "string" ? o.id : "";
    const provider = typeof o.provider === "string" ? o.provider : "";
    const name = typeof o.name === "string" ? o.name : id;
    if (!id || !provider) continue;
    models.push({ id, name, provider });
  }
  const cur =
    state.current && typeof state.current === "object"
      ? /** @type {Record<string, unknown>} */ (state.current)
      : null;
  modelPickerCurrent =
    cur && typeof cur.provider === "string" && typeof cur.id === "string"
      ? { provider: cur.provider, id: cur.id }
      : null;
  models.sort((a, b) => {
    const aCur =
      modelPickerCurrent &&
      a.provider === modelPickerCurrent.provider &&
      a.id === modelPickerCurrent.id;
    const bCur =
      modelPickerCurrent &&
      b.provider === modelPickerCurrent.provider &&
      b.id === modelPickerCurrent.id;
    if (aCur && !bCur) return -1;
    if (!aCur && bCur) return 1;
    const byProv = a.provider.localeCompare(b.provider);
    if (byProv !== 0) return byProv;
    return a.id.localeCompare(b.id);
  });
  modelPickerAll = models;
  modelPickerFiltered = models;
  modelPickerActiveIndex = 0;
  if (search) search.value = "";
  renderModelPickerList();
  ensureModelPickerGlobalHandlers();
  modal.style.display = "flex";
  modal.hidden = false;
  if (search) {
    setTimeout(() => search.focus(), 0);
  }
}

function closeModelPicker() {
  const modal = document.getElementById("model-picker-modal");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
}

/**
 * @param {string} query
 */
function filterModelPicker(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    modelPickerFiltered = modelPickerAll;
  } else {
    modelPickerFiltered = modelPickerAll.filter((m) => {
      const hay =
        `${m.id} ${m.provider} ${m.provider}/${m.id} ${m.name}`.toLowerCase();
      return hay.includes(q);
    });
  }
  modelPickerActiveIndex = 0;
  renderModelPickerList();
}

function renderModelPickerList() {
  const body = document.getElementById("model-picker-body");
  const currentEl = document.getElementById("model-picker-current");
  if (!body) return;
  body.textContent = "";
  if (modelPickerFiltered.length === 0) {
    const p = document.createElement("p");
    p.className = "tool-picker-hint tool-picker-empty";
    p.textContent = "No matching models.";
    body.appendChild(p);
    if (currentEl) currentEl.textContent = "";
    return;
  }
  for (let i = 0; i < modelPickerFiltered.length; i++) {
    const m = modelPickerFiltered[i];
    const isCurrent =
      !!modelPickerCurrent &&
      m.provider === modelPickerCurrent.provider &&
      m.id === modelPickerCurrent.id;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "model-picker-row";
    if (i === modelPickerActiveIndex)
      row.classList.add("model-picker-row-active");
    if (isCurrent) row.classList.add("model-picker-row-current");
    row.dataset.index = String(i);
    const idSpan = document.createElement("span");
    idSpan.className = "model-picker-id";
    idSpan.textContent = m.id;
    row.appendChild(idSpan);
    const provSpan = document.createElement("span");
    provSpan.className = "model-picker-provider";
    provSpan.textContent = `[${m.provider}]`;
    row.appendChild(provSpan);
    if (isCurrent) {
      const check = document.createElement("span");
      check.className = "model-picker-check";
      check.textContent = "\u2713";
      row.appendChild(check);
    }
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      modelPickerActiveIndex = i;
      applyModelPickerSelection();
    });
    row.addEventListener("mouseenter", () => {
      modelPickerActiveIndex = i;
      updateModelPickerActiveClass();
      updateModelPickerCurrentLabel();
    });
    body.appendChild(row);
  }
  updateModelPickerCurrentLabel();
}

function updateModelPickerActiveClass() {
  const body = document.getElementById("model-picker-body");
  if (!body) return;
  const rows = body.querySelectorAll(".model-picker-row");
  rows.forEach((row, i) => {
    row.classList.toggle(
      "model-picker-row-active",
      i === modelPickerActiveIndex,
    );
  });
  const active = rows[modelPickerActiveIndex];
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest" });
  }
}

function updateModelPickerCurrentLabel() {
  const currentEl = document.getElementById("model-picker-current");
  if (!currentEl) return;
  const sel = modelPickerFiltered[modelPickerActiveIndex];
  if (!sel) {
    currentEl.textContent = "";
    return;
  }
  currentEl.textContent = `Model Name: ${sel.name}`;
}

function applyModelPickerSelection() {
  const sel = modelPickerFiltered[modelPickerActiveIndex];
  if (!sel) return;
  closeModelPicker();
  vscode.postMessage({
    type: "model_picker_apply",
    provider: sel.provider,
    modelId: sel.id,
  });
}

let modelPickerGlobalHandlersBound = false;
function ensureModelPickerGlobalHandlers() {
  if (modelPickerGlobalHandlersBound) return;
  modelPickerGlobalHandlersBound = true;
  const modal = document.getElementById("model-picker-modal");
  const search = /** @type {HTMLInputElement|null} */ (
    document.getElementById("model-picker-search")
  );
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeModelPicker();
        vscode.postMessage({ type: "model_picker_cancel" });
      }
    });
  }
  if (search) {
    search.addEventListener("input", () => {
      filterModelPicker(search.value);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (modelPickerFiltered.length === 0) return;
        modelPickerActiveIndex = Math.min(
          modelPickerActiveIndex + 1,
          modelPickerFiltered.length - 1,
        );
        updateModelPickerActiveClass();
        updateModelPickerCurrentLabel();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (modelPickerFiltered.length === 0) return;
        modelPickerActiveIndex = Math.max(modelPickerActiveIndex - 1, 0);
        updateModelPickerActiveClass();
        updateModelPickerCurrentLabel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        applyModelPickerSelection();
        return;
      }
    });
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const m = document.getElementById("model-picker-modal");
      if (!m || m.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      closeModelPicker();
      vscode.postMessage({ type: "model_picker_cancel" });
    },
    true,
  );
}

function closeSkillPicker() {
  const modal = document.getElementById("skill-picker-modal");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
}

/** @param {Record<string, unknown>} state */
function openAgentPicker(state) {
  const modal = document.getElementById("agent-picker-modal");
  const body = document.getElementById("agent-picker-body");
  if (!modal || !body) return;
  body.textContent = "";
  const agents = Array.isArray(state.agents) ? state.agents : [];
  // Seed activatedAgentTokens with enabled agents
  let agentSeeded = false;
  for (const raw of agents) {
    if (raw && typeof raw === "object") {
      const a = /** @type {Record<string, unknown>} */ (raw);
      if (a.enabled === true && typeof a.name === "string" && a.name) {
        const tok = typeof a.tokensEstimated === "number" ? a.tokensEstimated : 0;
        activatedAgentTokens.set(a.name, tok);
        agentSeeded = true;
      }
    }
  }
  if (agentSeeded) saveSessionActivations();
  if (agents.length === 0) {
    const p = document.createElement("p");
    p.className = "tool-picker-hint tool-picker-empty";
    p.textContent = "No agents found in ~/.free-code/agents/.";
    body.appendChild(p);
  }
  for (const raw of agents) {
    if (!raw || typeof raw !== "object") continue;
    const a = /** @type {Record<string, unknown>} */ (raw);
    const name = typeof a.name === "string" ? a.name : "";
    if (!name) continue;
    const desc = typeof a.description === "string" ? a.description : "";
    const tok = typeof a.tokensEstimated === "number" && !Number.isNaN(a.tokensEstimated) ? a.tokensEstimated : 0;
    const row = document.createElement("label");
    row.className = "tool-picker-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = a.enabled === true;
    cb.dataset.agentName = name;
    const span = document.createElement("span");
    const line = desc.length > 0 ? `${name} (~${tok} tok est.) — ${desc}` : `${name} (~${tok} tok est.)`;
    span.textContent = line.length > 220 ? `${line.slice(0, 217)}…` : line;
    if (line.length > 220) row.title = line;
    row.appendChild(cb);
    row.appendChild(span);
    body.appendChild(row);
  }
  ensureAgentPickerGlobalHandlers();
  modal.style.display = "flex";
  modal.hidden = false;
}

function closeAgentPicker() {
  const modal = document.getElementById("agent-picker-modal");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
}

let agentPickerGlobalHandlersBound = false;
function ensureAgentPickerGlobalHandlers() {
  if (agentPickerGlobalHandlersBound) return;
  agentPickerGlobalHandlersBound = true;
  const modal = document.getElementById("agent-picker-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeAgentPicker();
        vscode.postMessage({ type: "agent_picker_cancel" });
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const m = document.getElementById("agent-picker-modal");
    if (!m || m.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    closeAgentPicker();
    vscode.postMessage({ type: "agent_picker_cancel" });
  });
}

let skillPickerGlobalHandlersBound = false;
function ensureSkillPickerGlobalHandlers() {
  if (skillPickerGlobalHandlersBound) return;
  skillPickerGlobalHandlersBound = true;
  const modal = document.getElementById("skill-picker-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeSkillPicker();
        vscode.postMessage({ type: "skill_picker_cancel" });
      }
    });
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const m = document.getElementById("skill-picker-modal");
      if (!m || m.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      closeSkillPicker();
      vscode.postMessage({ type: "skill_picker_cancel" });
    },
    true,
  );
}

let toolPickerGlobalHandlersBound = false;
function ensureToolPickerGlobalHandlers() {
  if (toolPickerGlobalHandlersBound) return;
  toolPickerGlobalHandlersBound = true;
  const modal = document.getElementById("tool-picker-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeToolPicker();
        vscode.postMessage({ type: "tool_picker_cancel" });
      }
    });
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const m = document.getElementById("tool-picker-modal");
      if (!m || m.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      closeToolPicker();
      vscode.postMessage({ type: "tool_picker_cancel" });
    },
    true,
  );
}
