import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * @param {{ mediaRoot: string; workspaceRoot: string; stateFile?: string }} opts
 */
export function createMacExtensionContext(opts) {
  const mediaRoot = path.resolve(opts.mediaRoot);
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const stateDir = path.join(
    process.env.HOME || "",
    "Library",
    "Application Support",
    "FreeCode",
    "state",
  );
  mkdirSync(stateDir, { recursive: true });
  const hash = Buffer.from(workspaceRoot).toString("base64url").slice(0, 48);
  const stateFile =
    opts.stateFile ?? path.join(stateDir, `${hash || "default"}.json`);

  /** @type {Map<string, unknown>} */
  const memory = new Map();

  function loadDisk() {
    if (!existsSync(stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          memory.set(k, v);
        }
      }
    } catch {
      // ignore corrupt state
    }
  }

  function saveDisk() {
    const o = Object.fromEntries(memory);
    writeFileSync(stateFile, JSON.stringify(o, null, 2), "utf8");
  }

  loadDisk();

  return {
    extensionUri: { fsPath: path.dirname(mediaRoot) },
    workspaceState: {
      get: (key) => memory.get(key),
      update: async (key, val) => {
        memory.set(key, val);
        saveDisk();
      },
    },
    subscriptions: [],
    /** mac stdio host: workspace root for cwd resolution */
    macWorkspaceRoot: workspaceRoot,
    macMediaRoot: mediaRoot,
  };
}
