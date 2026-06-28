/**
 * macOS companion process: JSON lines on stdin/stdout.
 * Swift launches: node stdio-mac.mjs
 */
import readline from "node:readline";
import { FreeCodeChatViewProvider } from "./host.mjs";
import { createMacExtensionContext } from "./mac-context.mjs";
import { createMacVscodeShim } from "./mac-shim.mjs";
import { setVscodeApi } from "./vscode-api-binding.mjs";

/** @type {((uris: { fsPath: string }[]) => void) | null} */
let openDialogResolver = null;

/** @type {Map<string, (result: any) => void>} */
const nativeDialogResolvers = new Map();
let nativeDialogSeq = 0;

function writeLine(obj) {
  try {
    const line = JSON.stringify(obj);
    if (line && process.stdout.writable) {
      process.stdout.write(line + '\n');
    }
  } catch (e) {
    // Silently ignore write errors to prevent crash when pipe closes
    console.error('[writeLine error]', e instanceof Error ? e.message : String(e));
  }
}

function requestNativeDialog(payload) {
  const id = String(++nativeDialogSeq);
  writeLine({ dir: "host_to_native", payload: { ...payload, dialogId: id } });
  return new Promise((resolve) => {
    nativeDialogResolvers.set(id, resolve);
  });
}

/** @type {FreeCodeChatViewProvider | null} */
let provider = null;

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;

  if (msg.dir === "init") {
    const p = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
    const workspaceRoot =
      typeof p.workspaceRoot === "string" ? p.workspaceRoot : process.cwd();
    const mediaRoot =
      typeof p.mediaRoot === "string" ? p.mediaRoot : workspaceRoot;
    setVscodeApi(
      createMacVscodeShim({
        workspaceRoot,
        settings: p.settings,
        writeLine,
        requestNativeDialog,
        requestOpenDialog: async (options) => {
          writeLine({
            dir: "host_to_native",
            payload: { type: "show_open_dialog", options: options ?? {} },
          });
          return await new Promise((resolve) => {
            openDialogResolver = resolve;
          });
        },
      }),
    );
    const ctx = createMacExtensionContext({ workspaceRoot, mediaRoot });
    provider = new FreeCodeChatViewProvider(ctx);
    provider.view = {
      webview: {
        postMessage: (payload) =>
          writeLine({ dir: "host_to_webview", payload }),
        asWebviewUri: (u) =>
          typeof u === "string" ? u : (u?.fsPath ? `file://${u.fsPath}` : ""),
        cspSource: "'unsafe-inline' file:",
        options: {},
        html: "",
        onDidReceiveMessage: () => {},
      },
    };
    return;
  }

  if (msg.dir === "webview_to_host" && provider) {
    const payload = msg.payload;
    if (!payload || typeof payload !== "object") return;
    try {
      await provider.dispatchWebviewMessage(payload);
    } catch (e) {
      writeLine({
        dir: "host_to_webview",
        payload: {
          type: "error",
          text: e instanceof Error ? e.message : String(e),
        },
      });
    }
    return;
  }

  if (msg.dir === "native_to_host") {
    const payload = msg.payload;
    if (payload?.type === "open_dialog_result" && openDialogResolver) {
      const paths = Array.isArray(payload.paths)
        ? payload.paths.filter((x) => typeof x === "string")
        : [];
      const resolve = openDialogResolver;
      openDialogResolver = null;
      resolve(paths.map((fsPath) => ({ fsPath })));
    }
    // Native dialog response (confirm, quick-pick, input-box)
    if (payload?.type === "native_dialog_result" && typeof payload.dialogId === "string") {
      const resolve = nativeDialogResolvers.get(payload.dialogId);
      if (resolve) {
        nativeDialogResolvers.delete(payload.dialogId);
        resolve(payload.result ?? null);
      }
    }
    return;
  }
});
