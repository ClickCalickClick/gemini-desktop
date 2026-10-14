/**
 * Unit tests for ScreenshotManager (H10): Quick Chat hides while the screenshot is taken,
 * one screenshot is kept, and it is handed over once by id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeImage } from 'electron';

import ScreenshotManager, {
    SCREENSHOT_MAX_AGE_MS,
    type ScreenshotManagerOptions,
} from '../../../../src/main/managers/screenshotManager';
import { ScreenshotError, type CaptureOutcome } from '../../../../src/main/utils/screenshotCapture';
import { SCREENSHOT_ID_PATTERN, type ScreenshotMode } from '../../../../src/shared/types/screenshot';
import { createMockLogger } from '../../../helpers/mocks';

const PNG = Buffer.from('fake-png-bytes');

describe('ScreenshotManager', () => {
    let visible: boolean;
    let quickChat: { isDestroyed: ReturnType<typeof vi.fn>; isVisible: ReturnType<typeof vi.fn> } | null;
    let windowManager: {
        hideQuickChat: ReturnType<typeof vi.fn>;
        showQuickChat: ReturnType<typeof vi.fn>;
        getQuickChatWindow: ReturnType<typeof vi.fn>;
    };
    let capture: ReturnType<typeof vi.fn<(mode: ScreenshotMode) => Promise<CaptureOutcome>>>;
    let describeImage: ReturnType<typeof vi.fn>;
    let now: number;

    beforeEach(() => {
        vi.clearAllMocks();
        visible = true;
        quickChat = {
            isDestroyed: vi.fn(() => false),
            isVisible: vi.fn(() => visible),
        };
        windowManager = {
            hideQuickChat: vi.fn(() => {
                visible = false;
            }),
            showQuickChat: vi.fn(() => {
                visible = true;
            }),
            getQuickChatWindow: vi.fn(() => quickChat),
        };
        capture = vi.fn(async () => ({ status: 'captured', png: PNG }) as CaptureOutcome);
        describeImage = vi.fn(() => ({ width: 1920, height: 1080, thumbnailDataUrl: 'data:image/png;base64,thumb' }));
        now = 1_000_000;
    });

    const createManager = (overrides: Partial<ScreenshotManagerOptions> = {}) =>
        new ScreenshotManager({
            windowManager: windowManager as unknown as ScreenshotManagerOptions['windowManager'],
            capture,
            describeImage,
            hideDelayMs: 0,
            now: () => now,
            logger: createMockLogger(),
            ...overrides,
        });

    describe('capture', () => {
        it('rejects an invalid mode without hiding Quick Chat', async () => {
            const manager = createManager();
            await expect(manager.capture('window')).resolves.toEqual({
                status: 'error',
                error: 'Invalid screenshot mode.',
            });
            await expect(manager.capture(undefined)).resolves.toMatchObject({ status: 'error' });
            expect(capture).not.toHaveBeenCalled();
            expect(windowManager.hideQuickChat).not.toHaveBeenCalled();
        });

        it('hides a visible Quick Chat while capturing and shows it again', async () => {
            capture.mockImplementation(async () => {
                expect(windowManager.hideQuickChat).toHaveBeenCalledTimes(1);
                expect(windowManager.showQuickChat).not.toHaveBeenCalled();
                return { status: 'captured', png: PNG };
            });
            const manager = createManager();
            const result = await manager.capture('area');
            expect(result.status).toBe('captured');
            expect(capture).toHaveBeenCalledWith('area');
            expect(windowManager.showQuickChat).toHaveBeenCalledTimes(1);
        });

        it('leaves a hidden Quick Chat hidden', async () => {
            visible = false;
            const manager = createManager();
            await manager.capture('screen');
            expect(windowManager.hideQuickChat).not.toHaveBeenCalled();
            expect(windowManager.showQuickChat).not.toHaveBeenCalled();
        });

        it('does not hide or show when there is no Quick Chat window or it is destroyed', async () => {
            quickChat = null;
            await createManager().capture('screen');
            quickChat = { isDestroyed: vi.fn(() => true), isVisible: vi.fn(() => true) };
            await createManager().capture('screen');
            expect(windowManager.hideQuickChat).not.toHaveBeenCalled();
            expect(windowManager.showQuickChat).not.toHaveBeenCalled();
        });

        it('returns a preview with an id, the size and the thumbnail', async () => {
            const manager = createManager();
            const result = await manager.capture('screen');
            expect(describeImage).toHaveBeenCalledWith(PNG);
            expect(result.status).toBe('captured');
            if (result.status !== 'captured') return;
            expect(result.preview).toEqual({
                id: expect.stringMatching(SCREENSHOT_ID_PATTERN),
                width: 1920,
                height: 1080,
                thumbnailDataUrl: 'data:image/png;base64,thumb',
            });
        });

        it('returns cancelled and shows Quick Chat again when the user cancels', async () => {
            capture.mockResolvedValue({ status: 'cancelled' });
            const manager = createManager();
            await expect(manager.capture('area')).resolves.toEqual({ status: 'cancelled' });
            expect(describeImage).not.toHaveBeenCalled();
            expect(windowManager.showQuickChat).toHaveBeenCalledTimes(1);
        });

        it('passes the message of a ScreenshotError on and shows Quick Chat again', async () => {
            capture.mockRejectedValue(new ScreenshotError('The desktop did not allow the screenshot.'));
            const manager = createManager();
            await expect(manager.capture('screen')).resolves.toEqual({
                status: 'error',
                error: 'The desktop did not allow the screenshot.',
            });
            expect(windowManager.showQuickChat).toHaveBeenCalledTimes(1);
        });

        it('hides the message of other errors', async () => {
            capture.mockRejectedValue(new Error('ENOENT /home/user/Pictures/secret.png'));
            const manager = createManager();
            await expect(manager.capture('screen')).resolves.toEqual({
                status: 'error',
                error: 'The screenshot could not be taken.',
            });
            expect(windowManager.showQuickChat).toHaveBeenCalledTimes(1);
        });

        it('refuses a second capture while one is running, and allows one afterwards', async () => {
            let finish: (outcome: CaptureOutcome) => void = () => {};
            capture.mockImplementationOnce(
                () =>
                    new Promise<CaptureOutcome>((resolve) => {
                        finish = resolve;
                    })
            );
            const manager = createManager();
            const first = manager.capture('screen');
            await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
            await expect(manager.capture('screen')).resolves.toEqual({
                status: 'error',
                error: 'A screenshot is already being taken.',
            });
            finish({ status: 'captured', png: PNG });
            await expect(first).resolves.toMatchObject({ status: 'captured' });
            await expect(manager.capture('screen')).resolves.toMatchObject({ status: 'captured' });
        });

        it('reads the image with nativeImage by default', async () => {
            const resize = vi.fn(() => ({ toDataURL: () => 'data:image/png;base64,small' }));
            vi.mocked(nativeImage.createFromBuffer).mockReturnValueOnce({
                isEmpty: () => false,
                getSize: () => ({ width: 800, height: 600 }),
                resize,
            } as unknown as Electron.NativeImage);
            const manager = createManager({ describeImage: undefined });
            const result = await manager.capture('screen');
            expect(resize).toHaveBeenCalledWith({ height: 96 });
            expect(result).toMatchObject({
                status: 'captured',
                preview: { width: 800, height: 600, thumbnailDataUrl: 'data:image/png;base64,small' },
            });
        });

        it('reports an image nativeImage cannot read', async () => {
            vi.mocked(nativeImage.createFromBuffer).mockReturnValueOnce({
                isEmpty: () => true,
            } as unknown as Electron.NativeImage);
            const manager = createManager({ describeImage: undefined });
            await expect(manager.capture('screen')).resolves.toEqual({
                status: 'error',
                error: 'The screenshot could not be read.',
            });
        });
    });

    describe('take', () => {
        const captureId = async (manager: ScreenshotManager): Promise<string> => {
            const result = await manager.capture('screen');
            if (result.status !== 'captured') throw new Error('not captured');
            return result.preview.id;
        };

        it('hands the screenshot over once', async () => {
            const manager = createManager();
            const id = await captureId(manager);
            expect(manager.take(id)).toBe(PNG);
            expect(manager.take(id)).toBeNull();
        });

        it('returns null for a wrong or malformed id and keeps the screenshot', async () => {
            const manager = createManager();
            const id = await captureId(manager);
            expect(manager.take('00000000-0000-0000-0000-000000000000')).toBeNull();
            expect(manager.take('not-an-id')).toBeNull();
            expect(manager.take(42)).toBeNull();
            expect(manager.take(id)).toBe(PNG);
        });

        it('returns null before any capture', () => {
            expect(createManager().take('00000000-0000-0000-0000-000000000000')).toBeNull();
        });

        it('keeps only the latest screenshot', async () => {
            const manager = createManager();
            const first = await captureId(manager);
            const second = await captureId(manager);
            expect(manager.take(first)).toBeNull();
            expect(manager.take(second)).toBe(PNG);
        });

        it('drops a screenshot that is too old', async () => {
            const manager = createManager();
            const id = await captureId(manager);
            now += SCREENSHOT_MAX_AGE_MS + 1;
            expect(manager.take(id)).toBeNull();
            now -= SCREENSHOT_MAX_AGE_MS + 1;
            expect(manager.take(id)).toBeNull();
        });

        it('still hands over a screenshot right at the age limit', async () => {
            const manager = createManager();
            const id = await captureId(manager);
            now += SCREENSHOT_MAX_AGE_MS;
            expect(manager.take(id)).toBe(PNG);
        });
    });

    describe('discard', () => {
        it('forgets the screenshot with that id only', async () => {
            const manager = createManager();
            const result = await manager.capture('screen');
            if (result.status !== 'captured') throw new Error('not captured');
            manager.discard('00000000-0000-0000-0000-000000000000');
            manager.discard(undefined);
            expect(manager.take(result.preview.id)).toBe(PNG);

            const again = await manager.capture('screen');
            if (again.status !== 'captured') throw new Error('not captured');
            manager.discard(again.preview.id);
            expect(manager.take(again.preview.id)).toBeNull();
        });
    });
});
