/**
 * Tray IPC Handler.
 *
 * Handles IPC channels for the tray icon setting:
 * - tray-click-action:get - Returns what clicking the tray icon opens
 * - tray-click-action:set - Validates and persists it as `trayClickAction`
 *
 * TrayManager reads the saved value at click time through {@link readTrayClickAction},
 * so a change applies to the next click without rebuilding the tray.
 *
 * @module ipc/TrayIpcHandler
 */

import { ipcMain } from 'electron';
import { BaseIpcHandler } from './BaseIpcHandler';
import { IPC_CHANNELS } from '../../utils/constants';
import { DEFAULT_TRAY_CLICK_ACTION, isTrayClickAction } from '../../../shared/types/tray';
import type { TrayClickAction } from '../../../shared/types/tray';
import type { UserPreferences } from './types';
import type SettingsStore from '../../store';

/**
 * Read the saved tray click action, falling back to the default for a missing or invalid value.
 * @param store - The user preferences store
 */
export function readTrayClickAction(store: Pick<SettingsStore<UserPreferences>, 'get'>): TrayClickAction {
    const stored = store.get('trayClickAction');
    return isTrayClickAction(stored) ? stored : DEFAULT_TRAY_CLICK_ACTION;
}

/**
 * Handler for tray IPC channels.
 */
export class TrayIpcHandler extends BaseIpcHandler {
    register(): void {
        ipcMain.handle(IPC_CHANNELS.TRAY_CLICK_ACTION_GET, (): TrayClickAction => this.getClickAction());

        ipcMain.on(IPC_CHANNELS.TRAY_CLICK_ACTION_SET, (_event, action: unknown) => {
            this.setClickAction(action);
        });
    }

    private getClickAction(): TrayClickAction {
        try {
            return readTrayClickAction(this.deps.store);
        } catch (error) {
            this.handleError('reading the tray click action', error);
            return DEFAULT_TRAY_CLICK_ACTION;
        }
    }

    private setClickAction(action: unknown): void {
        try {
            if (!isTrayClickAction(action)) {
                this.logger.warn(`Invalid tray click action: ${String(action)}`);
                return;
            }
            this.deps.store.set('trayClickAction', action);
            this.logger.log(`Tray click action set to: ${action}`);
        } catch (error) {
            this.handleError('setting the tray click action', error, { requestedAction: action });
        }
    }

    unregister(): void {
        ipcMain.removeHandler(IPC_CHANNELS.TRAY_CLICK_ACTION_GET);
        ipcMain.removeAllListeners(IPC_CHANNELS.TRAY_CLICK_ACTION_SET);
    }
}
