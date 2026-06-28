// === MODULE: slash-menu ===
// Slash command autocomplete: context detection, filtering, rendering, selection.


/**
 * @param {string} value
 * @param {number} cursor
 * @returns {{ start: number, end: number, query: string } | null}
 */
function getSlashContext(value, cursor) {
  const before = value.slice(0, cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const col = before.slice(lineStart);
  const leftTrimmed = col.trimStart();
  if (!leftTrimmed.startsWith("/")) return null;
  const slashIdx = col.length - leftTrimmed.length;
  const token = col.slice(slashIdx);
  return {
    start: lineStart + slashIdx,
    end: cursor,
    query: token.slice(1).toLowerCase(),
  };
}

/**
 * @param {string} query
 */
function getFilteredSlashItems(query) {
  const q = (query || "").toLowerCase();
  const spaceIdx = q.indexOf(" ");
  if (spaceIdx !== -1) {
    const commandName = q.slice(0, spaceIdx).trim();
    const argumentPrefix = q.slice(spaceIdx + 1).trimStart();
    if (!commandName) return { commands: [], skills: [] };
    const baseSlash = `/${commandName}`;
    const baseCommand = slashCommandItems.find(
      (item) => item.slash.toLowerCase() === baseSlash,
    );
    if (!baseCommand) return { commands: [], skills: [] };
    const derived = deriveSubcommandsFromDescription(baseCommand);
    const argScore = (item) => {
      const full = item.slash.toLowerCase();
      const basePrefix = `${baseSlash} `;
      if (!full.startsWith(basePrefix)) return Number.POSITIVE_INFINITY;
      const suffix = full.slice(basePrefix.length);
      if (!argumentPrefix) return 0;
      if (suffix.startsWith(argumentPrefix)) return 1;
      if (suffix.includes(argumentPrefix)) return 2;
      if (
        item.description &&
        item.description.toLowerCase().includes(argumentPrefix)
      )
        return 3;
      return Number.POSITIVE_INFINITY;
    };
    const commands = derived
      .map((item) => ({ item, score: argScore(item) }))
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) =>
        a.score !== b.score
          ? a.score - b.score
          : a.item.slash.localeCompare(b.item.slash),
      )
      .map((row) => row.item);
    return { commands, skills: [] };
  }
  const score = (item) => {
    if (!q) return 0;
    const rest = item.slash.slice(1).toLowerCase();
    if (rest.startsWith(`${q} `)) return 0;
    if (rest.startsWith(q)) return 1;
    if (rest === q) return 2;
    if (
      rest.includes(q) ||
      (item.description && item.description.toLowerCase().includes(q))
    )
      return 3;
    return Number.POSITIVE_INFINITY;
  };
  const filter = (items) => {
    const matched = items
      .map((it) => ({ it, s: score(it) }))
      .filter((row) => Number.isFinite(row.s));
    if (!q) return matched.map((row) => row.it);
    matched.sort((a, b) => {
      if (a.s !== b.s) return a.s - b.s;
      return a.it.slash.localeCompare(b.it.slash);
    });
    return matched.map((row) => row.it);
  };
  return {
    commands: filter(slashCommandItems),
    skills: filter(slashSkillItems),
  };
}

/**
 * @param {{ label: string, slash: string, description: string }} item
 * @returns {{ label: string, slash: string, description: string }[]}
 */
function deriveSubcommandsFromDescription(item) {
  if (!item || typeof item.slash !== "string" || item.slash[0] !== "/")
    return [];
  const desc = typeof item.description === "string" ? item.description : "";
  if (!desc || desc.indexOf("|") === -1) return [];
  const base = item.slash.trim();
  const fragments = desc
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  /** @type {{ label: string, slash: string, description: string }[]} */
  const out = [];
  for (const fragment of fragments) {
    let candidate = fragment.replace(/^[\u2022\-*]\s*/, "").trim();
    if (!candidate) continue;
    const colonIdx = candidate.indexOf(":");
    if (colonIdx !== -1 && candidate.slice(0, colonIdx).indexOf("/") === -1) {
      candidate = candidate.slice(colonIdx + 1).trim();
    }
    if (!candidate) continue;
    candidate = candidate.split(/\.\s/)[0].trim();
    if (!candidate) continue;
    const placeholderHint = /<[^>]+>|\[[^\]]+\]/.test(candidate);
    if (candidate.startsWith("/")) {
      const m = candidate.match(
        /^\/[a-z0-9:_-]+(?:\s+[a-z0-9:_-]+)?(?:\s*(?:<[^>]+>|\[[^\]]+\]))?/i,
      );
      if (!m) continue;
      candidate = m[0].trim();
    } else {
      const m = candidate.match(/^[a-z0-9:_-]+(?:\s*(?:<[^>]+>|\[[^\]]+\]))?/i);
      if (!m) continue;
      candidate = `${base} ${m[0].trim()}`;
    }
    if (!candidate.startsWith(`${base} `)) continue;
    let clean = candidate
      .replace(/\s*(<[^>]+>|\[[^\]]+\])/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean || clean === base) continue;
    const slash = placeholderHint ? `${clean} ` : clean;
    out.push({
      slash,
      label: clean,
      description: `Subcommand of ${base}`,
    });
  }
  return out;
}

