/**
 * Parse xterm SGR extended mouse reports (CSI ? 1006 h).
 * Format: ESC [ < Pb ; Px ; Py M (press/motion) or m (release)
 * Px/Py are 1-based column/row in the terminal viewport.
 */
export interface SgrMouseReport {
	button: number;
	/** 1-based column */
	col: number;
	/** 1-based row */
	row: number;
	/** true if the sequence ends with lowercase m (release) */
	release: boolean;
}

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export function parseSgrMouseReport(data: string): SgrMouseReport | null {
	const m = data.match(SGR_MOUSE_RE);
	if (!m) return null;
	return {
		button: Number.parseInt(m[1]!, 10),
		col: Number.parseInt(m[2]!, 10),
		row: Number.parseInt(m[3]!, 10),
		release: m[4] === "m",
	};
}

/**
 * Returns viewport cell for a simple button press (left/middle/right down)
 * on a press/motion event. Ignores releases, wheel (64+), and drag-motion (32–63).
 */
export function sgrMouseSimplePressCell(data: string): { col: number; row: number } | null {
	const p = parseSgrMouseReport(data);
	if (!p || p.release) return null;
	const b = p.button;
	if (b >= 32) return null;
	if (b > 2) return null;
	return { col: p.col, row: p.row };
}
