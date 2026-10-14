/**
 * Unit tests for LookIpcHandler.
 *
 * Tests look:get, look:set (validation, persistence, broadcast) and the accent watcher wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LookIpcHandler } from '../../../../src/main/managers/ipc/LookIpcHandler';
import type { AccentWatcherLike, LookIpcHandlerOptions } from '../../../../src/main/managers/ipc/LookIpcHandler';
import type { IpcHandlerDependencies } from '../../../../src/main/managers/ipc/types';
import { createMockLogger, createMockWindowManager, createMockStore } from '../../../helpers/mocks';
import { IPC_CHANNELS } from '../../../../src/shared/constants/ipc-channels';

type MockIpcListener = (...args: unknown[]) => void;
type MockIpcHandler = (...args: unknown[]) => unknown;

const { mockIpcMain, mockBrowserWindow } = vi.hoisted(() => {
    const mockIpcMain = {
        on: vi.fn((channel: string, listener: MockIpcListener) => {
            mockIpcMain._listeners.set(channel, listener);
        }),
        handle: vi.fn((channel: string, handler: MockIpcHandler) => {
            mockIpcMain._handlers.set(channel, handler);
        }),
        removeHandler: vi.fn(),
        removeAllListeners: vi.fn(),
        _listeners: new Map<string, MockIpcListener>(),
        _handlers: new Map<string, MockIpcHandler>(),
    };

    const mockWindow = {
        isDestroyed: vi.fn().mockReturnValue(false),
        id: 1,
        webContents: { send: vi.fn() },
    };

    const mockBrowserWindow = {
        getAllWindows: vi.fn().mockReturnValue([mockWindow]),
        fromWebContents: vi.fn().mockReturnValue(mockWindow),
        _mockWindow: mockWindow,
    };

    return { mockIpcMain, mockBrowserWindow };
});

vi.mock('electron', () => ({
    ipcMain: mockIpcMain,
    BrowserWindow: mockBrowserWindow,
}));

/** A fake accent watcher whose start() resolves when the test says so */
function createFakeWatcher() {
    let resolveStart: (accent: string | null) => void = () => {};
    let onChange: (accent: string | null) => void = () => {};
    const watcher = {
        start: vi.fn((callback: (accent: string | null) => void) => {
            onChange = callback;
            return new Promise<string | null>((resolve) => {
                resolveStart = resolve;
            });
        }),
        stop: vi.fn(),
    };
    return {
        watcher: watcher as AccentWatcherLike & typeof watcher,
        finishStart: (accent: string | null) => resolveStart(accent),
        emitChange: (accent: string | null) => onChange(accent),
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LookIpcHandler', () => {
    let mockStore: ReturnType<typeof createMockStore>;
    let mockLogger: ReturnType<typeof createMockLogger>;
    let deps: IpcHandlerDependencies;

    beforeEach(() => {
        vi.clearAllMocks();
        mockIpcMain._listeners.clear();
        mockIpcMain._handlers.clear();
        mockBrowserWindow._mockWindow.isDestroyed.mockReturnValue(false);
        mockBrowserWindow.getAllWindows.mockReturnValue([mockBrowserWindow._mockWindow]);

        mockLogger = createMockLogger();
        mockStore = createMockStore({ desktopLook: 'default' });
        deps = {
            store: mockStore as unknown as IpcHandlerDependencies['store'],
            logger: mockLogger as unknown as IpcHandlerDependencies['logger'],
            windowManager: createMockWindowManager() as unknown as IpcHandlerDependencies['windowManager'],
        };
    });

    function createHandler(options: LookIpcHandlerOptions = {}) {
        const fake = createFakeWatcher();
        const createAccentWatcher = vi.fn(() => fake.watcher);
        const handler = new LookIpcHandler(deps, {
            platform: 'linux',
            env: { XDG_CURRENT_DESKTOP: 'GNOME' },
            createAccentWatcher,
            ...options,
        });
        handler.register();
        return { handler, fake, createAccentWatcher };
    }

    const getLook = () => mockIpcMain._handlers.get(IPC_CHANNELS.LOOK_GET)!();
    const setLook = (value: unknown) => mockIpcMain._listeners.get(IPC_CHANNELS.LOOK_SET)!({}, value);

    describe('register', () => {
        it('registers look:get and look:set', () => {
            createHandler();
            expect(mockIpcMain.handle).toHaveBeenCalledWith(IPC_CHANNELS.LOOK_GET, expect.any(Function));
            expect(mockIpcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.LOOK_SET, expect.any(Function));
        });
    });

    describe('look:get', () => {
        it('returns the default look for existing users', () => {
            createHandler();
            expect(getLook()).toEqual({
                preference: 'default',
                effectiveLook: 'default',
                detectedDesktop: 'GNOME',
                accentColor: null,
            });
        });

        it('resolves auto from the desktop', () => {
            mockStore.set('desktopLook', 'auto');
            createHandler({ env: { XDG_CURRENT_DESKTOP: 'KDE' } });
            expect(getLook()).toMatchObject({
                preference: 'auto',
                effectiveLook: 'kde',
                detectedDesktop: 'KDE Plasma',
            });
        });

        it('resolves auto to the platform look on macOS and Windows', () => {
            mockStore.set('desktopLook', 'auto');
            createHandler({ platform: 'darwin', env: {} });
            expect(getLook()).toMatchObject({ effectiveLook: 'macos', detectedDesktop: 'macOS' });
        });

        it('falls back to default for an invalid stored value', () => {
            mockStore.set('desktopLook', 'bogus');
            createHandler();
            expect(getLook()).toMatchObject({ preference: 'default', effectiveLook: 'default' });
        });

        it('falls back to default when the store throws', () => {
            createHandler();
            mockStore.get.mockImplementation(() => {
                throw new Error('broken');
            });
            expect(getLook()).toMatchObject({ preference: 'default' });
            expect(mockLogger.error).toHaveBeenCalled();
        });
    });

    describe('look:set', () => {
        it('persists a valid look and broadcasts to all windows', () => {
            createHandler();
            setLook('kde');
            expect(mockStore.set).toHaveBeenCalledWith('desktopLook', 'kde');
            expect(mockBrowserWindow._mockWindow.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.LOOK_CHANGED, {
                preference: 'kde',
                effectiveLook: 'kde',
                detectedDesktop: 'GNOME',
                accentColor: null,
            });
        });

        it('rejects invalid looks without saving or broadcasting', () => {
            createHandler();
            for (const value of ['aqua', 'GNOME', 42, null, undefined]) {
                setLook(value);
            }
            expect(mockStore.set).not.toHaveBeenCalled();
            expect(mockBrowserWindow._mockWindow.webContents.send).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        it('skips destroyed windows', () => {
            createHandler();
            mockBrowserWindow._mockWindow.isDestroyed.mockReturnValue(true);
            setLook('gnome');
            expect(mockBrowserWindow._mockWindow.webContents.send).not.toHaveBeenCalled();
        });

        it('logs store errors', () => {
            createHandler();
            mockStore.set.mockImplementation(() => {
                throw new Error('disk full');
            });
            setLook('gnome');
            expect(mockLogger.error).toHaveBeenCalled();
        });
    });

    describe('accent color', () => {
        it('does not read the accent for the default look', () => {
            const { handler, createAccentWatcher } = createHandler();
            handler.initialize();
            expect(createAccentWatcher).not.toHaveBeenCalled();
        });

        it('does not read the accent on macOS or Windows', () => {
            mockStore.set('desktopLook', 'gnome');
            const { handler, createAccentWatcher } = createHandler({ platform: 'win32' });
            handler.initialize();
            expect(createAccentWatcher).not.toHaveBeenCalled();
        });

        it('reads the accent once a look applies and broadcasts it', async () => {
            mockStore.set('desktopLook', 'auto');
            const { handler, fake, createAccentWatcher } = createHandler();
            handler.initialize();
            expect(createAccentWatcher).toHaveBeenCalledWith(
                expect.objectContaining({ platform: 'linux', isKde: false })
            );

            fake.finishStart('#3584e4');
            await flush();
            expect(getLook()).toMatchObject({ effectiveLook: 'gnome', accentColor: '#3584e4' });
            expect(mockBrowserWindow._mockWindow.webContents.send).toHaveBeenCalledWith(
                IPC_CHANNELS.LOOK_CHANGED,
                expect.objectContaining({ accentColor: '#3584e4' })
            );
        });

        it('does not broadcast when the first read finds no accent', async () => {
            mockStore.set('desktopLook', 'gnome');
            const { handler, fake } = createHandler();
            handler.initialize();
            fake.finishStart(null);
            await flush();
            expect(mockBrowserWindow._mockWindow.webContents.send).not.toHaveBeenCalled();
        });

        it('broadcasts live accent changes', async () => {
            mockStore.set('desktopLook', 'gnome');
            const { handler, fake } = createHandler();
            handler.initialize();
            fake.finishStart(null);
            await flush();

            fake.emitChange('#e01b24');
            expect(mockBrowserWindow._mockWindow.webContents.send).toHaveBeenLastCalledWith(
                IPC_CHANNELS.LOOK_CHANGED,
                expect.objectContaining({ accentColor: '#e01b24' })
            );
        });

        it('starts reading when the user switches away from default', () => {
            const { handler, createAccentWatcher } = createHandler({ env: { XDG_CURRENT_DESKTOP: 'KDE' } });
            handler.initialize();
            setLook('auto');
            expect(createAccentWatcher).toHaveBeenCalledTimes(1);
            expect(createAccentWatcher).toHaveBeenCalledWith(expect.objectContaining({ isKde: true }));
            setLook('gnome');
            expect(createAccentWatcher).toHaveBeenCalledTimes(1);
        });

        it('logs a failing watcher', async () => {
            mockStore.set('desktopLook', 'gnome');
            const watcher = { start: vi.fn().mockRejectedValue(new Error('boom')), stop: vi.fn() };
            const handler = new LookIpcHandler(deps, {
                platform: 'linux',
                env: {},
                createAccentWatcher: () => watcher,
            });
            handler.initialize();
            await flush();
            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('stops the watcher on unregister', () => {
            mockStore.set('desktopLook', 'gnome');
            const { handler, fake } = createHandler();
            handler.initialize();
            handler.unregister();
            expect(fake.watcher.stop).toHaveBeenCalled();
            expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.LOOK_GET);
            expect(mockIpcMain.removeAllListeners).toHaveBeenCalledWith(IPC_CHANNELS.LOOK_SET);
        });

        it('uses the real watcher by default', () => {
            const handler = new LookIpcHandler(deps, { platform: 'darwin', env: {} });
            mockStore.set('desktopLook', 'macos');
            handler.initialize();
            handler.unregister();
        });
    });
});
