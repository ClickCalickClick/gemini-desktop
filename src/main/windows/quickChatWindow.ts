/**
 * Quick Chat Window class for the floating prompt.
 *
 * Handles:
 * - Spotlight-like floating window
 * - Positioning based on cursor/display
 * - Blur-to-hide behavior
 * - Toggle visibility
 *
 * @module QuickChatWindow
 */

import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from 'electron';
import BaseWindow from './baseWindow';
import {
    isWayland,
    QUICK_CHAT_MAX_HEIGHT,
    QUICK_CHAT_MIN_HEIGHT,
    QUICK_CHAT_WINDOW_CONFIG,
    QUICK_CHAT_WIDTH,
} from '../utils/constants';
import { getPreloadPath } from '../utils/paths';
import { getPlatformAdapter } from '../platform/platformAdapterFactory';

/**
 * Quick Chat floating window.
 * Spotlight-like appearance: frameless, transparent, always-on-top.
 */
export default class QuickChatWindow extends BaseWindow {
    protected readonly windowConfig: BrowserWindowConstructorOptions;
    protected readonly htmlFile = 'src/renderer/windows/quickchat/quickchat.html';

    /**
     * Creates a new QuickChatWindow instance.
     * @param isDev - Whether running in development mode
     */
    constructor(isDev: boolean) {
        super(isDev, '[QuickChatWindow]');
        this.windowConfig = QUICK_CHAT_WINDOW_CONFIG;
    }

    private _isReady = false;
    private _suppressBlurUntil = 0;
    private _readyToShowFallbackTimeout: ReturnType<typeof setTimeout> | null = null;

    /**
     * Create the Quick Chat window.
     * @returns The created BrowserWindow
     */
    create(): BrowserWindow {
        if (this.window) {
            return this.window;
        }

        const { x, y } = this.calculatePosition();

        this.window = new BrowserWindow({
            ...this.windowConfig,
            x,
            y,
            webPreferences: {
                ...this.windowConfig.webPreferences,
                preload: getPreloadPath(),
            },
        });

        // Track when window is actually ready
        this.window.webContents.once('did-finish-load', () => {
            this._isReady = true;
            this.emit('quick-chat-ready');
        });

        // Use parent class content loading
        this.loadContent();

        this.window.once('ready-to-show', () => {
            this.showWindow();
        });

        this._readyToShowFallbackTimeout = setTimeout(() => {
            this._readyToShowFallbackTimeout = null;

            if (this.window && !this.window.isDestroyed() && !this.window.isVisible()) {
                this.logger.warn('ready-to-show timeout - showing Quick Chat window via fallback');
                this.showWindow();
            }
        }, 1000);

        // Auto-hide when window loses focus (Spotlight behavior)
        this.window.on('blur', () => {
            this.handleBlur();
        });
        this.window.on('hide', () => {
            this.clearReadyToShowFallbackTimeout();
        });

        this.window.on('closed', () => {
            this.clearReadyToShowFallbackTimeout();
            this.window = null;
            this._isReady = false;
            this.emit('closed');
        });

        this.logger.log('Quick Chat window created');
        return this.window;
    }

    /**
     * Show and focus the Quick Chat window.
     * Creates the window if it doesn't exist.
     */
    showAndFocus(): void {
        if (!this.window) {
            this.create();
        } else {
            // Reposition to current cursor display
            const { x, y } = this.calculatePosition();

            if (this.window && !this.window.isDestroyed()) {
                this.window.setPosition(x, y);
                this.showWindow();
            }
        }
    }

    private showWindow(): void {
        if (!this.window || this.window.isDestroyed()) {
            return;
        }
        this._suppressBlurUntil = Date.now() + 500;
        // On GNOME Wayland a window that is open but not focused cannot raise itself without an
        // activation token, so the adapter hides and shows it again (B16, L21). A second instance's
        // XDG_ACTIVATION_TOKEN cannot be used here: Electron has no API to apply one to a window.
        getPlatformAdapter().bringToFront(this.window);
        // Focusing the window does not always give the page the keyboard, so the input would only
        // take typing after a click
        this.window.webContents.focus();
    }

    private handleBlur(): void {
        if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) {
            return;
        }
        if (Date.now() < this._suppressBlurUntil) {
            return;
        }
        this.hide();
    }

    handleMainWindowFocus(): void {
        this.handleBlur();
    }

    /**
     * Toggle Quick Chat window visibility.
     */
    toggle(): void {
        if (this.window && this.window.isVisible()) {
            this.hide();
        } else {
            this.showAndFocus();
        }
    }

    /**
     * Hide the Quick Chat window with logging.
     */
    override hide(): void {
        this.clearReadyToShowFallbackTimeout();

        if (this.window && !this.window.isDestroyed()) {
            this.window.hide();
            this.logger.log('Quick Chat window hidden');
        }
    }

    private clearReadyToShowFallbackTimeout(): void {
        if (this._readyToShowFallbackTimeout) {
            clearTimeout(this._readyToShowFallbackTimeout);
            this._readyToShowFallbackTimeout = null;
        }
    }

    /**
     * Resize the window to fit its content. The height is in CSS pixels, clamped to
     * QUICK_CHAT_MIN_HEIGHT..QUICK_CHAT_MAX_HEIGHT and scaled by the page zoom. The width
     * and the top edge stay where they are. Invalid numbers are ignored.
     */
    resizeToContent(height: unknown): void {
        if (typeof height !== 'number' || !Number.isFinite(height)) {
            return;
        }
        const win = this.window;
        if (!win || win.isDestroyed()) {
            return;
        }

        const zoomFactor = win.webContents.getZoomFactor?.() || 1;
        const clamped = Math.min(QUICK_CHAT_MAX_HEIGHT, Math.max(QUICK_CHAT_MIN_HEIGHT, height));
        let targetHeight = Math.round(clamped * zoomFactor);

        const bounds = win.getBounds();
        // Keep the bottom edge on screen (positions are unknown on Wayland, where the
        // compositor keeps the window on screen itself).
        if (!isWayland) {
            const workArea = screen.getDisplayMatching(bounds).workArea;
            const available = workArea.y + workArea.height - bounds.y;
            if (available > 0) {
                targetHeight = Math.min(targetHeight, available);
            }
        }
        if (targetHeight === bounds.height) {
            return;
        }

        // A window that is not resizable may ignore setSize on Linux.
        const wasResizable = win.isResizable();
        if (!wasResizable) {
            win.setResizable(true);
        }
        if (isWayland) {
            // Wayland apps cannot place their windows; only change the size.
            win.setSize(bounds.width, targetHeight);
        } else {
            win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: targetHeight });
        }
        if (!wasResizable) {
            win.setResizable(false);
        }
    }

    /**
     * Calculate position for Quick Chat window based on cursor location.
     * Centers horizontally on the active display, upper third vertically.
     */
    private calculatePosition(): { x: number; y: number } {
        const cursorPoint = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursorPoint);
        const { width: displayWidth, height: displayHeight } = display.workAreaSize;
        const { x: displayX, y: displayY } = display.workArea;

        /* v8 ignore next -- fallback for undefined constant, always defined */
        const windowWidth = this.windowConfig.width ?? QUICK_CHAT_WIDTH;
        const x = displayX + Math.round((displayWidth - windowWidth) / 2);
        const y = displayY + Math.round(displayHeight / 4);

        return { x, y };
    }

    /**
     * Check if window content is fully loaded.
     */
    isReady(): boolean {
        return this._isReady;
    }
}