function hideSlashMenu() {
  slashMenuContext = null;
  if (slashMenuEl) {
    slashMenuEl.hidden = true;
    slashMenuEl.textContent = "";
  }
  slashFlatItems = [];
}

/**
 * @param {{ label: string, slash: string, description: string }} item
 * @param {number} index
 */
function createSlashItemButton(item, index) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "slash-menu-item";
  btn.dataset.index = String(index);
  const lab = document.createElement("span");
  lab.className = "slash-menu-label";
  lab.textContent = item.label;
  btn.appendChild(lab);
  if (item.description) {
    const d = document.createElement("div");
    d.className = "slash-menu-desc";
    d.textContent = item.description;
    btn.appendChild(d);
  }
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applySlashAtIndex(index);
  });
  return btn;
}

function updateSlashActiveClass() {
  if (!slashMenuEl) return;
  const buttons = slashMenuEl.querySelectorAll(".slash-menu-item");
  buttons.forEach((btn, i) => {
    btn.classList.toggle("slash-menu-item-active", i === slashMenuActiveIndex);
  });
  const active = buttons[slashMenuActiveIndex];
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest" });
  }
}

function renderSlashMenu() {
  if (!slashMenuEl || !slashMenuContext) return;
  const { query } = slashMenuContext;
  const { commands, skills } = getFilteredSlashItems(query);
  slashFlatItems = [];
  slashMenuEl.textContent = "";
  if (commands.length === 0 && skills.length === 0) {
    slashMenuEl.hidden = true;
    return;
  }
  if (commands.length > 0) {
    const h = document.createElement("div");
    h.className = "slash-menu-heading";
    h.textContent = "Commands";
    slashMenuEl.appendChild(h);
    for (const it of commands) {
      const idx = slashFlatItems.length;
      slashFlatItems.push(it);
      slashMenuEl.appendChild(createSlashItemButton(it, idx));
    }
  }
  if (skills.length > 0) {
    const h = document.createElement("div");
    h.className = "slash-menu-heading";
    h.textContent = "Skills";
    slashMenuEl.appendChild(h);
    for (const it of skills) {
      const idx = slashFlatItems.length;
      slashFlatItems.push(it);
      slashMenuEl.appendChild(createSlashItemButton(it, idx));
    }
  }
  slashMenuActiveIndex = Math.min(
    Math.max(0, slashMenuActiveIndex),
    slashFlatItems.length - 1,
  );
  updateSlashActiveClass();
  slashMenuEl.hidden = false;
}

/**
 * @param {number} index
 */
function applySlashAtIndex(index) {
  const it = slashFlatItems[index];
  if (!it || !inputEl || !slashMenuContext) return;
  const before = inputEl.value.slice(0, slashMenuContext.start);
  const after = inputEl.value.slice(slashMenuContext.end);
  const insertion = it.slash;
  inputEl.value = before + insertion + after;
  const pos = before.length + insertion.length;
  inputEl.setSelectionRange(pos, pos);
  hideSlashMenu();
  syncInputHeight();
}

function updateSlashMenuFromInput() {
  if (!inputEl || !slashMenuEl) return;
  const v = inputEl.value;
  const c = inputEl.selectionStart ?? v.length;
  const ctx = getSlashContext(v, c);
  if (!ctx) {
    hideSlashMenu();
    return;
  }
  const queryChanged =
    !slashMenuContext || ctx.query !== slashMenuContext.query;
  slashMenuContext = ctx;
  if (slashCommandItems.length === 0 && slashSkillItems.length === 0) {
    vscode.postMessage({ type: "request_slash_commands" });
  }
  if (queryChanged) {
    slashMenuActiveIndex = 0;
  }
  renderSlashMenu();
}
