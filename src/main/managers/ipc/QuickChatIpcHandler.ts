import { randomUUID } from 'node:crypto';

import { clipboard, ipcMain, nativeImage, type BrowserWindow, type WebFrameMain } from 'electron';

import { BaseIpcHandler } from './BaseIpcHandler';
import { IPC_CHANNELS, isGeminiDomain } from '../../utils/constants';
import type { GeminiReadyPayload } from '../../../shared/types/tabs';
import { getTabFrameName } from '../../../shared/types/tabs';
import { InjectionScriptBuilder, InjectionResult } from '../../utils/injectionScript';
import {
    buildAwaitClipboardPasteScript,
    buildPrepareClipboardPasteScript,
    buildSyntheticAttachScript,
    type ImageAttachResult,
} from '../../utils/imageAttachScript';
import { showToast } from '../../utils/toast';
import type { QuickChatSubmitOptions, ScreenshotCaptureResult } from '../../../shared/types/screenshot';

interface PendingQuickChatRequest {
    requestId: string;
    targetTabId: string;
    text: string;
    /** A screenshot to attach before the text (H10). */
    screenshot?: Buffer;
    /** The prompt came with a screenshot id, but the screenshot was gone or too old. */
    screenshotMissing?: boolean;
    createdAt: number;
}

const REQUEST_TTL_MS = 2 * 60 * 1000;

/** How long auto-submit waits for Gemini to finish uploading an attached screenshot. */
export const UPLOAD_SUBMIT_WAIT_MS = 30_000;

interface SavedClipboard {
    text: string;
    html: string;
    image: Electron.NativeImage;
}

function isGeminiReadyPayload(payload: unknown): payload is GeminiReadyPayload {
    if (typeof payload !== 'object' || payload === null) {
        return false;
    }

    const candidate = payload as Partial<GeminiReadyPayload>;
    return (
        typeof candidate.requestId === 'string' &&
        candidate.requestId.trim().length > 0 &&
        typeof candidate.targetTabId === 'string' &&
        candidate.targetTabId.trim().length > 0
    );
}

export class QuickChatIpcHandler extends BaseIpcHandler {
    private readonly pendingRequests = new Map<string, PendingQuickChatRequest>();
    private readonly latestRequestByTab = new Map<string, string>();

    private _clearLatestRequestByTabIfMatches(tabId: string, requestId: string): void {
        const latestRequestId = this.latestRequestByTab.get(tabId);
        if (latestRequestId === requestId) {
            this.latestRequestByTab.delete(tabId);
        }
    }

    register(): void {
        ipcMain.on(IPC_CHANNELS.QUICK_CHAT_SUBMIT, (_event, text: unknown, options?: unknown) => {
            this._handleSubmit(text, options);
        });

        ipcMain.handle(
            IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_CAPTURE,
            (_event, mode: unknown): Promise<ScreenshotCaptureResult> => this._handleScreenshotCapture(mode)
        );

        ipcMain.on(IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_DISCARD, (_event, id: unknown) => {
            this.deps.screenshotManager?.discard(id);
        });

        ipcMain.on(IPC_CHANNELS.GEMINI_READY, async (_event, payload: unknown) => {
            await this._handleGeminiReady(payload);
        });

        ipcMain.on(IPC_CHANNELS.QUICK_CHAT_HIDE, () => {
            this._handleHide();
        });

        ipcMain.on(IPC_CHANNELS.QUICK_CHAT_CANCEL, () => {
            this._handleCancel();
        });

        ipcMain.on(IPC_CHANNELS.QUICK_CHAT_RESIZE, (_event, height: unknown) => {
            this._handleResize(height);
        });
    }

    private _handleResize(height: unknown): void {
        try {
            if (typeof height !== 'number' || !Number.isFinite(height)) {
                return;
            }
            this.deps.windowManager.resizeQuickChat(height);
        } catch (error) {
            this.handleError('resizing quick chat', error);
        }
    }

