import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockApp, mockSession, mockBrowserWindow } = vi.hoisted(() => {
    const mockApp = {
        commandLine: {
            appendSwitch: vi.fn(),
            hasSwitch: vi.fn().mockReturnValue(false),
        },
        isPackaged: false,
        isReady: vi.fn().mockReturnValue(true),
        on: vi.fn(),
        whenReady: vi.fn().mockResolvedValue(undefined),
        requestSingleInstanceLock: vi.fn().mockReturnValue(true),
        exit: vi.fn(),
        quit: vi.fn(),
        setName: vi.fn(),
        setAppUserModelId: vi.fn(),
        setPath: vi.fn(),
        getPath: vi.fn().mockReturnValue('/mock/userData'),
        getVersion: vi.fn().mockReturnValue('1.0.0'),
    };

    const mockSession = {
        defaultSession: {
            webRequest: {
                onHeadersReceived: vi.fn(),
                onBeforeSendHeaders: vi.fn(),
                onCompleted: vi.fn(),
            },
        },
    };

    const mockBrowserWindow = {
        getAllWindows: vi.fn().mockReturnValue([]),
        fromWebContents: vi.fn(),
    };

    return { mockApp, mockSession, mockBrowserWindow };
});

vi.mock('electron', () => ({
    app: mockApp,
    session: mockSession,
    BrowserWindow: mockBrowserWindow,
    crashReporter: {
        start: vi.fn(),
    },
}));

vi.mock('../../../src/main/utils/logger');

// Mock the platform adapter factory instead of constants
const mockAdapter = vi.hoisted(() => ({
    id: 'linux-wayland' as const,
    applyAppConfiguration: vi.fn(),
    applyAppUserModelId: vi.fn(),
    getHotkeyRegistrationPlan: vi.fn().mockReturnValue({
        mode: 'wayland-dbus',
        waylandStatus: {
            isWayland: true,
            desktopEnvironment: 'kde',
            deVersion: '6',
            portalAvailable: true,
            portalMethod: 'none',
        },
    }),
    getWaylandStatus: vi.fn().mockReturnValue({
        isWayland: true,
        desktopEnvironment: 'kde',
        deVersion: '6',
        portalAvailable: true,
        portalMethod: 'none',
    }),
    shouldQuitOnWindowAllClosed: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../src/main/platform/platformAdapterFactory', () => ({
    getPlatformAdapter: vi.fn().mockReturnValue(mockAdapter),
}));

vi.mock('../../../src/main/utils/paths', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/main/utils/paths')>();
    return {
        ...actual,
        getDistHtmlPath: vi.fn().mockReturnValue('/mock/dist/index.html'),
        getIconPath: vi.fn().mockReturnValue('/mock/icon.png'),
    };
});

vi.mock('fs', () => ({
    existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/main/utils/security', () => ({
    setupHeaderStripping: vi.fn(),
    setupWebviewSecurity: vi.fn(),
    setupMediaPermissions: vi.fn(),
}));

vi.mock('../../../src/main/utils/sandboxInit', () => ({}));

vi.mock('../../../src/main/store', () => ({
    default: vi.fn(),
}));

vi.mock('../../../src/main/managers/windowManager', () => {
    return {
        default: class WindowManager {
            setQuitting = vi.fn();
            getMainWindow = vi.fn().mockReturnValue(null);
            getMainWindowInstance = vi.fn().mockReturnValue(null);
            createMainWindow = vi.fn();
            restoreFromTray = vi.fn();
            showQuickChat = vi.fn();
            hideToTray = vi.fn();
            setAlwaysOnTop = vi.fn();
            isAlwaysOnTop = vi.fn().mockReturnValue(false);
            constructor() {
                return;
            }
        },
    };
});

vi.mock('../../../src/main/managers/ipcManager', () => {
    return {
        default: class IpcManager {
            setupIpcHandlers = vi.fn();
            getTabStateIpcHandler = vi.fn().mockReturnValue(null);
            setNotificationManager = vi.fn();
            initializeTextPrediction = vi.fn().mockResolvedValue(undefined);
            dispose = vi.fn();
            constructor() {
                return;
            }
        },
    };
});

vi.mock('../../../src/main/managers/hotkeyManager', () => {
    return {
        default: class HotkeyManager {
            registerShortcuts = vi.fn();
            unregisterAll = vi.fn();
            constructor() {
                return;
            }
        },
    };
});

vi.mock('../../../src/main/managers/trayManager', () => {
    return {
        default: class TrayManager {
            createTray = vi.fn();
            destroyTray = vi.fn();
            constructor() {
                return;
            }
        },
    };
});

vi.mock('../../../src/main/managers/badgeManager', () => {
    return {
        default: class BadgeManager {
            setMainWindow = vi.fn();
            constructor() {
                return;
            }
        },
    };
});

