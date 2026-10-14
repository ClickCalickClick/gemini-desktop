/**
 * Tray Manager for the Electron main process.
 * Handles system tray icon and context menu functionality.
 *
 * @module TrayManager
 */

import { Tray, Menu, app, nativeImage } from 'electron';
import * as fs from 'fs';
import type { MenuItemConstructorOptions } from 'electron';
import { getIconPath, getTrayIconPath } from '../utils/paths';
import { TRAY_MENU_ITEMS, TRAY_TOOLTIP } from '../utils/constants';
import { createLogger } from '../utils/logger';
import { getPlatformAdapter } from '../platform/platformAdapterFactory';
import type WindowManager from './windowManager';
import { DEFAULT_TRAY_CLICK_ACTION } from '../../shared/types/tray';
import type { TrayClickAction } from '../../shared/types/tray';

const logger = createLogger('[TrayManager]');

/** Optional dependencies for {@link TrayManager}. */
export interface TrayManagerOptions {
    /**
     * Returns what a tray icon click opens. Called at click time, so a changed setting
     * applies to the next click. main.ts reads the `trayClickAction` user preference;
     * without it the click opens Quick Chat (the setting's default).
     */
    getClickAction?: () => TrayClickAction;
}

/**
 * Manages the system tray icon and context menu.
 *
 * ## Features
 * - Creates system tray icon with app icon
 * - Provides context menu for Quick Chat, show and quit actions
 * - Handles tray click: opens Quick Chat or the main window, per the `trayClickAction` setting
 *   (on GNOME's AppIndicator extension a single click opens the menu and a double click
 *   sends Activate, which Electron reports as the Tray `click` event)
 * - Cross-platform support (Windows, macOS, Linux)
 *
 * @class TrayManager
 */
export default class TrayManager {
    /** Reference to the window manager */
    private windowManager: WindowManager;

    /** Reads what a tray icon click opens */
    private readonly getClickAction: () => TrayClickAction;

    /** The system tray instance */
    private tray: Tray | null = null;

    /** Track current tooltip for E2E testing */
    private currentToolTip: string = TRAY_TOOLTIP;

    /**
     * Creates a new TrayManager instance.
     * @param windowManager - The WindowManager instance for window control
     * @param options - Optional dependencies, see {@link TrayManagerOptions}
     */
    constructor(windowManager: WindowManager, options: TrayManagerOptions = {}) {
        this.windowManager = windowManager;
        this.getClickAction = options.getClickAction ?? (() => DEFAULT_TRAY_CLICK_ACTION);
        logger.log('TrayManager initialized');
    }

    /**
     * Create and configure the system tray icon.
     * @returns The created Tray instance
     */
    createTray(): Tray {
        try {
            if (this.tray) {
                logger.warn('Tray already exists, returning existing instance');
                return this.tray;
            }

            let iconPath = getTrayIconPath();
            if (!fs.existsSync(iconPath)) {
                logger.warn(`Tray icon not found: ${iconPath}, falling back to app icon`);
                iconPath = getIconPath();
                if (!fs.existsSync(iconPath)) {
                    throw new Error(`Icon not found: ${iconPath}`);
                }
            }

            // Create nativeImage for tray (required for proper icon handling)
            let trayIcon = nativeImage.createFromPath(iconPath);
            if (trayIcon.isEmpty()) {
                throw new Error(`Failed to load tray icon: ${iconPath}`);
            }

            if (getPlatformAdapter().id === 'mac') {
                trayIcon = this.normalizeMacTrayImage(trayIcon);
                if (trayIcon.isEmpty()) {
                    throw new Error(`Failed to normalize tray icon: ${iconPath}`);
                }
            }

            this.tray = new Tray(trayIcon);

            // Set tooltip
            this.tray.setToolTip(this.currentToolTip);

            // Build and set context menu
            const contextMenu = this._buildContextMenu();
            this.tray.setContextMenu(contextMenu);

            // Tray click (a double click on GNOME's AppIndicator extension) opens what the setting says
            this.tray.on('click', () => {
                logger.log('Tray icon clicked');
                this._handleTrayClick();
            });

            logger.log('Tray created successfully');
            return this.tray;
        } catch (error) {
            /* v8 ignore next 2 -- defensive error handling, hard to trigger in tests */
            logger.error('Failed to create tray:', error);
            throw error;
        }
    }

