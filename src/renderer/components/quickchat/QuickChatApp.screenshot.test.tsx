/**
 * Unit tests for Quick Chat's screenshot option (H10): the camera button and shortcut, the
 * thumbnail chip, sending the screenshot with a prompt, and dropping it again.
 *
 * @module QuickChatApp.screenshot.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import QuickChatApp, { CAPTURE_SETTLE_MS } from './QuickChatApp';
import { createMockElectronAPI } from '../../../../tests/helpers/mocks/renderer/electronAPI';
import type { AgentEngineStatus } from '../../../shared/types/agent';
import type { ElectronAPI } from '../../../shared/types/ipc';
import type { ScreenshotCaptureResult, ScreenshotPreview } from '../../../shared/types/screenshot';

const AVAILABLE: AgentEngineStatus = {
    engine: 'antigravity',
    available: true,
    path: '/usr/bin/agy',
    version: '1.0.0',
};

const PREVIEW: ScreenshotPreview = {
    id: '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
    width: 1920,
    height: 1080,
    thumbnailDataUrl: 'data:image/png;base64,thumb',
};

describe('QuickChatApp screenshot', () => {
    let api: ElectronAPI;
    let captureMock: ReturnType<typeof vi.fn>;
    let discardMock: ReturnType<typeof vi.fn>;

    const setup = (captureResult: ScreenshotCaptureResult = { status: 'captured', preview: PREVIEW }) => {
        captureMock = vi.fn().mockResolvedValue(captureResult);
        discardMock = vi.fn();
        api = createMockElectronAPI({
            getAgentStatus: vi.fn().mockResolvedValue(AVAILABLE),
            captureQuickChatScreenshot: captureMock,
            discardQuickChatScreenshot: discardMock,
        } as Partial<ElectronAPI>);
        window.electronAPI = api;
    };

    const renderApp = async () => {
        render(<QuickChatApp />);
        await waitFor(() => expect(api.getAgentStatus).toHaveBeenCalled());
        await act(async () => {
            await Promise.resolve();
        });
    };

    const input = () => screen.getByTestId('quick-chat-input');
    const camera = () => screen.getByTestId('quick-chat-screenshot-button');

    const type = async (value: string) => {
        await act(async () => {
            fireEvent.change(input(), { target: { value } });
        });
    };

    const press = async (key: string, init: Partial<KeyboardEventInit> = {}) => {
        await act(async () => {
            fireEvent.keyDown(input(), { key, ...init });
        });
    };

    const clickCamera = async (init: Partial<MouseEventInit> = {}) => {
        await act(async () => {
            fireEvent.click(camera(), init);
        });
        await waitFor(() => expect(camera()).not.toBeDisabled());
    };

    beforeEach(() => {
        vi.clearAllMocks();
        setup();
    });

    afterEach(() => {
        vi.useRealTimers();
        window.electronAPI = undefined;
    });

    describe('taking a screenshot', () => {
        it('takes the whole screen on click', async () => {
            await renderApp();
            await clickCamera();
            expect(captureMock).toHaveBeenCalledWith('screen');
        });

        it('lets the user pick an area on Shift+click', async () => {
            await renderApp();
            await clickCamera({ shiftKey: true });
            expect(captureMock).toHaveBeenCalledWith('area');
        });

        it('takes the whole screen on Ctrl+Shift+S', async () => {
            await renderApp();
            await press('S', { ctrlKey: true, shiftKey: true });
            await waitFor(() => expect(captureMock).toHaveBeenCalledWith('screen'));
        });

        it('disables the camera while the screenshot is taken', async () => {
            let finish: (result: ScreenshotCaptureResult) => void = () => {};
            captureMock.mockImplementationOnce(
                () =>
                    new Promise<ScreenshotCaptureResult>((resolve) => {
                        finish = resolve;
                    })
            );
            await renderApp();
            await act(async () => {
                fireEvent.click(camera());
            });
            expect(camera()).toBeDisabled();
            await act(async () => {
                finish({ status: 'cancelled' });
            });
            expect(camera()).not.toBeDisabled();
        });

        it('shows the thumbnail chip for a captured screenshot', async () => {
            await renderApp();
            expect(screen.queryByTestId('quick-chat-screenshot-chip')).not.toBeInTheDocument();
            await clickCamera();
            const chip = screen.getByTestId('quick-chat-screenshot-chip');
            expect(chip).toHaveAttribute('title', expect.stringContaining('1920×1080'));
            expect(screen.getByAltText('Attached screenshot')).toHaveAttribute('src', PREVIEW.thumbnailDataUrl);
            expect(input()).toHaveAttribute('placeholder', 'Ask about the screenshot…');
            expect(camera()).toHaveAttribute('aria-label', 'Take a new screenshot');
        });

        it('shows nothing for a cancelled screenshot', async () => {
            setup({ status: 'cancelled' });
            await renderApp();
            await clickCamera();
            expect(screen.queryByTestId('quick-chat-screenshot-chip')).not.toBeInTheDocument();
            expect(screen.queryByTestId('quick-chat-screenshot-error')).not.toBeInTheDocument();
        });

        it('shows the error of a failed screenshot', async () => {
            setup({ status: 'error', error: 'The desktop did not allow the screenshot.' });
            await renderApp();
            await clickCamera();
            expect(screen.getByTestId('quick-chat-screenshot-error')).toHaveTextContent(
                'The desktop did not allow the screenshot.'
            );
            expect(screen.queryByTestId('quick-chat-screenshot-chip')).not.toBeInTheDocument();
        });

        it('shows a generic error when the call fails', async () => {
            captureMock.mockRejectedValueOnce(new Error('ipc broke'));
            await renderApp();
            await clickCamera();
            expect(screen.getByTestId('quick-chat-screenshot-error')).toHaveTextContent(
                'The screenshot could not be taken.'
            );
        });
    });

    describe('sending', () => {
        it('sends the screenshot id with a prompt for Gemini, once', async () => {
            await renderApp();
            await clickCamera();
            await type('what is this error?');
            await press('Enter');
            expect(api.submitQuickChat).toHaveBeenCalledWith('what is this error?', { screenshotId: PREVIEW.id });
            expect(screen.queryByTestId('quick-chat-screenshot-chip')).not.toBeInTheDocument();
            expect(discardMock).not.toHaveBeenCalled();

            await type('and another question');
            await press('Enter');
            expect(api.submitQuickChat).toHaveBeenLastCalledWith('and another question');
        });

        it('sends a prompt for Gemini without options when nothing is attached', async () => {
            await renderApp();
            await type('tell me a joke');
            await press('Enter');
            expect(api.submitQuickChat).toHaveBeenCalledWith('tell me a joke');
        });

        it('passes the screenshot id to an agent run', async () => {
            await renderApp();
            await clickCamera();
            await type('organise my Downloads folder');
            await press('Enter');
            await waitFor(() =>
                expect(api.runAgent).toHaveBeenCalledWith({
                    prompt: 'organise my Downloads folder',
                    category: 'files',
                    conversationId: undefined,
                    screenshotId: PREVIEW.id,
                })
            );
            expect(api.submitQuickChat).not.toHaveBeenCalled();
            expect(screen.queryByTestId('quick-chat-screenshot-chip')).not.toBeInTheDocument();
        });

        it('starts an agent run without a screenshot id when nothing is attached', async () => {
            await renderApp();
            await type('organise my Downloads folder');
            await press('Enter');
            await waitFor(() => expect(api.runAgent).toHaveBeenCalled());
            expect(vi.mocked(api.runAgent).mock.calls[0]?.[0]).not.toHaveProperty('screenshotId');
        });
    });

    describe('dropping the screenshot', () => {
        it('discards it with the remove button', async () => {
            await renderApp();
            await clickCamera();
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-screenshot-remove'));
            });
            expect(discardMock).toHaveBeenCalledWith(PREVIEW.id);
            expect(screen.queryByTestId('quick-chat-screenshot-chip')).not.toBeInTheDocument();

            await type('tell me a joke');
            await press('Enter');
            expect(api.submitQuickChat).toHaveBeenCalledWith('tell me a joke');
        });

        it('discards it on Escape and hides Quick Chat', async () => {
            await renderApp();
            await clickCamera();
            await press('Escape');
            expect(discardMock).toHaveBeenCalledWith(PREVIEW.id);
            expect(api.cancelQuickChat).toHaveBeenCalled();
            expect(screen.queryByTestId('quick-chat-screenshot-chip')).not.toBeInTheDocument();
        });

        it('keeps it when Quick Chat hides for the screenshot, and drops it when the user leaves', async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            await renderApp();
            await clickCamera();

            // Quick Chat's own hide and show right after the screenshot
            await act(async () => {
                window.dispatchEvent(new Event('blur'));
            });
            expect(discardMock).not.toHaveBeenCalled();
            expect(screen.getByTestId('quick-chat-screenshot-chip')).toBeInTheDocument();

            await act(async () => {
                vi.advanceTimersByTime(CAPTURE_SETTLE_MS + 10);
            });
            await act(async () => {
                window.dispatchEvent(new Event('blur'));
            });
            expect(discardMock).toHaveBeenCalledWith(PREVIEW.id);
            expect(screen.queryByTestId('quick-chat-screenshot-chip')).not.toBeInTheDocument();
        });
    });
});
