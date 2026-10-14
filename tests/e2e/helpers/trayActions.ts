/**
 * Tray E2E Test Helpers.
 *
 * Provides utilities for testing the system tray functionality.
 *
 * ## E2E Testing Approach
 * - **Tray Click/Show**: Uses trayManager.executeTrayAction() to trigger the same
 *   code path as when a user clicks the tray icon. A click opens what the
 *   `trayClickAction` setting says (Quick Chat by default); use
 *   setTrayClickAction('mainWindow') or the 'show' menu action to restore the main window
 * - **State Queries**: Uses trayManager APIs (acceptable for reading state)
 *
 * @module trayActions
 */

/// <reference path="./wdio-electron.d.ts" />

import { browser } from '@wdio/globals';
import { E2ELogger } from './logger';

// =============================================================================
// Type Definitions for TrayManager Access
// =============================================================================

/**
 * TrayManager interface for E2E testing.
 */
interface E2ETrayManager {
    getTray?: () => Electron.Tray | null;
    createTray?: () => Electron.Tray;
    destroyTray?: () => void;
}

/**
 * State of the system tray.
 */
export interface TrayState {
    /** Whether the tray exists */
    exists: boolean;
    /** Whether the tray is destroyed */
    isDestroyed: boolean;
    /** The tray tooltip text */
    tooltip: string | null;
}

/**
 * Tray menu item representation.
 */
export interface TrayMenuItem {
    label: string;
    enabled: boolean;
    type: string;
}

// =============================================================================
// Tray State Actions
// =============================================================================

/**
 * Get the current state of the system tray.
 *
 * @returns Promise<TrayState> - The current tray state
 */
export async function getTrayState(): Promise<TrayState> {
    return browser.electron.execute(() => {
        try {
            const ctx = (global as { appContext?: any }).appContext;
            const trayManager = ctx?.trayManager as E2ETrayManager | undefined;

            if (!trayManager) {
                return {
                    exists: false,
                    isDestroyed: true,
                    tooltip: null,
                };
            }

            const tray = trayManager.getTray?.();

            if (!tray) {
                return {
                    exists: false,
                    isDestroyed: true,
                    tooltip: null,
                };
            }

            // Check if destroyed first to avoid accessing properties on destroyed instance
            const isDestroyed = tray.isDestroyed();

            return {
                exists: true,
                isDestroyed,
                // Safely access tooltip only if not destroyed
                tooltip: !isDestroyed && (tray as any).getToolTip ? (tray as any).getToolTip() : null,
            };
        } catch (error) {
            console.error('[E2E] getTrayState error:', error);
            return {
                exists: false,
                isDestroyed: true,
                tooltip: null,
            };
        }
    });
}

/**
 * Read the saved tray click action ('quickChat' or 'mainWindow') in the main process.
 *
 * @returns Promise resolving to the saved action, or null when the store is not reachable
 */
export async function getTrayClickAction(): Promise<'quickChat' | 'mainWindow' | null> {
    return browser.electron.execute(() => {
        const ctx = (global as { appContext?: any }).appContext;
        const store = ctx?.ipcManager?.store as { get?: (key: string) => unknown } | undefined;
        const value = store?.get?.('trayClickAction');
        return value === 'quickChat' || value === 'mainWindow' ? value : null;
    });
}

/**
 * Save what a tray click opens, as Options does, in the main process.
 *
 * @param action - 'quickChat' (the default) or 'mainWindow'
 */
export async function setTrayClickAction(action: 'quickChat' | 'mainWindow'): Promise<void> {
    E2ELogger.info('tray', `Setting tray click action: ${action}`);

    await browser.electron.execute((_electron: typeof import('electron'), value: string) => {
        const ctx = (global as { appContext?: any }).appContext;
        const store = ctx?.ipcManager?.store as { set?: (key: string, value: unknown) => void } | undefined;
        store?.set?.('trayClickAction', value);
    }, action);
}

/**
 * Trigger a tray click action.
 *
 * Uses trayManager.executeTrayAction() to trigger the same code path
 * as when a user clicks the tray icon. This tests:
 * - TrayManager action dispatch
 * - The `trayClickAction` setting: WindowManager.showQuickChat() (default)
 *   or WindowManager.restoreFromTray() with show and focus
 *
 * @returns Promise<void>
 */