    /**
     * Open what the `trayClickAction` setting names: Quick Chat or the main window.
     * @private
     */
    private _handleTrayClick(): void {
        let action: TrayClickAction = DEFAULT_TRAY_CLICK_ACTION;
        try {
            action = this.getClickAction();
        } catch (error) {
            logger.error('Failed to read the tray click action, using the default:', error);
        }

        if (action === 'mainWindow') {
            this.windowManager.restoreFromTray();
        } else {
            this.windowManager.showQuickChat();
        }
    }

    /**
     * Build the context menu from TRAY_MENU_ITEMS configuration.
     * @private
     * @returns The Menu instance
     */
    private _buildContextMenu(): Electron.Menu {
        const menuTemplate: MenuItemConstructorOptions[] = Object.values(TRAY_MENU_ITEMS).map((item) => {
            if (item.isSeparator) {
                return { type: 'separator' as const };
            }

            return {
                label: item.label,
                accelerator: item.accelerator,
                click: () => this._handleMenuItemClick(item.id),
            };
        });

        return Menu.buildFromTemplate(menuTemplate);
    }

    /**
     * Handle context menu item clicks.
     * @private
     * @param itemId - The id of the clicked menu item
     */
    private _handleMenuItemClick(itemId: string): void {
        logger.log('Menu item clicked:', itemId);

        switch (itemId) {
            case 'show':
                this.windowManager.restoreFromTray();
                break;
            case 'quickChat':
                this.windowManager.showQuickChat();
                break;
            case 'quit':
                app.quit();
                break;
            /* v8 ignore next 2 -- fallback for unknown menu items, extensibility safety net */
            default:
                logger.warn('Unknown menu item:', itemId);
        }
    }

    /**
     * Execute a tray action programmatically.
     *
     * This method exists primarily for E2E testing, allowing tests to trigger
     * the same code path that would be executed when a user clicks the tray icon
     * or a tray menu item.
     *
     * @param action - The action to execute: 'click' (the tray icon click, which follows the
     *   `trayClickAction` setting), 'show' (restore the main window), 'quickChat' or 'quit'
     */
    executeTrayAction(action: 'click' | 'show' | 'quickChat' | 'quit'): void {
        logger.log(`Executing tray action programmatically: ${action}`);

        switch (action) {
            case 'click':
                // Same as the tray click handler
                this._handleTrayClick();
                break;
            case 'show':
                this.windowManager.restoreFromTray();
                break;
            case 'quickChat':
                this.windowManager.showQuickChat();
                break;
            case 'quit':
                app.quit();
                break;
        }
    }

    /**
     * Destroy the system tray icon.
     * Should be called on app quit.
     */
    destroyTray(): void {
        try {
            if (this.tray && !this.tray.isDestroyed()) {
                this.tray.destroy();
                logger.log('Tray destroyed');
            }
            this.tray = null;
        } catch (error) {
            /* v8 ignore next -- defensive error handling */
            logger.error('Failed to destroy tray:', error);
        }
    }

    /**
     * Get the tray instance.
     * @returns The Tray instance or null if not created
     */
    getTray(): Tray | null {
        return this.tray;
    }

    /**
     * Get current tooltip text.
     * @returns The current tooltip string
     */
    getToolTip(): string {
        return this.currentToolTip;
    }

    /**
     * Set the tray tooltip to show an update notification.
     * @param version - The update version available
     */
    setUpdateTooltip(version: string): void {
        if (this.tray && !this.tray.isDestroyed()) {
            this.currentToolTip = `${TRAY_TOOLTIP} - Update v${version} available`;
            this.tray.setToolTip(this.currentToolTip);
            logger.log('Tray tooltip updated for version:', version);
        }
    }

    /**
     * Clear the update tooltip and restore default.
     */
    clearUpdateTooltip(): void {
        if (this.tray && !this.tray.isDestroyed()) {
            this.currentToolTip = TRAY_TOOLTIP;
            this.tray.setToolTip(this.currentToolTip);
            logger.log('Tray tooltip reset to default');
        }
    }
    private normalizeMacTrayImage(image: Electron.NativeImage): Electron.NativeImage {
        const size = image.getSize();
        const normalized = size.width > 32 || size.height > 32 ? image.resize({ width: 16, height: 16 }) : image;

        normalized.setTemplateImage(true);
        return normalized;
    }
}
