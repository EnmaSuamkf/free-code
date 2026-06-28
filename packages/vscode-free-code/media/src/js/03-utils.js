// === MODULE: utils ===
// Zoom, terminal output, file URI conversion, drag-drop collection, clearChips.


const FREE_CODE_ZOOM_CSS_VAR = "--free-code-zoom";
const FREE_CODE_UI_ZOOM_KEY = "free_code_mac_ui_zoom";
const LEGACY_UI_ZOOM_KEY = "edo_mac_ui_zoom";

function getFreeCodeZoom() {
  const raw = document.documentElement.style.getPropertyValue(FREE_CODE_ZOOM_CSS_VAR).trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 1;
}

function setFreeCodeZoom(value) {
  const v = Math.min(2, Math.max(0.6, value));
  document.documentElement.style.setProperty(FREE_CODE_ZOOM_CSS_VAR, String(v));
  writeLocalStorage(FREE_CODE_UI_ZOOM_KEY, String(v));
}

function appendTerminalOutput(text) {
  if (!terminalOutputEl || typeof text !== "string") return;
  const line = document.createElement("div");
  line.className = "terminal-line";
  line.textContent = text.endsWith("\n") ? text.slice(0, -1) : text;
  terminalOutputEl.appendChild(line);
  terminalOutputEl.scrollTop = terminalOutputEl.scrollHeight;
}

function appendTerminalError(text) {
  if (!terminalOutputEl || typeof text !== "string") return;
  const line = document.createElement("div");
  line.className = "terminal-line terminal-line-err";
  line.textContent = text.endsWith("\n") ? text.slice(0, -1) : text;
  terminalOutputEl.appendChild(line);
  terminalOutputEl.scrollTop = terminalOutputEl.scrollHeight;
}

/**
 * @typedef {{
 *   row: HTMLDetailsElement,
 *   toolName: string,
 *   label: HTMLSpanElement,
 *   statusDot: HTMLSpanElement,
 *   resultHost: HTMLDivElement,
 *   hasResult: boolean,
 * }} ToolEntry
 */

/**
 * @param {string} uri
 * @returns {string}
 */
function fileUriToFsPath(uri) {
  const t = uri.trim();
  if (!t) return t;

  // VS Code webview resource URIs (old scheme: vscode-resource:///path,
  // new CDN scheme: https://file+.vscode-resource.vscode-cdn.net/path)
  if (
    t.startsWith("vscode-resource:") ||
    t.startsWith("https://file+.vscode-resource.")
  ) {
    try {
      const u = new URL(t);
      let p = decodeURIComponent(u.pathname);
      // Windows: /C:/path → C:/path
      if (p.length >= 3 && p[0] === "/" && p[2] === ":") p = p.slice(1);
      return p;
    } catch {
      // Fallback: strip scheme + leading slashes
      const stripped = t
        .replace(/^vscode-resource:\/+/, "/")
        .replace(/^https:\/\/[^/]+/, "");
      try {
        return decodeURIComponent(stripped);
      } catch {
        return stripped;
      }
    }
  }

  if (!t.startsWith("file:")) {
    if (t.startsWith("/")) {
      try {
        return decodeURIComponent(t);
      } catch {
        return t;
      }
    }
    return t;
  }
  let pathname;
  try {
    const u = new URL(t);
    pathname = u.pathname;
  } catch {
    return t;
  }
  try {
    pathname = decodeURIComponent(pathname.replace(/\+/g, " "));
  } catch {
    // keep pathname
  }
  if (pathname.length >= 3 && pathname[0] === "/" && pathname[2] === ":") {
    pathname = pathname.slice(1);
  }
  return pathname;
}

/**
 * @param {string} block
 * @param {Set<string>} out
 */