vi.mock('../../../src/main/managers/updateManager', () => {
    return {
        default: class UpdateManager {
            startPeriodicChecks = vi.fn();
            destroy = vi.fn();
            constructor() {
                return;
            }
        },
    };
});

vi.mock('../../../src/main/managers/exportManager', () => {
    return {
        default: class ExportManager {
            constructor() {
                return;
            }
        },
    };
});

vi.mock('../../../src/main/managers/llmManager', () => {
    return {
        default: class LlmManager {
            dispose = vi.fn();
            constructor() {
                return;
            }
        },
    };
});

vi.mock('../../../src/main/managers/notificationManager', () => {
    return {
        default: class NotificationManager {
            dispose = vi.fn();
            onResponseComplete = vi.fn();
            constructor() {
                return;
            }
        },
    };
});

const mockTerminationSignals = vi.hoisted(() => ({
    install: vi.fn(),
    handleProcessGone: vi.fn(),
}));

vi.mock('../../../src/main/utils/terminationSignals', () => ({
    default: class TerminationSignals {
        install = mockTerminationSignals.install;
        handleProcessGone = mockTerminationSignals.handleProcessGone;
    },
}));

vi.mock('../../../src/main/managers/menuManager', () => {
    return {
        default: class MenuManager {
            buildMenu = vi.fn();
            setupContextMenu = vi.fn();
            constructor() {
                return;
            }
        },
    };
});

/** Process events main.ts listens to */
const PROCESS_EVENTS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'uncaughtException', 'unhandledRejection'] as const;

