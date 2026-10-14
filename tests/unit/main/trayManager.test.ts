/**
 * Unit tests for TrayManager.
 * @module trayManager.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Menu, app, nativeImage } from 'electron';
import * as fs from 'fs';
import TrayManager from '../../../src/main/managers/trayManager';
import type WindowManager from '../../../src/main/managers/windowManager';
import {
    createMockWindowManager,
    resetPlatformAdapterForTests,
    useMockPlatformAdapter,
    platformAdapterPresets,
    createMockPlatformAdapter,
} from '../../helpers/mocks';

// Mock fs module to control file existence
vi.mock('fs', () => ({
    existsSync: vi.fn((path: string) => {
        // Return false for nonexistent paths, true for others
        return !path.includes('nonexistent');
    }),
}));

const trayInstances: (typeof mockTrayInstance)[] = [];
const mockTrayInstance = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
    simulateClick: vi.fn(),
    getTooltip: vi.fn().mockReturnValue('Gemini Desktop'),
};

type MockNativeImage = {
    isEmpty: ReturnType<typeof vi.fn>;
    setTemplateImage: ReturnType<typeof vi.fn>;
    getSize: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    isTemplateImage: ReturnType<typeof vi.fn>;
};

const createMockNativeImage = (): MockNativeImage => ({
    isEmpty: vi.fn().mockReturnValue(false),
    setTemplateImage: vi.fn(),
    getSize: vi.fn().mockReturnValue({ width: 16, height: 16 }),
    resize: vi.fn(),
    isTemplateImage: vi.fn().mockReturnValue(false),
});

const mockNativeImage = createMockNativeImage();
const resizedNativeImage = createMockNativeImage();
const mockTrayConstructor = vi.fn((_trayIcon?: Electron.NativeImage) => {
    trayInstances.push(mockTrayInstance);
    return mockTrayInstance;
});

vi.mock('electron', async () => ({
    Tray: function Tray(trayIcon?: Electron.NativeImage) {
        return mockTrayConstructor(trayIcon);
    },
    Menu: {
        buildFromTemplate: vi.fn(() => ({ items: [] })),
    },
    app: {
        quit: vi.fn(),
    },
    nativeImage: {
        createFromPath: vi.fn(() => mockNativeImage as unknown as Electron.NativeImage) as unknown as (
            path: string
        ) => Electron.NativeImage,
    },
}));

describe('TrayManager', () => {
    let trayManager: TrayManager;
    let mockWindowManager: WindowManager;

    beforeEach(() => {
        vi.clearAllMocks();
        trayInstances.splice(0, trayInstances.length);
        mockTrayInstance.setToolTip.mockClear();
        mockTrayInstance.setContextMenu.mockClear();
        mockTrayInstance.on.mockClear();
        mockTrayInstance.destroy.mockClear();
        mockTrayInstance.isDestroyed.mockClear();
        mockTrayInstance.isDestroyed.mockReturnValue(false);
        mockTrayInstance.simulateClick.mockClear();
        mockTrayInstance.getTooltip.mockClear();
        mockNativeImage.isEmpty.mockClear();
        mockNativeImage.isEmpty.mockReturnValue(false);
        mockNativeImage.setTemplateImage.mockClear();
        mockNativeImage.getSize.mockClear();
        mockNativeImage.getSize.mockReturnValue({ width: 16, height: 16 });
        mockNativeImage.resize.mockClear();
        mockNativeImage.resize.mockReturnValue(resizedNativeImage);
        mockNativeImage.isTemplateImage.mockClear();
        mockTrayConstructor.mockClear();
        vi.mocked(Menu.buildFromTemplate).mockClear();
        vi.mocked(app.quit).mockClear();
        vi.mocked(nativeImage.createFromPath).mockClear();

        // Mock WindowManager using shared factory
        mockWindowManager = createMockWindowManager({
            getMainWindow: vi.fn().mockReturnValue({}),
        }) as unknown as WindowManager;

        trayManager = new TrayManager(mockWindowManager);
    });

    afterEach(() => {
        resetPlatformAdapterForTests();
    });

    describe('constructor', () => {
        it('initializes with WindowManager reference', () => {
            expect(trayManager).toBeDefined();
            expect(trayManager.getTray()).toBeNull();
        });
    });

    describe('createTray', () => {
        it('creates Tray with .ico icon on Windows', async () => {
            useMockPlatformAdapter(platformAdapterPresets.windows());

            // Reimport TrayManager after platform mock
            const { default: TrayManager } = await import('../../../src/main/managers/trayManager');
            const manager = new TrayManager(mockWindowManager);
            const tray = manager.createTray();

            expect(tray).toBeDefined();
            expect(vi.mocked(nativeImage.createFromPath).mock.calls[0]?.[0]).toContain('icon.ico');
        });

        it('creates Tray with macOS-specific tray icon on macOS', async () => {
            useMockPlatformAdapter(platformAdapterPresets.mac());

            // Reimport TrayManager after platform mock
            const { default: TrayManager } = await import('../../../src/main/managers/trayManager');
            const manager = new TrayManager(mockWindowManager);
            mockNativeImage.getSize.mockReturnValue({ width: 128, height: 128 });
            const tray = manager.createTray();

            expect(tray).toBeDefined();
            const trayIcon = vi.mocked(nativeImage.createFromPath).mock.results[0]?.value as {
                resize?: (options: { width: number; height: number }) => unknown;
            };
            const resizedIcon = vi.mocked(mockNativeImage.resize).mock.results[0]?.value as {
                setTemplateImage?: (value: boolean) => void;
            };
            expect(vi.mocked(nativeImage.createFromPath).mock.calls[0]?.[0]).toContain('icon-mac-trayTemplate.png');
            expect(resizedIcon.setTemplateImage).toHaveBeenCalledWith(true);
            expect(trayIcon.resize).toHaveBeenCalledWith({ width: 16, height: 16 });
        });

        it('applies macOS normalization before Tray construction', async () => {
            useMockPlatformAdapter(platformAdapterPresets.mac());

            const callOrder: string[] = [];
            vi.mocked(nativeImage.createFromPath).mockImplementation(() => {
                callOrder.push('createFromPath');
                return mockNativeImage as unknown as Electron.NativeImage;
            });
            resizedNativeImage.setTemplateImage.mockImplementation(() => {
                callOrder.push('setTemplateImage');
            });
            mockNativeImage.resize.mockImplementation(() => {
                callOrder.push('resize');
                return resizedNativeImage as unknown as Electron.NativeImage;
            });
            mockTrayConstructor.mockImplementation(() => {
                callOrder.push('newTray');
                trayInstances.push(mockTrayInstance);
                return mockTrayInstance;
            });
            mockNativeImage.getSize.mockReturnValue({ width: 64, height: 64 });

            const { default: TrayManager } = await import('../../../src/main/managers/trayManager');
            const manager = new TrayManager(mockWindowManager);
            manager.createTray();

            expect(callOrder).toEqual(['createFromPath', 'resize', 'setTemplateImage', 'newTray']);
            expect(mockTrayConstructor).toHaveBeenCalled();
        });

        it('does not apply macOS normalization on Windows/Linux', async () => {
            useMockPlatformAdapter(platformAdapterPresets.windows());

            const { default: TrayManager } = await import('../../../src/main/managers/trayManager');
            const manager = new TrayManager(mockWindowManager);
            manager.createTray();

            expect(mockNativeImage.setTemplateImage).not.toHaveBeenCalled();
            expect(mockNativeImage.resize).not.toHaveBeenCalled();
        });

        it('creates Tray with .png icon on Linux', async () => {
            useMockPlatformAdapter(platformAdapterPresets.linuxWayland());

            // Reimport TrayManager after platform mock
            const { default: TrayManager } = await import('../../../src/main/managers/trayManager');
            const manager = new TrayManager(mockWindowManager);
            const tray = manager.createTray();

            expect(tray).toBeDefined();
            expect(vi.mocked(nativeImage.createFromPath).mock.calls[0]?.[0]).toMatch(/[\\/]icon-tray\.png$/);
        });

        it('sets tooltip correctly', () => {
            const tray = trayManager.createTray();

            expect(tray.setToolTip).toHaveBeenCalledWith('Gemini Desktop');
        });

        it('builds context menu from TRAY_MENU_ITEMS', () => {
            trayManager.createTray();

            expect(Menu.buildFromTemplate).toHaveBeenCalled();
            const template = (Menu.buildFromTemplate as any).mock.calls[0][0];

            // Should have Quick Chat, Show, Separator, Quit
            expect(template.length).toBe(4);
            expect(template[0].label).toBe('Quick Chat');
            expect(template[1].label).toBe('Show Gemini Desktop');
            expect(template[2].type).toBe('separator');
            expect(template[3].label).toBe('Quit');
        });

        it('sets context menu on tray', () => {
            const tray = trayManager.createTray();

            expect(tray.setContextMenu).toHaveBeenCalled();
        });

        it('registers click handler on tray', () => {
            const tray = trayManager.createTray();

            expect(tray.on).toHaveBeenCalledWith('click', expect.any(Function));
        });

        it('returns existing tray if already created', () => {
            const tray1 = trayManager.createTray();
            const tray2 = trayManager.createTray();

            expect(tray1).toBe(tray2);
            expect(trayInstances.length).toBe(1);
        });

        it('falls back to app icon when tray icon is missing', async () => {
            useMockPlatformAdapter(
                createMockPlatformAdapter({
                    getTrayIconFilename: vi.fn().mockReturnValue('nonexistent-tray.png'),
                    getAppIconFilename: vi.fn().mockReturnValue('icon.png'),
                })
            );

            const { default: TrayManager } = await import('../../../src/main/managers/trayManager');
            const manager = new TrayManager(mockWindowManager);
            manager.createTray();

            const lastCall = vi.mocked(nativeImage.createFromPath).mock.calls.slice(-1)[0]?.[0];
            expect(lastCall).toContain('icon.png');
        });

        it('falls back to the app icon on Linux when icon-tray.png is missing', () => {
            useMockPlatformAdapter(platformAdapterPresets.linuxWaylandGnome());
            vi.mocked(fs.existsSync).mockImplementation((p) => !String(p).endsWith('icon-tray.png'));
            try {
                trayManager.createTray();
            } finally {
                vi.mocked(fs.existsSync).mockImplementation((p) => !String(p).includes('nonexistent'));
            }

            expect(vi.mocked(nativeImage.createFromPath).mock.calls[0]?.[0]).toMatch(/[\\/]icon\.png$/);
        });

        it('throws error when icon file is not found', async () => {
            useMockPlatformAdapter(
                createMockPlatformAdapter({
                    getAppIconFilename: vi.fn().mockReturnValue('nonexistent-icon.png'),
                    getTrayIconFilename: vi.fn().mockReturnValue('nonexistent-tray.png'),
                })
            );

            expect(() => trayManager.createTray()).toThrow('Icon not found');
        });
    });

    describe('tray click handler', () => {
        const clickTray = () => {
            const clickHandler = vi.mocked(mockTrayInstance.on).mock.calls.find((call) => call[0] === 'click')?.[1];
            clickHandler?.();
        };

        it('opens Quick Chat by default', () => {
            trayManager.createTray();

            clickTray();

            expect(mockWindowManager.showQuickChat).toHaveBeenCalledTimes(1);
            expect(mockWindowManager.restoreFromTray).not.toHaveBeenCalled();
        });

        it('restores the main window when the setting says mainWindow', () => {
            const manager = new TrayManager(mockWindowManager, { getClickAction: () => 'mainWindow' });
            manager.createTray();

            clickTray();

            expect(mockWindowManager.restoreFromTray).toHaveBeenCalledTimes(1);
            expect(mockWindowManager.showQuickChat).not.toHaveBeenCalled();
        });

        it('reads the setting at click time', () => {
            let action: 'quickChat' | 'mainWindow' = 'mainWindow';
            const manager = new TrayManager(mockWindowManager, { getClickAction: () => action });
            manager.createTray();

            clickTray();
            action = 'quickChat';
            clickTray();

            expect(mockWindowManager.restoreFromTray).toHaveBeenCalledTimes(1);
            expect(mockWindowManager.showQuickChat).toHaveBeenCalledTimes(1);
        });

        it('falls back to Quick Chat when reading the setting throws', () => {
            const manager = new TrayManager(mockWindowManager, {
                getClickAction: () => {
                    throw new Error('store unavailable');
                },
            });
            manager.createTray();

            clickTray();

            expect(mockWindowManager.showQuickChat).toHaveBeenCalledTimes(1);
            expect(mockWindowManager.restoreFromTray).not.toHaveBeenCalled();
        });
    });

    describe('executeTrayAction', () => {
        it("'click' follows the setting like a real tray click", () => {
            trayManager.executeTrayAction('click');
            expect(mockWindowManager.showQuickChat).toHaveBeenCalledTimes(1);
            expect(mockWindowManager.restoreFromTray).not.toHaveBeenCalled();

            const manager = new TrayManager(mockWindowManager, { getClickAction: () => 'mainWindow' });
            manager.executeTrayAction('click');
            expect(mockWindowManager.restoreFromTray).toHaveBeenCalledTimes(1);
        });

        it("'show' always restores the main window", () => {
            trayManager.executeTrayAction('show');

            expect(mockWindowManager.restoreFromTray).toHaveBeenCalledTimes(1);
            expect(mockWindowManager.showQuickChat).not.toHaveBeenCalled();
        });

        it("'quit' quits the app", () => {
            trayManager.executeTrayAction('quit');

            expect(app.quit).toHaveBeenCalled();
        });
    });

    describe('context menu handlers', () => {
        it('Show menu item calls restoreFromTray', () => {
            trayManager.createTray();

            const template = (Menu.buildFromTemplate as any).mock.calls[0][0];
            const showItem = template.find((item: any) => item.label === 'Show Gemini Desktop');

            expect(showItem).toBeDefined();
            showItem.click();

            expect(mockWindowManager.restoreFromTray).toHaveBeenCalled();
        });

        it('Quick Chat menu item shows Quick Chat', () => {
            trayManager.createTray();

            const template = (Menu.buildFromTemplate as any).mock.calls[0][0];
            const quickChatItem = template.find((item: any) => item.label === 'Quick Chat');

            expect(quickChatItem).toBeDefined();
            quickChatItem.click();

            expect(mockWindowManager.showQuickChat).toHaveBeenCalled();
            expect(mockWindowManager.restoreFromTray).not.toHaveBeenCalled();
        });

        it('executeTrayAction("quickChat") shows Quick Chat', () => {
            trayManager.executeTrayAction('quickChat');

            expect(mockWindowManager.showQuickChat).toHaveBeenCalled();
        });

        it('Quit menu item calls app.quit', () => {
            trayManager.createTray();

            const template = (Menu.buildFromTemplate as any).mock.calls[0][0];
            const quitItem = template.find((item: any) => item.label === 'Quit');

            expect(quitItem).toBeDefined();
            quitItem.click();

            expect(app.quit).toHaveBeenCalled();
        });
    });

    describe('destroyTray', () => {
        it('destroys the tray instance', () => {
            const tray = trayManager.createTray();

            trayManager.destroyTray();

            expect(tray.destroy).toHaveBeenCalled();
            expect(trayManager.getTray()).toBeNull();
        });

        it('handles already-destroyed tray gracefully', () => {
            const tray = trayManager.createTray();
            (tray.isDestroyed as any).mockReturnValue(true);

            // Should not throw
            expect(() => trayManager.destroyTray()).not.toThrow();
        });

        it('does nothing when tray does not exist', () => {
            // Should not throw
            expect(() => trayManager.destroyTray()).not.toThrow();
        });
    });

    describe('getTray', () => {
        it('returns null when no tray exists', () => {
            expect(trayManager.getTray()).toBeNull();
        });

        it('returns the tray instance when it exists', () => {
            const tray = trayManager.createTray();
            expect(trayManager.getTray()).toBe(tray);
        });
    });

    describe('setUpdateTooltip', () => {
        it('sets tooltip with version info', () => {
            const tray = trayManager.createTray();

            trayManager.setUpdateTooltip('2.0.0');

            expect(tray.setToolTip).toHaveBeenLastCalledWith('Gemini Desktop - Update v2.0.0 available');
        });

        it('does nothing if tray does not exist', () => {
            // No tray created, should not throw
            expect(() => trayManager.setUpdateTooltip('2.0.0')).not.toThrow();
        });

        it('does nothing if tray is destroyed', () => {
            const tray = trayManager.createTray();
            (tray.isDestroyed as any).mockReturnValue(true);

            // Should not throw
            expect(() => trayManager.setUpdateTooltip('2.0.0')).not.toThrow();
        });
    });

    describe('clearUpdateTooltip', () => {
        it('resets tooltip to default', () => {
            const tray = trayManager.createTray();
            trayManager.setUpdateTooltip('2.0.0');

            trayManager.clearUpdateTooltip();

            expect(tray.setToolTip).toHaveBeenLastCalledWith('Gemini Desktop');
        });

        it('does nothing if tray does not exist', () => {
            // No tray created, should not throw
            expect(() => trayManager.clearUpdateTooltip()).not.toThrow();
        });

        it('does nothing if tray is destroyed', () => {
            const tray = trayManager.createTray();
            (tray.isDestroyed as any).mockReturnValue(true);

            // Should not throw
            expect(() => trayManager.clearUpdateTooltip()).not.toThrow();
        });
    });
});
