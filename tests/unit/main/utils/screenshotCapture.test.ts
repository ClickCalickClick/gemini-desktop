/**
 * Unit tests for screenshotCapture (H10): which way a screenshot is taken on each platform,
 * the portal's response codes, and Electron's desktopCapturer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getSources: vi.fn(),
    getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
    getDisplayNearestPoint: vi.fn(() => ({ id: 2, size: { width: 1000, height: 500 }, scaleFactor: 1.5 })),
    getMediaAccessStatus: vi.fn(() => 'granted'),
}));

vi.mock('electron', () => ({
    desktopCapturer: { getSources: mocks.getSources },
    screen: {
        getCursorScreenPoint: mocks.getCursorScreenPoint,
        getDisplayNearestPoint: mocks.getDisplayNearestPoint,
    },
    systemPreferences: { getMediaAccessStatus: mocks.getMediaAccessStatus },
}));

import {
    captureScreenshot,
    captureViaDesktopCapturer,
    captureViaScreencapture,
    portalOutcome,
    ScreenshotError,
    type CaptureDeps,
    type CaptureOutcome,
} from '../../../../src/main/utils/screenshotCapture';

const PNG = Buffer.from('png');
const captured: CaptureOutcome = { status: 'captured', png: PNG };

function createDeps(overrides: Partial<CaptureDeps> = {}) {
    return {
        platform: 'linux' as NodeJS.Platform,
        wayland: false,
        viaPortal: vi.fn(async (_interactive: boolean) => captured),
        viaDesktopCapturer: vi.fn(async () => captured),
        viaScreencapture: vi.fn(async (_interactive: boolean) => captured),
        ...overrides,
    };
}

function fakeSource(displayId: string, png: Buffer, empty = false) {
    return {
        display_id: displayId,
        thumbnail: { isEmpty: () => empty, toPNG: () => png },
    };
}

describe('screenshotCapture', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('captureScreenshot routing', () => {
        it('uses screencapture on macOS, interactive for an area', async () => {
            const deps = createDeps({ platform: 'darwin' });
            await expect(captureScreenshot('screen', deps)).resolves.toBe(captured);
            await captureScreenshot('area', deps);
            expect(deps.viaScreencapture.mock.calls).toEqual([[false], [true]]);
            expect(deps.viaPortal).not.toHaveBeenCalled();
            expect(deps.viaDesktopCapturer).not.toHaveBeenCalled();
        });

        it('uses the portal on Linux Wayland for both modes', async () => {
            const deps = createDeps({ wayland: true });
            await captureScreenshot('screen', deps);
            await captureScreenshot('area', deps);
            expect(deps.viaPortal.mock.calls).toEqual([[false], [true]]);
            expect(deps.viaDesktopCapturer).not.toHaveBeenCalled();
        });

        it('uses desktopCapturer for the whole screen on Linux X11', async () => {
            const deps = createDeps();
            await captureScreenshot('screen', deps);
            expect(deps.viaDesktopCapturer).toHaveBeenCalledTimes(1);
            expect(deps.viaPortal).not.toHaveBeenCalled();
        });

        it('uses the interactive portal for an area on Linux X11', async () => {
            const deps = createDeps();
            await captureScreenshot('area', deps);
            expect(deps.viaPortal).toHaveBeenCalledWith(true);
            expect(deps.viaDesktopCapturer).not.toHaveBeenCalled();
        });

        it('passes a cancel from the portal on', async () => {
            const deps = createDeps({
                wayland: true,
                viaPortal: vi.fn(async () => ({ status: 'cancelled' }) as const),
            });
            await expect(captureScreenshot('area', deps)).resolves.toEqual({ status: 'cancelled' });
            expect(deps.viaDesktopCapturer).not.toHaveBeenCalled();
        });

        it('falls back to desktopCapturer when the portal fails', async () => {
            const deps = createDeps({
                wayland: true,
                viaPortal: vi.fn(async () => {
                    throw new Error('org.freedesktop.DBus.Error.UnknownMethod');
                }),
            });
            await expect(captureScreenshot('screen', deps)).resolves.toBe(captured);
            expect(deps.viaDesktopCapturer).toHaveBeenCalledTimes(1);
        });

        it('rethrows a ScreenshotError from the portal without falling back', async () => {
            const deps = createDeps({
                wayland: true,
                viaPortal: vi.fn(async () => {
                    throw new ScreenshotError('The desktop did not allow the screenshot.');
                }),
            });
            await expect(captureScreenshot('screen', deps)).rejects.toThrow(
                'The desktop did not allow the screenshot.'
            );
            expect(deps.viaDesktopCapturer).not.toHaveBeenCalled();
        });

        it('uses desktopCapturer on Windows for both modes', async () => {
            const deps = createDeps({ platform: 'win32' });
            await captureScreenshot('screen', deps);
            await captureScreenshot('area', deps);
            expect(deps.viaDesktopCapturer).toHaveBeenCalledTimes(2);
            expect(deps.viaPortal).not.toHaveBeenCalled();
            expect(deps.viaScreencapture).not.toHaveBeenCalled();
        });
    });

    describe('portalOutcome', () => {
        it('returns the file uri for code 0', () => {
            expect(portalOutcome(0, { uri: { value: 'file:///tmp/Screenshot.png' } })).toEqual({
                status: 'captured',
                uri: 'file:///tmp/Screenshot.png',
            });
        });

        it('returns cancelled for code 1', () => {
            expect(portalOutcome(1, {})).toEqual({ status: 'cancelled' });
        });

        it('throws a ScreenshotError for code 2 and other codes', () => {
            expect(() => portalOutcome(2, {})).toThrow(ScreenshotError);
            expect(() => portalOutcome(2, {})).toThrow('The desktop did not allow the screenshot.');
            expect(() => portalOutcome(7, {})).toThrow(ScreenshotError);
        });

        it('throws a ScreenshotError for a missing or non-file uri', () => {
            expect(() => portalOutcome(0, {})).toThrow('The desktop did not return a screenshot.');
            expect(() => portalOutcome(0, { uri: { value: 'https://example.com/a.png' } })).toThrow(ScreenshotError);
            expect(() => portalOutcome(0, { uri: { value: 42 } })).toThrow(ScreenshotError);
        });
    });

    describe('captureViaDesktopCapturer', () => {
        it('asks for the display under the cursor at full resolution and picks its source', async () => {
            const own = Buffer.from('own');
            mocks.getSources.mockResolvedValue([fakeSource('1', Buffer.from('other')), fakeSource('2', own)]);
            await expect(captureViaDesktopCapturer()).resolves.toEqual({ status: 'captured', png: own });
            expect(mocks.getSources).toHaveBeenCalledWith({
                types: ['screen'],
                thumbnailSize: { width: 1500, height: 750 },
            });
        });

        it('falls back to the first source', async () => {
            const first = Buffer.from('first');
            mocks.getSources.mockResolvedValue([fakeSource('9', first)]);
            await expect(captureViaDesktopCapturer()).resolves.toEqual({ status: 'captured', png: first });
        });

        it('returns cancelled when there is no source (Wayland picker closed)', async () => {
            mocks.getSources.mockResolvedValue([]);
            await expect(captureViaDesktopCapturer()).resolves.toEqual({ status: 'cancelled' });
        });

        it('throws a ScreenshotError for an empty image', async () => {
            mocks.getSources.mockResolvedValue([fakeSource('2', PNG, true)]);
            await expect(captureViaDesktopCapturer()).rejects.toThrow('The screenshot came back empty.');
        });
    });

    describe('captureViaScreencapture', () => {
        it('refuses when the Screen Recording permission is denied', async () => {
            mocks.getMediaAccessStatus.mockReturnValueOnce('denied');
            await expect(captureViaScreencapture(false)).rejects.toThrow(ScreenshotError);
            mocks.getMediaAccessStatus.mockReturnValueOnce('restricted');
            await expect(captureViaScreencapture(true)).rejects.toThrow('Screen & System Audio Recording');
        });

        it('asks macOS for the permission on first use instead of capturing only the wallpaper', async () => {
            mocks.getSources.mockResolvedValue([]);
            mocks.getMediaAccessStatus.mockReturnValueOnce('not-determined');
            await expect(captureViaScreencapture(false)).rejects.toThrow('Screen & System Audio Recording');
            expect(mocks.getSources).toHaveBeenCalledWith({
                types: ['screen'],
                thumbnailSize: { width: 1, height: 1 },
            });
        });
    });
});