    private _cleanupExpiredRequests(): void {
        const now = Date.now();
        for (const [requestId, request] of this.pendingRequests.entries()) {
            if (now - request.createdAt > REQUEST_TTL_MS) {
                this.pendingRequests.delete(requestId);
                this._clearLatestRequestByTabIfMatches(request.targetTabId, requestId);
            }
        }
    }

    private async _handleScreenshotCapture(mode: unknown): Promise<ScreenshotCaptureResult> {
        const manager = this.deps.screenshotManager;
        if (!manager) {
            return { status: 'error', error: 'Screenshots are not available in this build.' };
        }
        return manager.capture(mode);
    }

    /** The screenshot sent with a prompt, taken out of the screenshot manager. */
    private _takeScreenshot(options: unknown): { screenshot?: Buffer; screenshotMissing?: boolean } {
        if (typeof options !== 'object' || options === null) {
            return {};
        }
        const { screenshotId } = options as QuickChatSubmitOptions;
        if (screenshotId === undefined) {
            return {};
        }
        const png = this.deps.screenshotManager?.take(screenshotId) ?? null;
        if (!png) {
            this.logger.warn('Quick Chat screenshot not found; the text waits unsent');
            return { screenshotMissing: true };
        }
        return { screenshot: png };
    }

    private _handleSubmit(text: unknown, options?: unknown): void {
        try {
            if (typeof text !== 'string') {
                this.logger.warn('Ignoring Quick Chat submit without text');
                return;
            }
            this._cleanupExpiredRequests();
            this.logger.log('Quick Chat submit received:', text.substring(0, 50));
            const attachment = this._takeScreenshot(options);
            const screenshot = attachment.screenshot;

            this.deps.windowManager.hideQuickChat();
            this.deps.windowManager.focusMainWindow();

            const mainWindow = this.deps.windowManager.getMainWindow();
            if (!mainWindow) {
                this.logger.error('Cannot navigate: main window not found');
                return;
            }

            const requestId = randomUUID();
            const targetTabId = randomUUID();

            const request: PendingQuickChatRequest = {
                requestId,
                targetTabId,
                text,
                ...attachment,
                createdAt: Date.now(),
            };

            this.pendingRequests.set(requestId, request);
            // Drop the request (and any screenshot it holds) even if its tab never gets ready.
            setTimeout(() => this._cleanupExpiredRequests(), REQUEST_TTL_MS + 1000).unref?.();
            this.latestRequestByTab.set(targetTabId, requestId);

            this.logger.log('Quick Chat navigation requested:', {
                requestId,
                targetTabId,
                activeTabId: mainWindow.webContents.id,
                windowId: mainWindow.id,
                screenshot: Boolean(screenshot),
            });

            mainWindow.webContents.send(IPC_CHANNELS.GEMINI_NAVIGATE, {
                requestId,
                targetTabId,
                text,
            });
        } catch (error) {
            this.handleError('handling quick chat submit', error);
        }
    }

