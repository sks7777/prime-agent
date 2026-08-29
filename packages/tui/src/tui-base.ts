import type { Terminal } from "./terminal.js";
import { isImageLine } from "./terminal-image.js";
import type { Component, TUI, TuiStopOptions } from "./tui.js";
import { TUI as PiTui } from "./tui.js";
import { extractSegments, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;

export type TuiMode = "regular" | "fullscreen";

/**
 * Abstract base for viewport TUIs (alt screen / main screen).
 * Wraps PI's TUI class and adds the earendil-compatible surface:
 * mode, input listeners, log directory, and flash compositing.
 */
export abstract class TuiBase extends PiTui {
	abstract readonly mode: TuiMode;
	protected readonly logDirectory: string;

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super(terminal, showHardwareCursor);
		this.logDirectory = logDirectory ?? process.env.PI_CODING_AGENT_DIR ?? `${process.env.HOME ?? ""}/.pi/agent`;
	}

	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	protected beforeTerminalStart(): void {}

	protected beforeTerminalStop(_options: TuiStopOptions): void {}

	protected afterTerminalStop(_options: TuiStopOptions): void {}

	protected resetRenderState(): void {}

	isOverlayFocused(): boolean {
		return this.hasOverlayEntries;
	}
}

export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
