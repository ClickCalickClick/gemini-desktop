/**
 * Desktop Look IPC Handler.
 *
 * Handles IPC channels for the desktop look:
 * - look:get - Returns the preference, the applied look, the detected desktop and its accent color
 * - look:set - Validates and persists the preference, then broadcasts look:changed
 *
 * On Linux it also reads the desktop's accent color (XDG Settings portal, then KDE's kdeglobals)
 * and broadcasts look:changed when the desktop changes it. The accent is only read once a look
 * other than 'default' is applied, so the default look never touches D-Bus.
 *
 * @module ipc/LookIpcHandler
 */

import { ipcMain } from 'electron';
import { BaseIpcHandler } from './BaseIpcHandler';
import type { IpcHandlerDependencies } from './types';
import { IPC_CHANNELS } from '../../utils/constants';
import { detectDesktop, isDesktopLookPreference, resolveEffectiveLook } from '../../utils/desktopLook';
import type { DetectedDesktop } from '../../utils/desktopLook';
import { DesktopAccentWatcher } from '../../utils/desktopAccent';
import type { DesktopAccentWatcherOptions } from '../../utils/desktopAccent';
import type { DesktopLookPreference, LookData } from '../../../shared/types/look';

/** The parts of DesktopAccentWatcher the handler uses (a fake in tests). */
export interface AccentWatcherLike {
    start(onChange: (accent: string | null) => void, onLost?: () => void): Promise<string | null>;
    stop(): void;
}

/** Options for {@link LookIpcHandler}, mostly for tests. */
export interface LookIpcHandlerOptions {
    /** process.platform */
    platform?: NodeJS.Platform;
    /** Environment read for XDG_CURRENT_DESKTOP and friends */
    env?: NodeJS.ProcessEnv;
    /** Creates the accent watcher */
    createAccentWatcher?: (options: DesktopAccentWatcherOptions) => AccentWatcherLike;
    /** Delay before the one retry after the session bus connection is lost */
    accentRetryDelayMs?: number;
}

/** Wait this long before reading the accent again after the session bus connection is lost. */
const ACCENT_RETRY_DELAY_MS = 30_000;

/**
 * Handler for desktop look IPC channels.
 */
export class LookIpcHandler extends BaseIpcHandler {
    private readonly detected: DetectedDesktop;
    private readonly platform: NodeJS.Platform;
    private readonly env: NodeJS.ProcessEnv;
    private readonly createAccentWatcher: (options: DesktopAccentWatcherOptions) => AccentWatcherLike;
    private accentWatcher: AccentWatcherLike | null = null;
    private accentColor: string | null = null;
    private readonly accentRetryDelayMs: number;
    private accentRetryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(deps: IpcHandlerDependencies, options: LookIpcHandlerOptions = {}) {
        super(deps);
        this.platform = options.platform ?? process.platform;
        this.env = options.env ?? process.env;
        this.detected = detectDesktop(this.platform, this.env);
        this.createAccentWatcher =
            options.createAccentWatcher ?? ((watcherOptions) => new DesktopAccentWatcher(watcherOptions));
        this.accentRetryDelayMs = options.accentRetryDelayMs ?? ACCENT_RETRY_DELAY_MS;
    }

    register(): void {
        ipcMain.handle(IPC_CHANNELS.LOOK_GET, (): LookData => this.getLookData());

        ipcMain.on(IPC_CHANNELS.LOOK_SET, (_event, look: unknown) => {
            this.setLook(look);
        });
    }

    /** Start reading the accent when the saved look needs it. */
    initialize(): void {
        try {
            this.logger.log(
                `Desktop detected: ${this.detected.name ?? 'unknown'} (look: ${this.getLookData().effectiveLook})`
            );
            this.syncAccentWatcher();
        } catch (error) {
            this.handleError('initializing desktop look', error);
        }
    }

    /** The current look data. */
    getLookData(): LookData {
        const preference = this.getPreference();
        return {
            preference,
            effectiveLook: resolveEffectiveLook(preference, this.detected),
            detectedDesktop: this.detected.name,
            accentColor: this.accentColor,
        };
    }

    private getPreference(): DesktopLookPreference {
        try {
            const stored = this.deps.store.get('desktopLook');
            return isDesktopLookPreference(stored) ? stored : 'default';
        } catch (error) {
            this.handleError('reading the look preference', error);
            return 'default';
        }
    }

    private setLook(look: unknown): void {
        try {
            if (!isDesktopLookPreference(look)) {
                this.logger.warn(`Invalid look value: ${String(look)}`);
                return;
            }
            this.deps.store.set('desktopLook', look);
            // Before the broadcast, so going back to 'default' drops the accent in the same message
            this.syncAccentWatcher();
            const data = this.getLookData();
            this.logger.log(`Look set to: ${look} (effective: ${data.effectiveLook})`);
            this.broadcastToAllWindows(IPC_CHANNELS.LOOK_CHANGED, data);
        } catch (error) {
            this.handleError('setting the look', error, { requestedLook: String(look) });
        }
    }

    /**
     * Run the accent watcher exactly while it is needed: on Linux with a look other than 'default'.
     * Starting it broadcasts look:changed when the first read finds an accent and on every later
     * change; going back to 'default' stops it and forgets the accent.
     */
    private syncAccentWatcher(): void {
        const needed = this.platform === 'linux' && this.getLookData().effectiveLook !== 'default';
        if (!needed) {
            this.clearAccentRetry();
            if (this.accentWatcher) {
                this.accentWatcher.stop();
                this.accentWatcher = null;
            }
            this.accentColor = null;
            return;
        }
        if (this.accentWatcher) {
            return;
        }

        const watcher = this.createAccentWatcher({
            platform: this.platform,
            env: this.env,
            isKde: this.detected.look === 'kde',
        });
        this.accentWatcher = watcher;

        const update = (accent: string | null): void => {
            if (this.accentWatcher !== watcher || accent === this.accentColor) {
                return;
            }
            this.accentColor = accent;
            this.broadcastToAllWindows(IPC_CHANNELS.LOOK_CHANGED, this.getLookData());
        };

        // The session bus connection failed: drop this watcher so the next look:set, or one
        // delayed retry, starts a new one. The last accent stays applied meanwhile.
        const lost = (): void => {
            if (this.accentWatcher !== watcher) {
                return;
            }
            this.logger.warn('Lost the session bus connection for the desktop accent; will retry');
            watcher.stop();
            this.accentWatcher = null;
            this.clearAccentRetry();
            this.accentRetryTimer = setTimeout(() => {
                this.accentRetryTimer = null;
                this.syncAccentWatcher();
            }, this.accentRetryDelayMs);
            this.accentRetryTimer.unref?.();
        };

        watcher
            .start(update, lost)
            .then(update)
            .catch((error: unknown) => this.handleError('reading the desktop accent color', error));
    }

    private clearAccentRetry(): void {
        if (this.accentRetryTimer) {
            clearTimeout(this.accentRetryTimer);
            this.accentRetryTimer = null;
        }
    }

    unregister(): void {
        ipcMain.removeHandler(IPC_CHANNELS.LOOK_GET);
        ipcMain.removeAllListeners(IPC_CHANNELS.LOOK_SET);
        this.clearAccentRetry();
        this.accentWatcher?.stop();
        this.accentWatcher = null;
    }
}
