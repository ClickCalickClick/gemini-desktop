/**
 * Screenshot Manager: takes the screenshot Quick Chat attaches to a prompt (H10) and keeps it
 * until the prompt is sent.
 *
 * Quick Chat hides while the screenshot is taken, so it is not in the picture, and comes back
 * afterwards. Only the latest screenshot is kept, in memory, for at most 15 minutes; the renderer
 * gets a small preview and an id, and the Gemini tab or the agent run takes the image by that id.
 *
 * @module ScreenshotManager
 */

import { randomUUID } from 'node:crypto';

import { nativeImage } from 'electron';

import { captureScreenshot, PortalDeniedError, ScreenshotError, type CaptureOutcome } from '../utils/screenshotCapture';
import { createLogger } from '../utils/logger';
import {
    SCREENSHOT_ID_PATTERN,
    type ScreenshotCaptureResult,
    type ScreenshotMode,
    type ScreenshotPreview,
} from '../../shared/types/screenshot';
import type { Logger } from '../types';
import type WindowManager from './windowManager';

/** How long the window manager gets to hide Quick Chat before the screen is captured. */
export const HIDE_DELAY_MS = 300;
/** How long Quick Chat gets to take focus before the desktop is asked for the screenshot permission. */
export const FOCUS_DELAY_MS = 500;
/** Shown when the desktop still refuses after asking with Quick Chat focused. */
export const PERMISSION_DENIED_MESSAGE =
    'The desktop did not allow screenshots. On GNOME, allow them for Gemini Desktop in Settings > Apps > Gemini Desktop, or Shift+click the camera to pick an area.';
/** A screenshot not sent within this time is dropped. */
export const SCREENSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const THUMBNAIL_HEIGHT = 96;

export interface ScreenshotImageInfo {
    width: number;
    height: number;
    thumbnailDataUrl: string;
}

export interface ScreenshotManagerOptions {
    windowManager: Pick<WindowManager, 'hideQuickChat' | 'showQuickChat' | 'getQuickChatWindow'>;
    capture?: (mode: ScreenshotMode) => Promise<CaptureOutcome>;
    describeImage?: (png: Buffer) => ScreenshotImageInfo;
    hideDelayMs?: number;
    focusDelayMs?: number;
    now?: () => number;
    logger?: Logger;
}

interface StoredScreenshot {
    id: string;
    png: Buffer;
    takenAt: number;
}

function describePng(png: Buffer): ScreenshotImageInfo {
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) {
        throw new ScreenshotError('The screenshot could not be read.');
    }
    const { width, height } = image.getSize();
    return { width, height, thumbnailDataUrl: image.resize({ height: THUMBNAIL_HEIGHT }).toDataURL() };
}

export default class ScreenshotManager {
    private readonly windowManager: ScreenshotManagerOptions['windowManager'];
    private readonly captureFn: (mode: ScreenshotMode) => Promise<CaptureOutcome>;
    private readonly describeImage: (png: Buffer) => ScreenshotImageInfo;
    private readonly hideDelayMs: number;
    private readonly focusDelayMs: number;
    private readonly now: () => number;
    private readonly logger: Logger;

    private current: StoredScreenshot | null = null;
    private busy = false;

    constructor(options: ScreenshotManagerOptions) {
        this.windowManager = options.windowManager;
        this.captureFn = options.capture ?? ((mode) => captureScreenshot(mode));
        this.describeImage = options.describeImage ?? describePng;
        this.hideDelayMs = options.hideDelayMs ?? HIDE_DELAY_MS;
        this.focusDelayMs = options.focusDelayMs ?? FOCUS_DELAY_MS;
        this.now = options.now ?? (() => Date.now());
        this.logger = options.logger ?? createLogger('[ScreenshotManager]');
    }

    /** Hide Quick Chat, take the screenshot, show Quick Chat again and keep the image. */
    async capture(mode: unknown): Promise<ScreenshotCaptureResult> {
        if (mode !== 'screen' && mode !== 'area') {
            return { status: 'error', error: 'Invalid screenshot mode.' };
        }
        if (this.busy) {
            return { status: 'error', error: 'A screenshot is already being taken.' };
        }
        this.busy = true;
        const quickChat = this.windowManager.getQuickChatWindow();
        const quickChatWasVisible = Boolean(quickChat && !quickChat.isDestroyed() && quickChat.isVisible());
        try {
            if (quickChatWasVisible) {
                this.windowManager.hideQuickChat();
                await new Promise((resolve) => setTimeout(resolve, this.hideDelayMs));
            }
            let outcome: CaptureOutcome;
            try {
                outcome = await this.captureFn(mode);
            } catch (error) {
                if (!(error instanceof PortalDeniedError) || !quickChatWasVisible) {
                    throw error;
                }
                outcome = await this.askPermissionAndRetry(mode);
            }
            if (outcome.status === 'cancelled') {
                return { status: 'cancelled' };
            }
            const info = this.describeImage(outcome.png);
            const stored: StoredScreenshot = { id: randomUUID(), png: outcome.png, takenAt: this.now() };
            this.current = stored;
            this.logger.log('Screenshot ready:', { width: info.width, height: info.height, mode });
            const preview: ScreenshotPreview = { id: stored.id, ...info };
            return { status: 'captured', preview };
        } catch (error) {
            this.logger.error('Failed to take a screenshot:', (error as Error)?.message);
            return {
                status: 'error',
                error: error instanceof ScreenshotError ? error.message : 'The screenshot could not be taken.',
            };
        } finally {
            this.busy = false;
            if (quickChatWasVisible) {
                this.windowManager.showQuickChat();
            }
        }
    }

    /**
     * GNOME shows its "allow screenshots?" dialog only for the focused app, and refuses a first
     * screenshot taken while Quick Chat is hidden. Ask again with Quick Chat focused: the dialog
     * appears and remembers the answer. That picture shows Quick Chat, so it is thrown away and
     * the screenshot is taken once more with Quick Chat hidden.
     */
    private async askPermissionAndRetry(mode: ScreenshotMode): Promise<CaptureOutcome> {
        this.logger.log('Screenshot refused; asking again with Quick Chat focused');
        this.windowManager.showQuickChat();
        await new Promise((resolve) => setTimeout(resolve, this.focusDelayMs));
        let permission: CaptureOutcome;
        try {
            permission = await this.captureFn(mode);
        } catch (error) {
            if (error instanceof PortalDeniedError) {
                throw new ScreenshotError(PERMISSION_DENIED_MESSAGE);
            }
            throw error;
        }
        if (permission.status === 'cancelled') {
            return permission;
        }
        this.windowManager.hideQuickChat();
        await new Promise((resolve) => setTimeout(resolve, this.hideDelayMs));
        return this.captureFn(mode);
    }

    /** Hand over the screenshot with this id (once) and forget it. Null when it is unknown or too old. */
    take(id: unknown): Buffer | null {
        const current = this.current;
        if (typeof id !== 'string' || !SCREENSHOT_ID_PATTERN.test(id) || !current || current.id !== id) {
            return null;
        }
        this.current = null;
        if (this.now() - current.takenAt > SCREENSHOT_MAX_AGE_MS) {
            this.logger.warn('Screenshot dropped: too old');
            return null;
        }
        return current.png;
    }

    /** Forget the screenshot with this id (the user removed it). */
    discard(id: unknown): void {
        if (this.current && this.current.id === id) {
            this.current = null;
        }
    }
}