    private async _handleGeminiReady(payload: unknown): Promise<void> {
        try {
            this._cleanupExpiredRequests();

            if (!isGeminiReadyPayload(payload)) {
                this.logger.warn('Ignoring invalid gemini:ready payload');
                return;
            }

            const e2eBuffer = (
                global as typeof globalThis & {
                    __e2eGeminiReadyBuffer?: { enabled?: boolean; pending?: GeminiReadyPayload[] };
                }
            ).__e2eGeminiReadyBuffer;
            const shouldBuffer = process.argv.includes('--e2e-disable-auto-submit') && e2eBuffer?.enabled;

            this.logger.log('Gemini ready received:', payload);

            const request = this.pendingRequests.get(payload.requestId);
            if (!request) {
                this.logger.warn('Ignoring stale gemini:ready payload with unknown requestId');
                return;
            }

            if (request.targetTabId !== payload.targetTabId) {
                this.logger.warn('Ignoring gemini:ready payload with mismatched targetTabId');
                return;
            }

            const latestRequestId = this.latestRequestByTab.get(payload.targetTabId);
            if (latestRequestId !== payload.requestId) {
                this.logger.warn('Ignoring out-of-order gemini:ready payload for stale request');
                return;
            }

            if (shouldBuffer) {
                if (!Array.isArray(e2eBuffer?.pending)) {
                    if (e2eBuffer) {
                        e2eBuffer.pending = [];
                    }
                }
                e2eBuffer?.pending?.push(payload);
                this.logger.log('Buffered gemini:ready payload for E2E');
                return;
            }

            await this._injectTextIntoGeminiIframe(request);
            this.pendingRequests.delete(payload.requestId);
            this._clearLatestRequestByTabIfMatches(request.targetTabId, payload.requestId);
        } catch (error) {
            this.handleError('handling gemini ready', error);
        }
    }

    public flushE2EBufferedReady(): void {
        try {
            const e2eBuffer = (
                global as typeof globalThis & {
                    __e2eGeminiReadyBuffer?: { enabled?: boolean; pending?: GeminiReadyPayload[] };
                }
            ).__e2eGeminiReadyBuffer;

            if (!process.argv.includes('--e2e-disable-auto-submit') || !e2eBuffer?.enabled) {
                return;
            }

            const pending = Array.isArray(e2eBuffer.pending) ? [...e2eBuffer.pending] : [];
            e2eBuffer.pending = [];
            e2eBuffer.enabled = false;

            for (const payload of pending) {
                void this._handleGeminiReady(payload);
            }

            e2eBuffer.enabled = true;
        } catch (error) {
            this.handleError('flushing E2E gemini ready buffer', error);
        }
    }

    private _handleHide(): void {
        try {
            this.deps.windowManager.hideQuickChat();
        } catch (error) {
            this.handleError('hiding quick chat', error);
        }
    }

    private _handleCancel(): void {
        try {
            this.deps.windowManager.hideQuickChat();
            this.logger.log('Quick Chat cancelled');
        } catch (error) {
            this.handleError('cancelling quick chat', error);
        }
    }

    private async _injectTextIntoGeminiIframe(request: PendingQuickChatRequest): Promise<void> {
        const mainWindow = this.deps.windowManager.getMainWindow();
        if (!mainWindow) {
            this.logger.error('Cannot inject text: main window not found');
            return;
        }

        const frameName = getTabFrameName(request.targetTabId);
        const frames = mainWindow.webContents.mainFrame.frames;
        const targetFrame = frames.find((frame) => frame.name === frameName);

        this.logger.log('Quick Chat injection lookup:', {
            requestId: request.requestId,
            targetTabId: request.targetTabId,
            frameName,
            framesCount: frames.length,
            frameNames: frames.map((frame) => frame.name),
        });

        if (!targetFrame) {
            this.logger.error('Cannot inject text: target tab frame not found');
            return;
        }

        if (!isGeminiDomain(targetFrame.url)) {
            this.logger.error('Cannot inject text: target frame URL is not Gemini domain');
            return;
        }

        const isE2EMode = process.argv.includes('--e2e-disable-auto-submit');
        let attached = false;
        if (request.screenshot) {
            attached = await this._attachScreenshot(mainWindow, targetFrame, request.screenshot);
        }
        // Without the screenshot the answer would miss the point: leave the text for the user to send.
        const failedScreenshot = Boolean(request.screenshot) && !attached;
        const missingScreenshot = failedScreenshot || Boolean(request.screenshotMissing);
        if (missingScreenshot) {
            showToast(mainWindow, {
                type: 'warning',
                title: 'Screenshot not attached',
                message: failedScreenshot
                    ? 'Gemini did not take the screenshot. It is on the clipboard: paste it into the message box, then send.'
                    : 'The screenshot was no longer available. Take it again from Quick Chat, or send the prompt without it.',
                duration: 10_000,
            });
        }
        const injectionScript = new InjectionScriptBuilder()
            .withText(request.text)
            .withAutoSubmit(!isE2EMode && !missingScreenshot)
            .withSubmitWait(attached ? UPLOAD_SUBMIT_WAIT_MS : 0)
            .build();

        try {
            const result = (await targetFrame.executeJavaScript(injectionScript)) as InjectionResult;

            if (result?.success) {
                this.logger.log('Text injected into Gemini successfully');
            } else {
                this.logger.error('Injection script returned failure:', {
                    error: result?.error,
                    details: result?.details,
                });
            }
        } catch (error) {
            this.logger.error('Failed to inject text into Gemini:', error);
        }
    }

