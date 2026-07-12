/**
 * Screen-capture backends for the vision extension.
 *
 * The primary Linux/Wayland path is the XDG Desktop Portal
 * (`org.freedesktop.portal.Screenshot`) via PyGObject, which gives us the OS
 * consent flow for free. CLI fallbacks cover X11, wlroots, and macOS/Windows.
 * On Wayland, apps cannot silently grab the screen, so the portal is not a
 * fallback — it is the correct path. See `analysis/vision-mode-plan.md`.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaptureBackend } from "./config.ts";

export interface CaptureResult {
	filePath: string;
	mimeType: string;
	/** Backend that produced the capture. */
	backend: string;
}

export interface CaptureOptions {
	backend: CaptureBackend;
	interactive: boolean;
	/** Milliseconds before giving up on a capture backend. */
	timeoutMs: number;
}

export interface BackendInfo {
	id: string;
	available: boolean;
	label: string;
}

/** True on a Wayland session (mirrors src/utils/clipboard-image.ts isWaylandSession). */
export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function commandAvailable(cmd: string): boolean {
	try {
		const result = spawnSync("which", [cmd], { stdio: "ignore" });
		return result.status === 0;
	} catch {
		return false;
	}
}

function pythonGiAvailable(): boolean {
	try {
		const result = spawnSync(
			"python3",
			["-c", "import gi; gi.require_version('Gio','2.0'); from gi.repository import Gio, GLib"],
			{ stdio: "ignore" },
		);
		return result.status === 0;
	} catch {
		return false;
	}
}

