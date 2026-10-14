/**
 * Unit tests for QuickChatIpcHandler.
 *
 * Tests Quick Chat IPC handlers including:
 * - quick-chat:submit, hide, cancel
 * - gemini:ready with text injection
 * - E2E mode handling
 * - Error scenarios
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuickChatIpcHandler } from '../../../../src/main/managers/ipc/QuickChatIpcHandler';
import type { IpcHandlerDependencies } from '../../../../src/main/managers/ipc/types';
import { createMockLogger, createMockWindowManager, createMockStore } from '../../../helpers/mocks';
import { IPC_CHANNELS } from '../../../../src/shared/constants/ipc-channels';
import { getTabFrameName } from '../../../../src/shared/types/tabs';

// Mock Electron
const { mockIpcMain } = vi.hoisted(() => {
    const mockIpcMain = {
        on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
            mockIpcMain._listeners.set(channel, listener);
        }),
        handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
            mockIpcMain._handlers.set(channel, handler);
        }),
        _listeners: new Map<string, (...args: unknown[]) => void>(),
        _handlers: new Map<string, (...args: unknown[]) => unknown>(),
        _reset: () => {
            mockIpcMain._listeners.clear();
            mockIpcMain._handlers.clear();
        },
    };

    return { mockIpcMain };
});

const { mockClipboard, mockNativeImage } = vi.hoisted(() => ({
    mockClipboard: {
        readText: vi.fn(() => 'old text'),
        readHTML: vi.fn(() => ''),
        readImage: vi.fn(() => ({ isEmpty: () => true })),
        writeImage: vi.fn(),
        write: vi.fn(),
        clear: vi.fn(),
    },
    mockNativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => false })) },
}));

vi.mock('electron', () => ({
    ipcMain: mockIpcMain,
    clipboard: mockClipboard,
    nativeImage: mockNativeImage,
}));

vi.mock('../../../../src/main/utils/imageAttachScript', () => ({
    buildSyntheticAttachScript: () => 'synthetic-attach-script',
    buildPrepareClipboardPasteScript: () => 'prepare-paste-script',
    buildAwaitClipboardPasteScript: () => 'await-paste-script',
}));

// Mock InjectionScriptBuilder
let autoSubmitArg: boolean | null = null;
let submitWaitArg: number | null = null;

vi.mock('../../../../src/main/utils/injectionScript', () => ({
    InjectionScriptBuilder: class MockInjectionScriptBuilder {
        withText() {
            return this;
        }
        withAutoSubmit(value: boolean) {
            autoSubmitArg = value;
            return this;
        }
        withSubmitWait(value: number) {
            submitWaitArg = value;
            return this;
        }
        build() {
            return 'mocked-injection-script';
        }
    },
}));

// Note: We don't mock isGeminiDomain - it uses real implementation
// The test uses URLs like 'https://gemini.google.com/app' which match the real function

describe('QuickChatIpcHandler', () => {
    let handler: QuickChatIpcHandler;
    let mockDeps: IpcHandlerDependencies;
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockWindowManager: ReturnType<typeof createMockWindowManager>;
    let mockMainWindow: {
        isDestroyed?: () => boolean;
        webContents: {
            send: ReturnType<typeof vi.fn>;
            paste?: ReturnType<typeof vi.fn>;
            mainFrame: {
                frames: Array<{
                    name?: string;
                    url: string;
                    executeJavaScript: ReturnType<typeof vi.fn>;
                }>;
            };
        };
    };

    const getLatestRequestByTab = (): Map<string, string> =>
        (handler as unknown as { latestRequestByTab: Map<string, string> }).latestRequestByTab;

    beforeEach(() => {
        vi.clearAllMocks();
        mockIpcMain._reset();
        autoSubmitArg = null;
        submitWaitArg = null;

        mockLogger = createMockLogger();
        mockWindowManager = createMockWindowManager();

        // Create mock main window with webContents
        mockMainWindow = {
            isDestroyed: () => false,
            webContents: {
                send: vi.fn(),
                paste: vi.fn(),
                mainFrame: {
                    frames: [],
                },
            },
        };

        // Mock windowManager.getMainWindow to return our mock
        (mockWindowManager.getMainWindow as ReturnType<typeof vi.fn>).mockReturnValue(mockMainWindow);

        mockDeps = {
            store: createMockStore({}),
            logger: mockLogger,
            windowManager: mockWindowManager,
        } as unknown as IpcHandlerDependencies;

        handler = new QuickChatIpcHandler(mockDeps);
    });

    describe('register', () => {
        it('registers all expected IPC listeners', () => {
            handler.register();

            expect(mockIpcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.QUICK_CHAT_SUBMIT, expect.any(Function));
            expect(mockIpcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.GEMINI_READY, expect.any(Function));
            expect(mockIpcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.QUICK_CHAT_HIDE, expect.any(Function));
            expect(mockIpcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.QUICK_CHAT_CANCEL, expect.any(Function));
            expect(mockIpcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.QUICK_CHAT_RESIZE, expect.any(Function));
        });
    });

    describe('quick-chat:resize handler', () => {
        beforeEach(() => {
            handler.register();
        });

        it('passes a valid height to windowManager.resizeQuickChat', () => {
            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_RESIZE);
            listener!({}, 320);

            expect(mockWindowManager.resizeQuickChat).toHaveBeenCalledWith(320);
        });

        it('ignores invalid heights', () => {
            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_RESIZE);
            for (const value of ['320', NaN, Infinity, null, undefined, {}]) {
                listener!({}, value);
            }

            expect(mockWindowManager.resizeQuickChat).not.toHaveBeenCalled();
        });

        it('logs errors from the window manager', () => {
            mockWindowManager.resizeQuickChat.mockImplementation(() => {
                throw new Error('Resize error');
            });
            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_RESIZE);
            listener!({}, 200);

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Error during resizing quick chat:',
                expect.objectContaining({ error: 'Resize error' })
            );
        });
    });

    describe('quick-chat:submit handler', () => {
        beforeEach(() => {
            handler.register();
        });

        it('hides quick chat and focuses main window (4.2.7)', () => {
            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
            listener!({}, 'Hello Gemini!');

            expect(mockWindowManager.hideQuickChat).toHaveBeenCalled();
            expect(mockWindowManager.focusMainWindow).toHaveBeenCalled();
        });

        it('sends gemini:navigate to main window with text', () => {
            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
            listener!({}, 'Hello Gemini!');

            expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
                IPC_CHANNELS.GEMINI_NAVIGATE,
                expect.objectContaining({
                    requestId: expect.any(String),
                    targetTabId: expect.any(String),
                    text: 'Hello Gemini!',
                })
            );
        });

        it('logs error when main window is not found (4.2.8)', () => {
            (mockWindowManager.getMainWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
            listener!({}, 'Hello Gemini!');

            expect(mockLogger.error).toHaveBeenCalledWith('Cannot navigate: main window not found');
        });

        it('logs truncated text preview', () => {
            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
            listener!({}, 'Hello Gemini!');

            expect(mockLogger.log).toHaveBeenCalledWith(
                'Quick Chat submit received:',
                expect.stringContaining('Hello Gemini')
            );
        });

        it('removes expired latest request mapping before accepting a new request', () => {
            const nowSpy = vi.spyOn(Date, 'now');
            try {
                nowSpy.mockReturnValue(1);

                const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
                listener!({}, 'First request');

                const firstPayload = mockMainWindow.webContents.send.mock.calls[0]?.[1] as {
                    requestId: string;
                    targetTabId: string;
                };

                expect(getLatestRequestByTab().get(firstPayload.targetTabId)).toBe(firstPayload.requestId);

                nowSpy.mockReturnValue(2 * 60 * 1000 + 2);
                listener!({}, 'Second request');

                expect(getLatestRequestByTab().has(firstPayload.targetTabId)).toBe(false);
            } finally {
                nowSpy.mockRestore();
            }
        });
    });

    describe('quick-chat:hide handler', () => {
        beforeEach(() => {
            handler.register();
        });

        it('calls windowManager.hideQuickChat (4.2.9)', () => {
            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_HIDE);
            listener!();

            expect(mockWindowManager.hideQuickChat).toHaveBeenCalled();
        });

        it('handles error gracefully', () => {
            (mockWindowManager.hideQuickChat as ReturnType<typeof vi.fn>).mockImplementation(() => {
                throw new Error('Hide error');
            });

            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_HIDE);

            expect(() => listener!()).not.toThrow();
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Error during hiding quick chat:',
                expect.objectContaining({ error: 'Hide error' })
            );
        });
    });

    describe('quick-chat:cancel handler', () => {
        beforeEach(() => {
            handler.register();
        });

        it('calls windowManager.hideQuickChat (4.2.10)', () => {
            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_CANCEL);
            listener!();

            expect(mockWindowManager.hideQuickChat).toHaveBeenCalled();
        });

        it('logs cancellation', () => {
            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_CANCEL);
            listener!();

            expect(mockLogger.log).toHaveBeenCalledWith('Quick Chat cancelled');
        });
    });

    describe('gemini:ready handler', () => {
        beforeEach(() => {
            handler.register();
        });

        it('triggers text injection (4.2.11)', async () => {
            const submitListener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
            submitListener!({}, 'Inject this text');

            const navigatePayload = mockMainWindow.webContents.send.mock.calls[0]?.[1] as {
                requestId: string;
                targetTabId: string;
            };

            const mockGeminiFrame = {
                name: getTabFrameName(navigatePayload.targetTabId),
                url: 'https://gemini.google.com/app',
                executeJavaScript: vi.fn().mockResolvedValue({ success: true }),
            };
            mockMainWindow.webContents.mainFrame.frames = [mockGeminiFrame];

            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.GEMINI_READY);
            await listener!({}, navigatePayload);

            expect(mockGeminiFrame.executeJavaScript).toHaveBeenCalled();
            expect(mockLogger.log).toHaveBeenCalledWith('Text injected into Gemini successfully');
            expect(getLatestRequestByTab().has(navigatePayload.targetTabId)).toBe(false);
        });

        it('logs error when Gemini iframe not found (4.2.12)', async () => {
            const submitListener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
            submitListener!({}, 'Inject this text');

            const navigatePayload = mockMainWindow.webContents.send.mock.calls[0]?.[1] as {
                requestId: string;
                targetTabId: string;
            };

            mockMainWindow.webContents.mainFrame.frames = [
                { name: 'gemini-tab-some-other-id', url: 'https://gemini.google.com/app', executeJavaScript: vi.fn() },
            ];

            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.GEMINI_READY);
            await listener!({}, navigatePayload);

            expect(mockLogger.error).toHaveBeenCalledWith('Cannot inject text: target tab frame not found');
        });

        it('logs error when main window not found', async () => {
            const submitListener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
            submitListener!({}, 'Inject this text');

            const navigatePayload = mockMainWindow.webContents.send.mock.calls[0]?.[1] as {
                requestId: string;
                targetTabId: string;
            };

            (mockWindowManager.getMainWindow as ReturnType<typeof vi.fn>).mockReturnValue(null);

            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.GEMINI_READY);
            await listener!({}, navigatePayload);

            expect(mockLogger.error).toHaveBeenCalledWith('Cannot inject text: main window not found');
        });

        it('handles injection script failure (4.2.14)', async () => {
            const submitListener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
            submitListener!({}, 'Inject this text');

            const navigatePayload = mockMainWindow.webContents.send.mock.calls[0]?.[1] as {
                requestId: string;
                targetTabId: string;
            };

            const mockGeminiFrame = {
                name: getTabFrameName(navigatePayload.targetTabId),
                url: 'https://gemini.google.com/app',
                executeJavaScript: vi.fn().mockResolvedValue({ success: false, error: 'Editor not found' }),
            };
            mockMainWindow.webContents.mainFrame.frames = [mockGeminiFrame];

            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.GEMINI_READY);
            await listener!({}, navigatePayload);

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Injection script returned failure:',
                expect.objectContaining({
                    details: undefined,
                    error: 'Editor not found',
                })
            );
        });

        it('handles executeJavaScript exception', async () => {
            const submitListener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
            submitListener!({}, 'Inject this text');

            const navigatePayload = mockMainWindow.webContents.send.mock.calls[0]?.[1] as {
                requestId: string;
                targetTabId: string;
            };

            const mockGeminiFrame = {
                name: getTabFrameName(navigatePayload.targetTabId),
                url: 'https://gemini.google.com/app',
                executeJavaScript: vi.fn().mockRejectedValue(new Error('JS execution failed')),
            };
            mockMainWindow.webContents.mainFrame.frames = [mockGeminiFrame];

            const listener = mockIpcMain._listeners.get(IPC_CHANNELS.GEMINI_READY);
            await listener!({}, navigatePayload);

            expect(mockLogger.error).toHaveBeenCalledWith('Failed to inject text into Gemini:', expect.any(Error));
        });
    });

    describe('E2E mode handling', () => {
        beforeEach(() => {
            handler.register();
        });

        it('disables auto-submit in E2E mode (4.2.13)', async () => {
            // Mock E2E mode
            const originalArgv = process.argv;
            process.argv = [...originalArgv, '--e2e-disable-auto-submit'];

            try {
                const submitListener = mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT);
                submitListener!({}, 'Test text');

                const navigatePayload = mockMainWindow.webContents.send.mock.calls[0]?.[1] as {
                    requestId: string;
                    targetTabId: string;
                };

                const mockGeminiFrame = {
                    name: getTabFrameName(navigatePayload.targetTabId),
                    url: 'https://gemini.google.com/app',
                    executeJavaScript: vi.fn().mockResolvedValue({ success: true }),
                };
                mockMainWindow.webContents.mainFrame.frames = [mockGeminiFrame];

                const listener = mockIpcMain._listeners.get(IPC_CHANNELS.GEMINI_READY);
                await listener!({}, navigatePayload);

                expect(autoSubmitArg).toBe(false);
            } finally {
                process.argv = originalArgv;
            }
        });
    });

    describe('screenshots (H10)', () => {
        const SCREENSHOT_ID = '0b4d8a46-2f4e-4b8e-9d0a-1c2b3c4d5e6f';
        const png = Buffer.from('fake-png');
        let screenshotManager: {
            capture: ReturnType<typeof vi.fn>;
            take: ReturnType<typeof vi.fn>;
            discard: ReturnType<typeof vi.fn>;
        };

        beforeEach(() => {
            screenshotManager = {
                capture: vi.fn().mockResolvedValue({ status: 'cancelled' }),
                take: vi.fn((id: unknown) => (id === SCREENSHOT_ID ? png : null)),
                discard: vi.fn(),
            };
            (mockDeps as unknown as { screenshotManager: unknown }).screenshotManager = screenshotManager;
            handler.register();
        });

        /** Submit, then answer gemini:ready with a frame whose executeJavaScript runs `scripts`. */
        async function submitAndInject(
            options: unknown,
            scripts: Record<string, unknown>
        ): Promise<ReturnType<typeof vi.fn>> {
            mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT)!({}, 'What is this?', options);
            const navigatePayload = mockMainWindow.webContents.send.mock.calls[0]?.[1] as {
                requestId: string;
                targetTabId: string;
            };
            const executeJavaScript = vi.fn(async (script: string) =>
                script in scripts ? scripts[script] : { success: true }
            );
            mockMainWindow.webContents.mainFrame.frames = [
                {
                    name: getTabFrameName(navigatePayload.targetTabId),
                    url: 'https://gemini.google.com/app',
                    executeJavaScript,
                },
            ];
            await mockIpcMain._listeners.get(IPC_CHANNELS.GEMINI_READY)!({}, navigatePayload);
            return executeJavaScript;
        }

        it('registers the capture and discard channels', () => {
            expect(mockIpcMain.handle).toHaveBeenCalledWith(
                IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_CAPTURE,
                expect.any(Function)
            );
            expect(mockIpcMain.on).toHaveBeenCalledWith(
                IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_DISCARD,
                expect.any(Function)
            );
        });

        it('passes capture and discard to the screenshot manager', async () => {
            const capture = mockIpcMain._handlers.get(IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_CAPTURE)!;
            await expect(capture({}, 'area')).resolves.toEqual({ status: 'cancelled' });
            expect(screenshotManager.capture).toHaveBeenCalledWith('area');

            mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_DISCARD)!({}, SCREENSHOT_ID);
            expect(screenshotManager.discard).toHaveBeenCalledWith(SCREENSHOT_ID);
        });

        it('reports an error when there is no screenshot manager', async () => {
            (mockDeps as unknown as { screenshotManager: unknown }).screenshotManager = null;
            const capture = mockIpcMain._handlers.get(IPC_CHANNELS.QUICK_CHAT_SCREENSHOT_CAPTURE)!;
            await expect(capture({}, 'screen')).resolves.toMatchObject({ status: 'error' });
        });

        it('attaches the screenshot before the text and waits for the upload to submit', async () => {
            const executeJavaScript = await submitAndInject(
                { screenshotId: SCREENSHOT_ID },
                { 'synthetic-attach-script': { attached: true, method: 'paste' } }
            );

            expect(screenshotManager.take).toHaveBeenCalledWith(SCREENSHOT_ID);
            expect(executeJavaScript.mock.calls.map((call) => call[0])).toEqual([
                'synthetic-attach-script',
                'mocked-injection-script',
            ]);
            expect(autoSubmitArg).toBe(true);
            expect(submitWaitArg).toBeGreaterThan(0);
            expect(mockClipboard.writeImage).not.toHaveBeenCalled();
        });

        it('pastes from the clipboard when the script cannot attach, then restores the clipboard', async () => {
            const executeJavaScript = await submitAndInject(
                { screenshotId: SCREENSHOT_ID },
                {
                    'synthetic-attach-script': { attached: false, error: 'no_preview_seen' },
                    'prepare-paste-script': { ready: true },
                    'await-paste-script': { attached: true, method: 'clipboard' },
                }
            );

            expect(executeJavaScript.mock.calls.map((call) => call[0])).toEqual([
                'synthetic-attach-script',
                'prepare-paste-script',
                'await-paste-script',
                'mocked-injection-script',
            ]);
            expect(mockClipboard.writeImage).toHaveBeenCalledTimes(1);
            expect(mockMainWindow.webContents.paste).toHaveBeenCalledTimes(1);
            expect(mockClipboard.write).toHaveBeenCalledWith({ text: 'old text', html: '' });
            expect(autoSubmitArg).toBe(true);
        });

        it('leaves the text unsent and the image on the clipboard when Gemini takes no screenshot', async () => {
            await submitAndInject(
                { screenshotId: SCREENSHOT_ID },
                {
                    'synthetic-attach-script': { attached: false },
                    'prepare-paste-script': { ready: true },
                    'await-paste-script': { attached: false },
                }
            );

            expect(autoSubmitArg).toBe(false);
            expect(mockClipboard.write).not.toHaveBeenCalled();
            expect(mockClipboard.clear).not.toHaveBeenCalled();
            expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
                IPC_CHANNELS.TOAST_SHOW,
                expect.objectContaining({ type: 'warning', title: 'Screenshot not attached' })
            );
        });

        it('leaves the text unsent when the screenshot is gone or too old', async () => {
            const executeJavaScript = await submitAndInject({ screenshotId: 'something-else' }, {});

            expect(executeJavaScript.mock.calls.map((call) => call[0])).toEqual(['mocked-injection-script']);
            expect(autoSubmitArg).toBe(false);
            expect(submitWaitArg).toBe(0);
            expect(mockLogger.warn).toHaveBeenCalledWith('Quick Chat screenshot not found; the text waits unsent');
            expect(mockClipboard.writeImage).not.toHaveBeenCalled();
            expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
                IPC_CHANNELS.TOAST_SHOW,
                expect.objectContaining({ message: expect.stringContaining('Take it again') })
            );
        });

        it('does not paste a second copy when the script paste showed up late', async () => {
            const executeJavaScript = await submitAndInject(
                { screenshotId: SCREENSHOT_ID },
                {
                    'synthetic-attach-script': { attached: false, error: 'no_preview_seen' },
                    'prepare-paste-script': { ready: false, alreadyAttached: true },
                }
            );

            expect(executeJavaScript.mock.calls.map((call) => call[0])).toEqual([
                'synthetic-attach-script',
                'prepare-paste-script',
                'mocked-injection-script',
            ]);
            expect(mockMainWindow.webContents.paste).not.toHaveBeenCalled();
            expect(autoSubmitArg).toBe(true);
        });

        it('sends no plain text submit for a prompt without a screenshot', async () => {
            await submitAndInject(undefined, {});
            expect(autoSubmitArg).toBe(true);
            expect(mockMainWindow.webContents.send).not.toHaveBeenCalledWith(
                IPC_CHANNELS.TOAST_SHOW,
                expect.anything()
            );
        });

        it('ignores a submit without text', () => {
            mockIpcMain._listeners.get(IPC_CHANNELS.QUICK_CHAT_SUBMIT)!({}, { text: 'x' });
            expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
        });
    });
});