describe('main.ts', () => {
    let listenersBefore: Map<string, unknown[]>;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        listenersBefore = new Map(PROCESS_EVENTS.map((event) => [event, process.listeners(event)]));
    });

    afterEach(() => {
        vi.resetModules();
        // Remove the listeners main.ts added, so they do not pile up in the test process
        for (const event of PROCESS_EVENTS) {
            for (const listener of process.listeners(event)) {
                if (!listenersBefore.get(event)?.includes(listener)) {
                    process.removeListener(event, listener as (...args: unknown[]) => void);
                }
            }
        }
    });

    function addedListenerCount(event: (typeof PROCESS_EVENTS)[number]) {
        return process.listenerCount(event) - (listenersBefore.get(event)?.length ?? 0);
    }

    it('calls adapter.applyAppConfiguration() on startup', async () => {
        await import('../../../src/main/main');

        expect(mockAdapter.applyAppConfiguration).toHaveBeenCalledWith(mockApp, expect.anything());
    });

    it('calls adapter.applyAppUserModelId() on startup', async () => {
        await import('../../../src/main/main');

        expect(mockAdapter.applyAppUserModelId).toHaveBeenCalledWith(mockApp);
    });

    it('does not enable GlobalShortcutsPortal chromium flag', async () => {
        await import('../../../src/main/main');

        const appendCalls = vi.mocked(mockApp.commandLine.appendSwitch).mock.calls;
        const hasGlobalShortcutsPortal = appendCalls.some(
            ([flag, value]) => flag === 'enable-features' && value === 'GlobalShortcutsPortal'
        );
        expect(hasGlobalShortcutsPortal).toBe(false);
    });

    describe('second-instance', () => {
        type WindowManagerMock = {
            getMainWindow: ReturnType<typeof vi.fn>;
            createMainWindow: ReturnType<typeof vi.fn>;
            restoreFromTray: ReturnType<typeof vi.fn>;
            showQuickChat: ReturnType<typeof vi.fn>;
        };

        async function loadMain(): Promise<WindowManagerMock> {
            await import('../../../src/main/main');
            const context = (global as typeof globalThis & { appContext?: { windowManager: WindowManagerMock } })
                .appContext;
            if (!context) throw new Error('main.ts exposed no appContext');
            // Let the app.whenReady() startup run first, then forget its calls
            await new Promise((resolve) => setImmediate(resolve));
            context.windowManager.createMainWindow.mockClear();
            return context.windowManager;
        }

        it('passes --quick-chat to the running app as single-instance data', async () => {
            await loadMain();

            expect(mockApp.requestSingleInstanceLock).toHaveBeenCalledWith({ quickChat: false });
        });

        it('opens Quick Chat when the second instance was started with --quick-chat', async () => {
            const windowManager = await loadMain();
            windowManager.getMainWindow.mockReturnValue({});

            getAppHandler('second-instance')({}, ['/opt/Gemini Desktop/gemini-desktop', '--quick-chat'], '/', {});

            expect(windowManager.showQuickChat).toHaveBeenCalledTimes(1);
            expect(windowManager.restoreFromTray).not.toHaveBeenCalled();
            expect(windowManager.createMainWindow).not.toHaveBeenCalled();
        });

        it('opens Quick Chat from the single-instance data, creating the main window hidden if needed', async () => {
            const windowManager = await loadMain();
            windowManager.getMainWindow.mockReturnValue(null);

            getAppHandler('second-instance')({}, ['/usr/bin/gemini-desktop'], '/', { quickChat: true });

            expect(windowManager.createMainWindow).toHaveBeenCalledWith({ startHidden: true });
            expect(windowManager.showQuickChat).toHaveBeenCalledTimes(1);
        });

        it('with --quick-chat at startup, creates the main window hidden and opens Quick Chat once ready', async () => {
            const argv = process.argv;
            process.argv = [...argv, '--quick-chat'];
            try {
                await import('../../../src/main/main');
                await new Promise((resolve) => setImmediate(resolve));
            } finally {
                process.argv = argv;
            }
            const windowManager = (global as typeof globalThis & { appContext?: { windowManager: WindowManagerMock } })
                .appContext?.windowManager;

            expect(mockApp.requestSingleInstanceLock).toHaveBeenCalledWith({ quickChat: true });
            expect(windowManager?.createMainWindow).toHaveBeenCalledWith({ startHidden: true });
            expect(windowManager?.showQuickChat).toHaveBeenCalledTimes(1);
        });

        it('focuses the main window on a plain second start', async () => {
            const windowManager = await loadMain();
            windowManager.getMainWindow.mockReturnValue({});

            getAppHandler('second-instance')({}, ['/usr/bin/gemini-desktop'], '/', { quickChat: false });

            expect(windowManager.restoreFromTray).toHaveBeenCalledTimes(1);
            expect(windowManager.showQuickChat).not.toHaveBeenCalled();
        });
    });

    describe('termination signals', () => {
        const originalPlatform = process.platform;

        function setPlatform(platform: NodeJS.Platform) {
            Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        }

        afterEach(() => {
            setPlatform(originalPlatform);
        });

        it('on Linux, adds no signal listener while loading and hands the signals over once ready', async () => {
            setPlatform('linux');
            let ready: () => void = () => {};
            mockApp.whenReady.mockReturnValueOnce(new Promise<void>((resolve) => (ready = resolve)));

            await import('../../../src/main/main');

            for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) expect(addedListenerCount(signal)).toBe(0);
            expect(mockTerminationSignals.install).not.toHaveBeenCalled();

            ready();
            await vi.waitFor(() => expect(mockTerminationSignals.install).toHaveBeenCalledTimes(1));
        });

        it('on other platforms, keeps the SIGTERM and SIGINT listeners', async () => {
            setPlatform('darwin');

            await import('../../../src/main/main');

            expect(addedListenerCount('SIGTERM')).toBe(1);
            expect(addedListenerCount('SIGINT')).toBe(1);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(mockTerminationSignals.install).not.toHaveBeenCalled();
        });

        it('reports child processes that are gone', async () => {
            setPlatform('linux');
            await import('../../../src/main/main');

            getAppHandler('child-process-gone')({}, { type: 'Utility', reason: 'killed', exitCode: 15 });

            expect(mockTerminationSignals.handleProcessGone).toHaveBeenCalledWith('killed');
        });
    });

    describe('render-process-gone', () => {
        function crashRenderer(reason: string) {
            const win = { isDestroyed: vi.fn(() => false), reload: vi.fn() };
            mockBrowserWindow.fromWebContents.mockReturnValue(win);
            getAppHandler('render-process-gone')(
                {},
                { id: 7, getTitle: () => 'Gemini Desktop' },
                { reason, exitCode: 1 }
            );
            return win;
        }

        it('reloads a window whose renderer crashed', async () => {
            await import('../../../src/main/main');

            expect(crashRenderer('crashed').reload).toHaveBeenCalledTimes(1);
        });

        it('does not reload a window whose renderer exited cleanly', async () => {
            await import('../../../src/main/main');

            expect(crashRenderer('clean-exit').reload).not.toHaveBeenCalled();
        });

        it('does not reload once the app is quitting', async () => {
            await import('../../../src/main/main');
            getAppHandler('before-quit')();

            expect(crashRenderer('crashed').reload).not.toHaveBeenCalled();
        });

        it('reports the renderer to the signal handling on Linux', async () => {
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
            try {
                await import('../../../src/main/main');
                crashRenderer('killed');
            } finally {
                Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
            }

            expect(mockTerminationSignals.handleProcessGone).toHaveBeenCalledWith('killed');
        });
    });
});

function getAppHandler(event: string): (...args: unknown[]) => void {
    const call = vi.mocked(mockApp.on).mock.calls.find(([name]) => name === event);
    if (!call) throw new Error(`main.ts registered no ${event} handler`);
    return call[1] as (...args: unknown[]) => void;
}