/** Run a command; resolve on exit 0, reject otherwise (with stderr text). */
function runCmd(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: env ? { ...process.env, ...env } : undefined,
		});
		let stderr = "";
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			reject(new Error(`${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`${command} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

const PYTHON_PORTAL_SCRIPT = `
import gi
gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gio, GLib
import shutil, sys, urllib.parse, pathlib

interactive = sys.argv[1] == 'true'
out_file = sys.argv[2]

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
portal = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.NONE, None,
    'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
    'org.freedesktop.portal.Screenshot', None)

state = {'uri': None, 'err': None}
loop = GLib.MainLoop()

def on_signal(connection, sender, path, iface, signal, params):
    if signal != 'Response':
        return
    code, results = params.unpack()
    if code != 0:
        state['err'] = 'portal response code %d (permission denied or cancelled)' % code
    else:
        state['uri'] = results.get('uri')
    loop.quit()

param = GLib.Variant('(sa{sv})', ('', {'interactive': GLib.Variant('b', interactive)}))
try:
    ret = portal.call_sync('Screenshot', param, Gio.DBusCallFlags.NONE, 15000, None)
    request_path = ret.unpack()[0]
except Exception as e:
    print('ERROR: portal call failed: %s' % e)
    sys.exit(2)

sub = bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request',
    'Response', request_path, None, Gio.DBusSignalFlags.NONE, on_signal)

GLib.timeout_add_seconds(20, lambda: (state.__setitem__('err', 'portal timeout'), loop.quit()))
loop.run()
bus.signal_unsubscribe(sub)

if state['err']:
    print('ERROR: %s' % state['err'])
    sys.exit(3)
uri = state['uri']
if not uri:
    print('ERROR: portal returned no URI')
    sys.exit(4)
src = pathlib.Path(urllib.parse.urlparse(uri).path)
if not src.exists():
    print('ERROR: portal file missing: %s' % src)
    sys.exit(5)
shutil.copyfile(str(src), out_file)
print('OK %s' % out_file)
`;

async function captureViaPortal(opts: CaptureOptions, outFile: string): Promise<void> {
	await runCmd(
		"python3",
		["-c", PYTHON_PORTAL_SCRIPT, opts.interactive ? "true" : "false", outFile],
		opts.timeoutMs,
	);
}

const POWERSHELL_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($env:VISION_CAPTURE_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output 'OK'
`;

interface Backend {
	id: CaptureBackend;
	run: () => Promise<void>;
	available: boolean;
}

/** Capture the screen to a temp PNG file and return its path. */
export async function captureScreen(opts: CaptureOptions): Promise<CaptureResult> {
	const workDir = mkdtempSync(join(tmpdir(), "vision-capture-"));
	const outFile = join(workDir, "capture.png");
	const wayland = isWaylandSession();

	const backends: Backend[] = [];
	if (wayland) {
		backends.push({
			id: "portal",
			run: () => captureViaPortal(opts, outFile),
			available: pythonGiAvailable(),
		});
		backends.push({
			id: "grim",
			run: () => runCmd("grim", [outFile], 5000),
			available: commandAvailable("grim"),
		});
	}
	backends.push({
		id: "gnome-screenshot",
		run: () => runCmd("gnome-screenshot", ["-f", outFile], opts.timeoutMs),
		available: commandAvailable("gnome-screenshot"),
	});
	backends.push({
		id: "spectacle",
		run: () => runCmd("spectacle", ["-b", "-n", "-f", outFile], opts.timeoutMs),
		available: commandAvailable("spectacle"),
	});
	backends.push({
		id: "scrot",
		run: () => runCmd("scrot", [outFile], opts.timeoutMs),
		available: commandAvailable("scrot"),
	});
	backends.push({
		id: "import",
		run: () => runCmd("import", ["-window", "root", outFile], opts.timeoutMs),
		available: commandAvailable("import"),
	});
	if (process.platform === "darwin") {
		backends.push({
			id: "screencapture",
			run: () => runCmd("screencapture", ["-x", outFile], opts.timeoutMs),
			available: commandAvailable("screencapture"),
		});
	}
	if (process.platform === "win32") {
		backends.push({
			id: "powershell",
			run: () =>
				runCmd(
					"powershell.exe",
					["-NoProfile", "-Command", POWERSHELL_SCRIPT],
					opts.timeoutMs,
					{ VISION_CAPTURE_OUT: outFile },
				),
			available: process.platform === "win32",
		});
	}

	let candidates = backends;
	if (opts.backend !== "auto") {
		candidates = backends.filter((b) => b.id === opts.backend);
		if (candidates.length === 0) {
			throw new Error(`Unknown capture backend "${opts.backend}".`);
		}
	}

	const available = candidates.filter((b) => b.available);
	if (available.length === 0) {
		const tried = candidates.map((b) => b.id).join(", ");
		const hint = captureHint(wayland);
		throw new Error(`No available screen-capture backend (tried: ${tried}).${hint}`);
	}

	let lastError: Error | undefined;
	for (const backend of available) {
		try {
			await backend.run();
			return { filePath: outFile, mimeType: "image/png", backend: backend.id };
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			continue;
		}
	}
	cleanupWorkDir(workDir);
	throw lastError ?? new Error("All capture backends failed.");
}

function captureHint(wayland: boolean): string {
	if (wayland) {
		return (
			' On Wayland, install "grim" or "gnome-screenshot", or allow the XDG Desktop Portal ' +
			'screenshot permission for this app. Python 3 with PyGObject ("python3-gi") is required ' +
			"for the portal backend."
		);
	}
	if (process.platform === "darwin") return ' Install "screencapture" (ships with macOS).';
	if (process.platform === "win32") return " PowerShell is required for capture on Windows.";
	return ' Install "scrot" or ImageMagick "import".';
}

function cleanupWorkDir(workDir: string): void {
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		// Ignore.
	}
}

/** List capture backends and their availability on this machine. */
export function listCaptureBackends(): BackendInfo[] {
	const wayland = isWaylandSession();
	const list: BackendInfo[] = [];
	if (wayland) {
		list.push({ id: "portal", available: pythonGiAvailable(), label: "XDG Desktop Portal (Wayland)" });
		list.push({ id: "grim", available: commandAvailable("grim"), label: "grim (wlroots)" });
	}
	list.push({ id: "gnome-screenshot", available: commandAvailable("gnome-screenshot"), label: "GNOME" });
	list.push({ id: "spectacle", available: commandAvailable("spectacle"), label: "KDE Spectacle" });
	list.push({ id: "scrot", available: commandAvailable("scrot"), label: "scrot (X11)" });
	list.push({ id: "import", available: commandAvailable("import"), label: "ImageMagick import (X11)" });
	if (process.platform === "darwin") {
		list.push({ id: "screencapture", available: commandAvailable("screencapture"), label: "macOS screencapture" });
	}
	if (process.platform === "win32") {
		list.push({ id: "powershell", available: true, label: "PowerShell (Windows)" });
	}
	return list;
}

/** Remove the temp capture file (best-effort). */
export function cleanupCapture(result: CaptureResult): void {
	try {
		rmSync(result.filePath, { force: true });
	} catch {
		// Ignore.
	}
}
