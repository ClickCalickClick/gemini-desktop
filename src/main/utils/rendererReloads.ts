/**
 * When to reload a window whose renderer process is gone.
 *
 * A window whose page crashed is reloaded, so it does not stay blank. A renderer that exited
 * cleanly or was killed was meant to stop, and nothing is reloaded while the app quits. A window
 * is reloaded at most MAX_RELOADS times a minute, so a renderer that cannot start, for example
 * because its zygote process is gone, does not make the app reload it in a loop.
 *
 * @module RendererReloads
 */

/** Most reloads of one window within RELOAD_PERIOD_MS */
export const MAX_RELOADS = 3;

export const RELOAD_PERIOD_MS = 60000;

/** Reasons a renderer is gone that a reload does not undo */
const NO_RELOAD_REASONS = new Set(['clean-exit', 'killed']);

export default class RendererReloads {
    /** Reload times by webContents id */
    private readonly reloads = new Map<number, number[]>();

    /**
     * @param now - The current time in milliseconds; replaceable in tests
     */
    constructor(private readonly now: () => number = Date.now) {}

    /**
     * Whether to reload a window whose renderer is gone. A yes counts as a reload.
     * @param webContentsId - Id of the window's webContents
     * @param reason - The reason Electron gives for the renderer being gone
     * @param quitting - Whether the app is quitting
     */
    shouldReload(webContentsId: number, reason: string, quitting: boolean): boolean {
        if (quitting || NO_RELOAD_REASONS.has(reason)) return false;

        const now = this.now();
        const recent = (this.reloads.get(webContentsId) ?? []).filter((time) => now - time < RELOAD_PERIOD_MS);
        if (recent.length >= MAX_RELOADS) {
            this.reloads.set(webContentsId, recent);
            return false;
        }
        this.reloads.set(webContentsId, [...recent, now]);
        return true;
    }
}
