/**
 * Unit tests for QuickChatWindow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserWindow } from 'electron';
import QuickChatWindow from '../../../src/main/windows/quickChatWindow';

vi.mock('../../../src/main/utils/paths', async (importOriginal) => {
    type PathsModule = typeof import('../../../src/main/utils/paths');
    const actual = await importOriginal<PathsModule>();
    return {
        ...actual,
        getIconPath: vi.fn().mockReturnValue('/mock/icon/path.png'),
    };
});

describe('QuickChatWindow', () => {
    let quickChatWindow: QuickChatWindow;

    beforeEach(() => {
        vi.clearAllMocks();
        (BrowserWindow as any)._reset();
        quickChatWindow = new QuickChatWindow(false);
    });

    describe('create', () => {
        it('creates Quick Chat window with correct configuration', () => {
            const win = quickChatWindow.create();
            expect((BrowserWindow as any)._instances.length).toBe(1);
            expect(win).toBeDefined();
            expect(win.options).toMatchObject({
                frame: false,
                transparent: true,
                alwaysOnTop: true,
                skipTaskbar: true,
            });
        });

        it('creates Quick Chat window with preload script for electronAPI', () => {
            // CRITICAL: This test would have caught the preload script bug
            // where electronAPI was undefined in the Quick Chat window.
            // Without the preload script, window.electronAPI?.submitQuickChat()
            // silently fails due to optional chaining.
            const win = quickChatWindow.create();
            expect(win.options.webPreferences).toBeDefined();
            expect(win.options.webPreferences.preload).toBeDefined();
            expect(win.options.webPreferences.preload).toContain('preload');
        });

        it('returns existing Quick Chat window if already created', () => {
            const win1 = quickChatWindow.create();
            const win2 = quickChatWindow.create();
            expect((BrowserWindow as any)._instances.length).toBe(1);
            expect(win1).toBe(win2);
        });

        it('loads quickchat.html in dev mode', () => {
            const devWindow = new QuickChatWindow(true);
            const win = devWindow.create();
            expect(win.loadURL).toHaveBeenCalledWith(
                'http://localhost:1420/src/renderer/windows/quickchat/quickchat.html'
            );
        });

        it('loads quickchat.html in prod mode', () => {
            const win = quickChatWindow.create();
            expect(win.loadFile).toHaveBeenCalledWith(expect.stringContaining('quickchat.html'));
        });

        it('shows and focuses window on ready-to-show', () => {
            const win = quickChatWindow.create();
            const readyHandler = win.once.mock.calls.find(
                (call: [string, () => void]) => call[0] === 'ready-to-show'
            )?.[1];
            readyHandler?.();
            expect(win.show).toHaveBeenCalled();
            expect(win.focus).toHaveBeenCalled();
        });

        it('hides window on blur event', () => {
            const win = quickChatWindow.create();
            win.isDestroyed = vi.fn().mockReturnValue(false);

            const blurHandler = win.on.mock.calls.find((call: [string, () => void]) => call[0] === 'blur')?.[1];
            blurHandler?.();
            expect(win.hide).toHaveBeenCalled();
        });

        it('clears reference when window is closed', () => {
            quickChatWindow.create();
            const instances = (BrowserWindow as any).getAllWindows();
            const win = instances[0];

            const closeHandler = win.on.mock.calls.find((call: [string, () => void]) => call[0] === 'closed')?.[1];
            closeHandler?.();

            expect(quickChatWindow.getWindow()).toBeNull();
        });
    });

    describe('showAndFocus', () => {
        it('creates Quick Chat window if it does not exist', () => {
            quickChatWindow.showAndFocus();
            expect((BrowserWindow as any)._instances.length).toBe(1);
        });

        it('repositions and shows existing window', () => {
            const win = quickChatWindow.create();
            win.setPosition = vi.fn();

            quickChatWindow.showAndFocus();

            expect(win.setPosition).toHaveBeenCalled();
            expect(win.show).toHaveBeenCalled();
            expect(win.focus).toHaveBeenCalled();
        });
    });

    describe('hide', () => {
        it('hides Quick Chat window when it exists and is not destroyed', () => {
            const win = quickChatWindow.create();
            win.isDestroyed = vi.fn().mockReturnValue(false);

            quickChatWindow.hide();
            expect(win.hide).toHaveBeenCalled();
        });

        it('does nothing when Quick Chat window does not exist', () => {
            expect(() => quickChatWindow.hide()).not.toThrow();
        });

        it('does nothing when Quick Chat window is destroyed', () => {
            const win = quickChatWindow.create();
            win.isDestroyed = vi.fn().mockReturnValue(true);

            quickChatWindow.hide();
            expect(win.hide).not.toHaveBeenCalled();
        });
    });

    describe('toggle', () => {
        it('shows Quick Chat when window does not exist', () => {
            quickChatWindow.toggle();
            expect((BrowserWindow as any)._instances.length).toBe(1);
        });

        it('hides Quick Chat when window is visible', () => {
            const win = quickChatWindow.create();
            win.isVisible = vi.fn().mockReturnValue(true);
            win.isDestroyed = vi.fn().mockReturnValue(false);

            quickChatWindow.toggle();
            expect(win.hide).toHaveBeenCalled();
        });

        it('shows Quick Chat when window exists but is hidden', () => {
            const win = quickChatWindow.create();
            win.isVisible = vi.fn().mockReturnValue(false);
            win.setPosition = vi.fn();

            quickChatWindow.toggle();
            expect(win.show).toHaveBeenCalled();
        });
    });

    describe('resizeToContent', () => {
        const createSizedWindow = (bounds = { x: 100, y: 200, width: 600, height: 80 }, zoomFactor = 1) => {
            const win = quickChatWindow.create() as any;
            let resizable = false;
            win.getBounds = vi.fn(() => ({ ...bounds }));
            win.setBounds = vi.fn();
            win.isResizable = vi.fn(() => resizable);
            win.setResizable = vi.fn((flag: boolean) => {
                resizable = flag;
            });
            win.webContents.getZoomFactor = vi.fn(() => zoomFactor);
            return win;
        };

        it('keeps the width and top edge and toggles resizable around the change', () => {
            const win = createSizedWindow();
            quickChatWindow.resizeToContent(300);
            expect(win.setBounds).toHaveBeenCalledWith({ x: 100, y: 200, width: 600, height: 300 });
            expect(win.setResizable.mock.calls).toEqual([[true], [false]]);
        });

        it('clamps to 64..640 CSS pixels, scales by the zoom factor and stays on screen', () => {
            const win = createSizedWindow(undefined, 1.5);
            quickChatWindow.resizeToContent(10);
            expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 96 }));
            quickChatWindow.resizeToContent(5000);
            expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 880 }));
        });

        it('keeps the bottom edge inside the work area', () => {
            const win = createSizedWindow({ x: 0, y: 900, width: 600, height: 80 });
            quickChatWindow.resizeToContent(600);
            expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 180 }));
        });

        it('does nothing for invalid heights, the same height or no window', () => {
            quickChatWindow.resizeToContent(300);
            const win = createSizedWindow();
            for (const value of [NaN, Infinity, '300', null]) {
                quickChatWindow.resizeToContent(value);
            }
            quickChatWindow.resizeToContent(80);
            expect(win.setBounds).not.toHaveBeenCalled();
            expect(win.setResizable).not.toHaveBeenCalled();
        });

        it('only changes the size on Wayland', async () => {
            const previous = process.env.XDG_SESSION_TYPE;
            process.env.XDG_SESSION_TYPE = 'wayland';
            vi.resetModules();
            try {
                const { default: WaylandQuickChatWindow } = await import('../../../src/main/windows/quickChatWindow');
                quickChatWindow = new WaylandQuickChatWindow(false);
                const win = createSizedWindow();
                quickChatWindow.resizeToContent(400);
                expect(win.setSize).toHaveBeenCalledWith(600, 400);
                expect(win.setBounds).not.toHaveBeenCalled();
            } finally {
                if (previous === undefined) {
                    delete process.env.XDG_SESSION_TYPE;
                } else {
                    process.env.XDG_SESSION_TYPE = previous;
                }
                vi.resetModules();
            }
        });
    });

    describe('getWindow', () => {
        it('returns null when no Quick Chat window exists', () => {
            expect(quickChatWindow.getWindow()).toBeNull();
        });

        it('returns the Quick Chat window when it exists', () => {
            quickChatWindow.create();
            expect(quickChatWindow.getWindow()).not.toBeNull();
        });
    });
});
