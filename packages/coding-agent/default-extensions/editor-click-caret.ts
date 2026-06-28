/**
 * Click-to-caret with native selection preserved.
 *
 * Default state: mouse reporting OFF → the terminal keeps its native text
 * selection (Option/Shift not required).
 *
 * Workflow
 *   1. Press Ctrl+Alt+M (or run /mouse) to ARM a one-shot caret placement.
 *      Status shows "click to place caret (Esc to cancel)".
 *   2. Do a normal click. On release the caret jumps to that position.
 *   3. Tracking is turned back OFF automatically.
 *
 *   Press Esc (or the shortcut again) to cancel the armed state without
 *   clicking. Any non-mouse keyboard input also cancels.
 *
 * Why not "hold Ctrl while clicking"?
 *   That requires the terminal to report pure-modifier key events
 *   (Kitty keyboard protocol flag 8 — "report all keys"). The TUI enables
 *   only flags 1+2+4, so we can't observe Ctrl in real time without
 *   changing that globally. The arm-then-click pattern above is the
 *   closest equivalent without touching protocol flags.
 */
import type { ExtensionAPI, ExtensionContext, TerminalInputHandler } from "@free/pi-coding-agent";
import { parseSgrMouseReport } from "@free/pi-tui";

let unsubscribeTerminalInput: (() => void) | undefined;
let trackingOn = false;
let armed = false;
let pressSeen = false;

export default function (pi: ExtensionAPI) {
	const setTracking = (ctx: ExtensionContext, on: boolean) => {
		if (!ctx.hasUI) return;
		if (on === trackingOn) return;
		ctx.ui.setTerminalMouseReporting(on);
		trackingOn = on;
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"editor-click-caret",
			armed ? "click to place caret (Esc to cancel)" : undefined,
		);
	};

	const disarm = (ctx: ExtensionContext) => {
		armed = false;
		pressSeen = false;
		setTracking(ctx, false);
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		updateStatus(ctx);
	};

	const makeInputHandler: (ctx: ExtensionContext) => TerminalInputHandler = (ctx) => (data) => {
		if (!armed) return undefined;

		const report = parseSgrMouseReport(data);
		if (!report) {
			// Any keyboard input while armed but before clicking cancels the arm.
			// This covers Esc, typing, arrow keys, etc.
			disarm(ctx);
			return undefined;
		}

		if (report.button > 2) return undefined;

		if (!report.release) {
			// Swallow the press; we act on release so the caret lands where the
			// user lets go, not where they pushed down.
			pressSeen = true;
			return { consume: true };
		}

		// Only honor release if it matches a press we armed for — avoids
		// stray releases from an earlier unrelated gesture triggering a jump.
		if (!pressSeen) return { consume: true };
		ctx.ui.placeCaretFromTerminalCell(report.col, report.row);
		disarm(ctx);
		return { consume: true };
	};

	const arm = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (armed) return;
		armed = true;
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = ctx.ui.onTerminalInput(makeInputHandler(ctx));
		setTracking(ctx, true);
		updateStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Ensure we start clean and leave native selection alone.
		disarm(ctx);
		ctx.ui.notify(
			"Mouse selection works normally. Press Ctrl+Alt+M (or /mouse) to arm a one-shot click-to-caret.",
			"info",
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		disarm(ctx);
	});

	pi.registerCommand("mouse", {
		description: "Arm one-shot click-to-caret (next click places the caret)",
		handler: async (_args, ctx) => {
			if (armed) {
				disarm(ctx);
				ctx.ui.notify("Click-to-caret cancelled", "info");
			} else {
				arm(ctx);
				ctx.ui.notify("Click now to place the caret (Esc to cancel)", "info");
			}
		},
	});

	pi.registerShortcut("ctrl+alt+m", {
		description: "Arm one-shot click-to-caret",
		handler: async (ctx) => {
			if (armed) {
				disarm(ctx);
			} else {
				arm(ctx);
			}
		},
	});
}