function addPathsFromUriListBlock(block, out) {
  for (const line of block.split(/\r?\n/)) {
    const u = line.trim();
    if (!u || u.startsWith("#")) continue;
    if (
      u.startsWith("file:") ||
      u.startsWith("vscode-resource:") ||
      u.startsWith("https://file+.vscode-resource.")
    ) {
      const p = fileUriToFsPath(u);
      if (p) out.add(p);
    } else if (u[0] === "/" || (u[0] === "~" && u[1] === "/") || u === "~") {
      const p = fileUriToFsPath(u);
      if (p) out.add(p);
    } else if (/^[A-Za-z]:[\\/]/.test(u)) {
      out.add(u);
    }
  }
}

/**
 * @param {DataTransfer} dt
 * @param {Set<string>} out
 */
function collectFilesFromDataTransferItemList(dt, out) {
  if (!dt.items || dt.items.length === 0) return;
  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i];
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) {
        const p = /** @type {{ path?: string }} */ (f).path;
        if (typeof p === "string" && p) out.add(p);
      }
    }
  }
}

/**
 * @param {DataTransfer} dt
 * @param {Set<string>} out
 */
function collectDataTransferGetDataSync(dt, out) {
  if (!dt) return;
  /** @type {string[]} */
  const types = [];
  try {
    if (dt.types) {
      if (Array.from) types.push(...Array.from(dt.types));
    }
  } catch {
    // ignore
  }
  // order matters: Explorer often uses text/uri-list
  const preferred = [
    "text/uri-list",
    "text/plain",
    "text/x-moz-url",
    "resourceurls",
    "vscode-file-urls",
  ];
  for (const t of preferred) {
    try {
      const d = dt.getData(t);
      if (d) addPathsFromUriListBlock(d, out);
    } catch {
      // getData not allowed for this type
    }
  }
  for (const t of types) {
    if (preferred.includes(t)) continue;
    if (!t || !t.startsWith("text/")) continue;
    try {
      const d = dt.getData(t);
      if (d && d.includes("file://")) addPathsFromUriListBlock(d, out);
    } catch {
      // ignore
    }
  }
  if (out.size === 0) {
    try {
      for (const t of types) {
        const d = dt.getData(t);
        if (
          d &&
          (d.startsWith("/") || d.startsWith("~") || /^[A-Za-z]:[\\/]/.test(d))
        ) {
          for (const line of d.split(/\r?\n/)) {
            const s = line.trim();
            if (s && !s.startsWith("#")) {
              if (s.startsWith("file:")) out.add(fileUriToFsPath(s));
              else if (
                s[0] === "/" ||
                s[0] === "~" ||
                /^[A-Za-z]:[\\/]/.test(s)
              )
                out.add(s);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

/**
 * @param {DataTransfer} dt
 * @param {Set<string>} out
 */
function collectDataTransferFileListSync(dt, out) {
  if (!dt.files || dt.files.length === 0) return;
  for (let i = 0; i < dt.files.length; i++) {
    const f = /** @type {{ path?: string }} */ (dt.files[i]);
    if (typeof f.path === "string" && f.path) out.add(f.path);
  }
}

/**
 * @param {DataTransfer} dt
 * @returns {Promise<string[]>}
 */
function collectDropPathsFromDataTransferAsync(dt) {
  /** @type {Set<string>} */
  const out = new Set();
  collectDataTransferGetDataSync(dt, out);
  collectDataTransferFileListSync(dt, out);
  collectFilesFromDataTransferItemList(dt, out);
  if (out.size > 0) return Promise.resolve([...out]);

  /** @type {Promise<string>[]} */
  const stringJobs = [];
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind !== "string") continue;
      stringJobs.push(
        new Promise((resolve) => {
          try {
            item.getAsString((s) => resolve(s || ""));
          } catch {
            resolve("");
          }
        }),
      );
    }
  }
  if (stringJobs.length === 0) {
    return Promise.resolve([]);
  }
  return Promise.all(stringJobs).then((chunks) => {
    for (const c of chunks) {
      if (c) addPathsFromUriListBlock(c, out);
    }
    return [...out].filter((p) => p.length > 0);
  });
}

/**
 * Remove all visual chips and clear the attached files map.
 */
function clearChips() {
  attachedFiles.clear();
  if (fileChipsEl) {
    fileChipsEl.textContent = "";
    fileChipsEl.hidden = true;
  }
}