export async function simulateTrayClick(): Promise<void> {
    E2ELogger.info('tray', 'Triggering tray click via action executor');

    await browser.electron.execute(() => {
        const ctx = (global as { appContext?: any }).appContext;
        const trayManager = ctx?.trayManager as { executeTrayAction?: (action: string) => void } | undefined;

        if (trayManager?.executeTrayAction) {
            trayManager.executeTrayAction('click');
        } else {
            // Fallback: emit click event directly (less ideal)
            console.warn('[E2E] trayManager.executeTrayAction not available, using fallback');
            const tray = (trayManager as any)?.getTray?.();
            if (tray && !tray.isDestroyed()) {
                tray.emit('click');
            }
        }
    });
}

/**
 * Trigger a tray right-click (context menu) action.
 *
 * Note: Right-click typically shows a context menu which cannot be
 * interacted with via WebDriver. This function triggers the right-click
 * event handler for testing the event is received.
 *
 * @returns Promise<void>
 */
export async function simulateTrayRightClick(): Promise<void> {
    E2ELogger.info('tray', 'Triggering tray right-click event');

    await browser.electron.execute(() => {
        const ctx = (global as { appContext?: any }).appContext;
        const trayManager = ctx?.trayManager as { getTray?: () => Electron.Tray | null } | undefined;

        if (!trayManager) {
            console.warn('[E2E] TrayManager not available');
            return;
        }

        const tray = trayManager.getTray?.();

        if (tray && !tray.isDestroyed()) {
            // Right-click shows context menu - emit event for testing
            tray.emit('right-click');
        }
    });
}

/**
 * Get the tray context menu items.
 *
 * @returns Promise<TrayMenuItem[]> - Array of menu items
 */
export async function getTrayContextMenuItems(): Promise<TrayMenuItem[]> {
    return browser.electron.execute((_electron: typeof import('electron')) => {
        const ctx = (global as { appContext?: any }).appContext;
        const trayManager = ctx?.trayManager as
            | {
                  getTray?: () => Electron.Tray | null;
              }
            | undefined;

        if (!trayManager) {
            return [];
        }

        const tray = trayManager.getTray?.();

        if (!tray || tray.isDestroyed()) {
            return [];
        }

        // Note: Electron doesn't expose context menu items directly
        // We return a placeholder - actual menu testing may need different approach
        // For now, we verify the tray exists and has a menu set
        return [];
    });
}

/**
 * Execute a tray menu action.
 *
 * Uses trayManager.executeTrayAction() to trigger the same code path
 * as when a user clicks a tray menu item. This tests:
 * - TrayManager action dispatch
 * - WindowManager.restoreFromTray() for 'show'
 * - app.quit() for 'quit'
 *
 * @param action - 'show' or 'quit'
 * @returns Promise<void>
 */
export async function clickTrayMenuItem(action: 'show' | 'quit'): Promise<void> {
    E2ELogger.info('tray', `Executing tray menu action: ${action}`);

    await browser.electron.execute((_electron: typeof import('electron'), menuAction: string) => {
        const ctx = (global as { appContext?: any }).appContext;
        const trayManager = ctx?.trayManager as { executeTrayAction?: (action: string) => void } | undefined;

        if (trayManager?.executeTrayAction) {
            trayManager.executeTrayAction(menuAction);
        } else {
            // Fallback: call windowManager directly (less ideal)
            console.warn('[E2E] trayManager.executeTrayAction not available, using fallback');
            const windowManager = ctx?.windowManager as { restoreFromTray?: () => void } | undefined;

            if (menuAction === 'show') {
                windowManager?.restoreFromTray?.();
            } else if (menuAction === 'quit') {
                _electron.app.quit();
            }
        }
    }, action);
}

/**
 * Verify the tray icon was created on app startup.
 *
 * @returns Promise<boolean> - True if tray exists and is not destroyed
 */
export async function verifyTrayCreated(): Promise<boolean> {
    const state = await getTrayState();
    return state.exists && !state.isDestroyed;
}

/**
 * Get the tray tooltip text.
 *
 * @returns Promise<string | null> - The tooltip text or null
 */
export async function getTrayTooltip(): Promise<string | null> {
    const state = await getTrayState();
    return state.tooltip;
}