    /**
     * Attach a screenshot to the message box: as a paste or drop from a script first, then as a
     * real paste from the clipboard. When nothing works the image is left on the clipboard.
     */
    private async _attachScreenshot(mainWindow: BrowserWindow, frame: WebFrameMain, png: Buffer): Promise<boolean> {
        try {
            const result = (await frame.executeJavaScript(
                buildSyntheticAttachScript(png.toString('base64'))
            )) as ImageAttachResult;
            if (result?.attached) {
                this.logger.log('Screenshot attached in Gemini:', { method: result.method });
                return true;
            }
            this.logger.warn('Gemini did not take the screenshot from a script:', { error: result?.error });
        } catch (error) {
            this.logger.error('Failed to attach the screenshot from a script:', error);
        }

        const saved = this._saveClipboard();
        try {
            clipboard.writeImage(nativeImage.createFromBuffer(png));
            const prepared = (await frame.executeJavaScript(buildPrepareClipboardPasteScript())) as {
                ready: boolean;
                alreadyAttached?: boolean;
            } | null;
            if (prepared?.alreadyAttached) {
                // The script's paste or drop showed up late: pasting again would attach it twice.
                this.logger.log('Screenshot attached in Gemini:', { method: 'late' });
                this._restoreClipboard(saved);
                return true;
            }
            if (prepared?.ready) {
                mainWindow.webContents.paste();
                const result = (await frame.executeJavaScript(buildAwaitClipboardPasteScript())) as ImageAttachResult;
                if (result?.attached) {
                    this.logger.log('Screenshot attached in Gemini:', { method: result.method });
                    this._restoreClipboard(saved);
                    return true;
                }
            }
            this.logger.warn('Gemini did not take the screenshot from the clipboard either');
        } catch (error) {
            this.logger.error('Failed to paste the screenshot:', error);
        }
        return false;
    }

    private _saveClipboard(): SavedClipboard {
        return { text: clipboard.readText(), html: clipboard.readHTML(), image: clipboard.readImage() };
    }

    private _restoreClipboard(saved: SavedClipboard): void {
        try {
            if (saved.text || saved.html) {
                clipboard.write({ text: saved.text, html: saved.html });
            } else if (!saved.image.isEmpty()) {
                clipboard.writeImage(saved.image);
            } else {
                clipboard.clear();
            }
        } catch (error) {
            this.logger.warn('Could not restore the clipboard:', error);
        }
    }

    unregister(): void {
        ipcMain.removeAllListeners(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
        ipcMain.removeHandler(IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_CAPTURE);
        ipcMain.removeAllListeners(IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_DISCARD);
        ipcMain.removeAllListeners(IPC_CHANNELS.GEMINI_READY);
        ipcMain.removeAllListeners(IPC_CHANNELS.QUICK_CHAT_HIDE);
        ipcMain.removeAllListeners(IPC_CHANNELS.QUICK_CHAT_CANCEL);
        ipcMain.removeAllListeners(IPC_CHANNELS.QUICK_CHAT_RESIZE);
        this.pendingRequests.clear();
        this.latestRequestByTab.clear();
    }
}
