import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** @param {{ id: string }} o */
function ThemeColor(o) {
  return o;
}

class Range {
  constructor(sl, sc, el, ec) {
    this.start = { line: sl, character: sc };
    this.end = { line: el, character: ec };
  }
}

const OverviewRulerLane = { Left: 1 };

const ConfigurationTarget = { Global: 1, Workspace: 2 };

function UriJoinPath(base, ...parts) {
  const b = typeof base === "string" ? base : base.fsPath ?? base.path;
  return { fsPath: path.join(b, ...parts.map(String)), path: path.join(b, ...parts.map(String)) };
}

function UriFile(p) {
  const abs = path.resolve(p);
  return { fsPath: abs, path: abs };
}

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

/**
 * Minimal vscode API surface for FreeCodeChatViewProvider on macOS stdio host.
 * @param {{
 *   workspaceRoot: string;
 *   settings?: Record<string, unknown>;
 *   writeLine: (o: unknown) => void;
 *   requestOpenDialog?: (options: unknown) => Promise<{ fsPath: string }[] | undefined>;
 * }} opts
 */
export function createMacVscodeShim(opts) {
  const workspaceRoot = path.resolve(opts.workspaceRoot || process.cwd());
  const settings =
    opts.settings && typeof opts.settings === "object" ? opts.settings : {};
  const writeLine = opts.writeLine;

  const workspaceFolders = [{ uri: { fsPath: workspaceRoot, path: workspaceRoot } }];

  function getConfiguration(section) {
    const scoped = /** @type {Record<string, unknown>} */ (
      section === "free-code" && settings.freeCode && typeof settings.freeCode === "object"
        ? settings.freeCode
        : settings
    );
    return {
      get: (key, defaultValue) => {
        const k = String(key);
        if (Object.prototype.hasOwnProperty.call(scoped, k)) {
          return scoped[k];
        }
        return defaultValue;
      },
      update: async (_key, _value, _target) => {
        writeLine({
          dir: "host_to_native",
          payload: { type: "settings_update_unsupported", message: "Use the macOS app settings UI." },
        });
      },
    };
  }

  async function findFiles(relPattern, _token, maxResults) {
    const baseUri = relPattern?.base;
    const base = baseUri?.fsPath ?? baseUri?.path;
    if (!base) return [];
    const pat = relPattern.pattern || "**/*";
    if (pat !== "**/*") return [];
    const out = [];
    const cap = typeof maxResults === "number" ? maxResults : 10000;
    function walk(dir) {
      if (out.length >= cap) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= cap) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          try {
            if (statSync(full).isFile()) out.push({ fsPath: full, path: full });
          } catch {
            // skip
          }
        }
      }
    }
    walk(base);
    return out;
  }

  return {
    ThemeColor,
    Range,
    OverviewRulerLane,
    ConfigurationTarget,
    Uri: {
      joinPath: UriJoinPath,
      file: UriFile,
      parse: (s) => {
        const str = String(s || "");
        return { fsPath: str, path: str, toString: () => str };
      },
    },
    RelativePattern,
    env: {
      openExternal: async (uri) => {
        const url =
          typeof uri === "string"
            ? uri
            : uri && typeof uri.toString === "function"
              ? uri.toString()
              : "";
        if (!url) return false;
        writeLine({
          dir: "host_to_native",
          payload: { type: "open_external", url },
        });
        return true;
      },
    },
    workspace: {
      getConfiguration,
      workspaceFolders,
      onDidChangeWorkspaceFolders: (_cb) => ({ dispose() {} }),
      findFiles,
    },
    window: {
      showTextDocument: async (uri) => {
        writeLine({
          dir: "host_to_native",
          payload: { type: "open_file", path: uri?.fsPath ?? uri?.path ?? "" },
        });
      },
      showOpenDialog: async (options) => {
        if (opts.requestOpenDialog) {
          const uris = await opts.requestOpenDialog(options);
          return uris ?? [];
        }
        writeLine({
          dir: "host_to_native",
          payload: { type: "show_open_dialog", options: options ?? {} },
        });
        return [];
      },
      showSaveDialog: async (options) => {
        const defaultUri = options?.defaultUri;
        const defaultPath =
          typeof defaultUri === "string"
            ? defaultUri
            : defaultUri?.fsPath ?? defaultUri?.path ?? "";
        const r = await opts.requestNativeDialog({
          type: "show_save_dialog",
          title: options?.title ?? "Save",
          saveLabel: options?.saveLabel ?? "Save",
          defaultPath,
        });
        if (!r || r.cancelled || typeof r.path !== "string" || !r.path) {
          return undefined;
        }
        return { fsPath: r.path, path: r.path };
      },
      showInputBox: async (options) => {
        return opts.requestNativeDialog({
          type: "show_input_box",
          title: options?.title ?? "",
          placeholder: options?.placeHolder ?? "",
          value: options?.value ?? "",
        }).then((r) => (r?.cancelled ? undefined : r?.value ?? ""));
      },
      showQuickPick: async (items, options) => {
        const labels = Array.isArray(items)
          ? items.map((i) => (typeof i === "string" ? i : (i?.label ?? String(i))))
          : [];
        return opts.requestNativeDialog({
          type: "show_quick_pick",
          title: options?.title ?? options?.placeHolder ?? "Select",
          items: labels,
        }).then((r) => {
          if (!r || r.cancelled) return undefined;
          const idx = typeof r.index === "number" ? r.index : -1;
          if (idx < 0) return undefined;
          return typeof items[idx] === "string" ? items[idx] : items[idx];
        });
      },
      showInformationMessage: async (msg, ...rest) => {
        // Detect modal confirm pattern: (msg, {modal:true}, ...buttons)
        const opts2 = rest.length > 0 && rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0]) ? rest[0] : null;
        const buttons = opts2 ? rest.slice(1).filter((b) => typeof b === "string") : rest.filter((b) => typeof b === "string");
        if (buttons.length === 0) {
          // Just a notification, no response needed
          return opts.requestNativeDialog({ type: "show_message", level: "info", message: msg, buttons: [] })
            .then(() => undefined);
        }
        return opts.requestNativeDialog({ type: "show_message", level: "info", message: msg, buttons })
          .then((r) => (!r || r.cancelled ? undefined : r.value));
      },
      showWarningMessage: async (msg, ...rest) => {
        const buttons = rest.filter((b) => typeof b === "string");
        if (buttons.length === 0) {
          opts.requestNativeDialog({ type: "show_message", level: "warning", message: msg, buttons: [] });
          return;
        }
        return opts.requestNativeDialog({ type: "show_message", level: "warning", message: msg, buttons })
          .then((r) => (!r || r.cancelled ? undefined : r.value));
      },
      showErrorMessage: async (msg, ...rest) => {
        const buttons = rest.filter((b) => typeof b === "string");
        opts.requestNativeDialog({ type: "show_message", level: "error", message: msg, buttons });
      },
      setStatusBarMessage: (_t, _timeout) => ({ dispose() {} }),
      createTextEditorDecorationType: (_opts) => ({ key: "mac-noop", dispose() {} }),
      visibleTextEditors: [],
    },
    commands: {
      executeCommand: async () => {},
    },
    Disposable: class {
      constructor(fn) {
        this.dispose = typeof fn === "function" ? fn : () => {};
      }
    },
  };
}
