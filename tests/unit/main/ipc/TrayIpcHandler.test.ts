import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../../../src/shared/constants/ipc-channels';
import { TrayIpcHandler, readTrayClickAction } from '../../../../src/main/managers/ipc/TrayIpcHandler';
import type { IpcHandlerDependencies } from '../../../../src/main/managers/ipc/types';
import { createMockLogger, createMockStore, createMockWindowManager } from '../../../helpers/mocks';

const { mockIpcMain } = vi.hoisted(() => {
    const mockIpcMain = {
        on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
            mockIpcMain._listeners.set(channel, listener);
        }),
        handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
            mockIpcMain._handlers.set(channel, handler);
        }),
        removeHandler: vi.fn(),
        removeAllListeners: vi.fn(),
        _listeners: new Map<string, (...args: unknown[]) => void>(),
        _handlers: new Map<string, (...args: unknown[]) => unknown>(),
        _reset: () => {
            mockIpcMain._listeners.clear();
            mockIpcMain._handlers.clear();
        },
    };
    return { mockIpcMain };
});

vi.mock('electron', () => ({
    ipcMain: mockIpcMain,
}));

describe('TrayIpcHandler', () => {
    let handler: TrayIpcHandler;
    let mockStore: ReturnType<typeof createMockStore>;
    let mockLogger: ReturnType<typeof createMockLogger>;

    const getAction = () => mockIpcMain._handlers.get(IPC_CHANNELS.TRAY_CLICK_ACTION_GET)?.();
    const setAction = (value: unknown) => mockIpcMain._listeners.get(IPC_CHANNELS.TRAY_CLICK_ACTION_SET)?.({}, value);

    beforeEach(() => {
        vi.clearAllMocks();
        mockIpcMain._reset();

        mockStore = createMockStore({});
        mockLogger = createMockLogger();

        const deps: IpcHandlerDependencies = {
            store: mockStore as unknown as IpcHandlerDependencies['store'],
            logger: mockLogger as unknown as IpcHandlerDependencies['logger'],
            windowManager: createMockWindowManager() as unknown as IpcHandlerDependencies['windowManager'],
        };

        handler = new TrayIpcHandler(deps);
        handler.register();
    });

    it('registers the get and set channels', () => {
        expect(mockIpcMain.handle).toHaveBeenCalledWith(IPC_CHANNELS.TRAY_CLICK_ACTION_GET, expect.any(Function));
        expect(mockIpcMain.on).toHaveBeenCalledWith(IPC_CHANNELS.TRAY_CLICK_ACTION_SET, expect.any(Function));
    });

    it('returns quickChat when nothing is saved', () => {
        expect(getAction()).toBe('quickChat');
    });

    it('returns the saved action', () => {
        mockStore._defaults.trayClickAction = 'mainWindow';
        expect(getAction()).toBe('mainWindow');
    });

    it('returns quickChat for an invalid saved value', () => {
        mockStore._defaults.trayClickAction = 'somethingElse';
        expect(getAction()).toBe('quickChat');
    });

    it('returns quickChat when the store throws', () => {
        mockStore.get.mockImplementation(() => {
            throw new Error('read failed');
        });
        expect(getAction()).toBe('quickChat');
        expect(mockLogger.error).toHaveBeenCalled();
    });

    it('saves a valid action', () => {
        setAction('mainWindow');
        expect(mockStore.set).toHaveBeenCalledWith('trayClickAction', 'mainWindow');
        expect(getAction()).toBe('mainWindow');

        setAction('quickChat');
        expect(mockStore.set).toHaveBeenLastCalledWith('trayClickAction', 'quickChat');
    });

    it.each([['show'], [''], [null], [undefined], [1], [{ action: 'mainWindow' }]])('ignores %j', (value) => {
        setAction(value);
        expect(mockStore.set).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('logs instead of throwing when saving fails', () => {
        mockStore.set.mockImplementation(() => {
            throw new Error('write failed');
        });
        expect(() => setAction('mainWindow')).not.toThrow();
        expect(mockLogger.error).toHaveBeenCalled();
    });

    it('unregisters both channels', () => {
        handler.unregister();
        expect(mockIpcMain.removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.TRAY_CLICK_ACTION_GET);
        expect(mockIpcMain.removeAllListeners).toHaveBeenCalledWith(IPC_CHANNELS.TRAY_CLICK_ACTION_SET);
    });

    describe('readTrayClickAction', () => {
        it('reads a valid value and defaults otherwise', () => {
            expect(readTrayClickAction({ get: () => 'mainWindow' } as never)).toBe('mainWindow');
            expect(readTrayClickAction({ get: () => undefined } as never)).toBe('quickChat');
            expect(readTrayClickAction({ get: () => 'bogus' } as never)).toBe('quickChat');
        });
    });
});
