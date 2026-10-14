/**
 * Unit tests for IndividualHotkeyToggles component.
 *
 * Tests the individual hotkey toggle component with rendering,
 * enabling/disabling hotkeys, and accelerator customization.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IndividualHotkeyToggles } from '../../../../../src/renderer/components/options/IndividualHotkeyToggles';
import * as hotkeysContext from '../../../../../src/renderer/context/IndividualHotkeysContext';
import { COPILOT_KEY_ACCELERATOR, DEFAULT_ACCELERATORS } from '../../../../../src/shared/types/hotkeys';
import { setupMockElectronAPI } from '../../../../helpers/mocks';

const mockSetEnabled = vi.fn();
const mockSetAccelerator = vi.fn();

const mockContextValue = {
    settings: {
        alwaysOnTop: true,
        peekAndHide: true,
        quickChat: true,
        voiceChat: true,
        printToPdf: true,
    },
    accelerators: DEFAULT_ACCELERATORS,
    setEnabled: mockSetEnabled,
    setAccelerator: mockSetAccelerator,
};

describe('IndividualHotkeyToggles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(hotkeysContext, 'useIndividualHotkeys').mockReturnValue(mockContextValue);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('rendering', () => {
        it('should render all hotkey toggles', () => {
            render(<IndividualHotkeyToggles />);

            expect(screen.getByText('Always on Top')).toBeInTheDocument();
            expect(screen.getByText('Peek and Hide')).toBeInTheDocument();
            expect(screen.getByText('Quick Chat')).toBeInTheDocument();
            expect(screen.getByText('Voice Chat')).toBeInTheDocument();
            expect(screen.getByText('Print to PDF')).toBeInTheDocument();
        });

        it('should render voiceChat toggle with correct label', () => {
            render(<IndividualHotkeyToggles />);
            expect(screen.getByText('Voice Chat')).toBeInTheDocument();
        });

        it('should render voiceChat with correct description', () => {
            render(<IndividualHotkeyToggles />);
            expect(screen.getByText('Toggle Gemini microphone input from anywhere')).toBeInTheDocument();
        });

        it('should render hotkey row with testId for voiceChat', () => {
            const { container } = render(<IndividualHotkeyToggles />);
            expect(container.querySelector('[data-testid="hotkey-row-voiceChat"]')).toBeInTheDocument();
        });

        it('should render voiceChat toggle button with testId', () => {
            const { container } = render(<IndividualHotkeyToggles />);
            expect(container.querySelector('[data-testid="hotkey-toggle-voiceChat"]')).toBeInTheDocument();
        });
    });

    describe('voiceChat toggle functionality', () => {
        it('should render voiceChat toggle correctly', () => {
            render(<IndividualHotkeyToggles />);
            const voiceChatToggle = screen.getByTestId('hotkey-toggle-voiceChat');
            expect(voiceChatToggle).toBeInTheDocument();
        });
    });

    describe('existing hotkeys', () => {
        it('should not break existing hotkey functionality', () => {
            render(<IndividualHotkeyToggles />);

            expect(screen.getByText('Always on Top')).toBeInTheDocument();
            expect(screen.getByText('Peek and Hide')).toBeInTheDocument();
            expect(screen.getByText('Quick Chat')).toBeInTheDocument();
            expect(screen.getByText('Print to PDF')).toBeInTheDocument();

            expect(screen.getByText('Toggle window always-on-top')).toBeInTheDocument();
            expect(screen.getByText('Toggle hide to/restore from system tray')).toBeInTheDocument();
            expect(screen.getByText('Open floating chat overlay')).toBeInTheDocument();
            expect(screen.getByText('Save current conversation as PDF')).toBeInTheDocument();
        });
    });

    describe('accelerator defaults', () => {
        it('should have voiceChat default accelerator as CommandOrControl+Shift+M', () => {
            expect(DEFAULT_ACCELERATORS.voiceChat).toBe('CommandOrControl+Shift+M');
        });
    });

    describe('Copilot key preset', () => {
        let originalElectronAPI: typeof window.electronAPI;

        beforeEach(() => {
            originalElectronAPI = window.electronAPI;
        });

        afterEach(() => {
            window.electronAPI = originalElectronAPI;
        });

        it.each(['linux', 'win32'] as const)('on %s, sets Quick Chat to Shift+Super+F23 in one click', (platform) => {
            setupMockElectronAPI({ platform });
            render(<IndividualHotkeyToggles />);

            const button = screen.getByTestId('hotkey-copilot-preset');
            expect(button).toHaveTextContent('Use Copilot key');
            expect(screen.getByTestId('hotkey-row-quickChat')).toContainElement(button);

            fireEvent.click(button);

            expect(COPILOT_KEY_ACCELERATOR).toBe('Shift+Super+F23');
            expect(mockSetAccelerator).toHaveBeenCalledWith('quickChat', 'Shift+Super+F23');
        });

        it('is not offered on macOS, which has no Copilot key', () => {
            setupMockElectronAPI({ platform: 'darwin' });
            render(<IndividualHotkeyToggles />);

            expect(screen.queryByTestId('hotkey-copilot-preset')).not.toBeInTheDocument();
        });

        it('is disabled while the Quick Chat hotkey is off or already the Copilot key', () => {
            setupMockElectronAPI({ platform: 'linux' });
            vi.spyOn(hotkeysContext, 'useIndividualHotkeys').mockReturnValue({
                ...mockContextValue,
                settings: { ...mockContextValue.settings, quickChat: false },
            });
            const { unmount } = render(<IndividualHotkeyToggles />);
            expect(screen.getByTestId('hotkey-copilot-preset')).toBeDisabled();
            unmount();

            vi.spyOn(hotkeysContext, 'useIndividualHotkeys').mockReturnValue({
                ...mockContextValue,
                accelerators: { ...DEFAULT_ACCELERATORS, quickChat: COPILOT_KEY_ACCELERATOR },
            });
            render(<IndividualHotkeyToggles />);
            expect(screen.getByTestId('hotkey-copilot-preset')).toBeDisabled();
            expect(
                screen.getByRole('button', { name: /keyboard shortcut: shift \+ super \+ f23/i })
            ).toBeInTheDocument();
        });
    });

    describe('keys owned by the desktop (Wayland portal)', () => {
        let originalElectronAPI: typeof window.electronAPI;

        beforeEach(() => {
            originalElectronAPI = window.electronAPI;
        });

        afterEach(() => {
            window.electronAPI = originalElectronAPI;
        });

        function desktopStatus(quickChatTrigger?: string) {
            return {
                waylandStatus: {
                    isWayland: true,
                    desktopEnvironment: 'gnome',
                    deVersion: '51',
                    portalAvailable: true,
                    portalMethod: 'dbus-direct',
                },
                registrationResults: [
                    quickChatTrigger
                        ? { hotkeyId: 'quickChat', success: true, desktopTrigger: quickChatTrigger }
                        : { hotkeyId: 'quickChat', success: true },
                    { hotkeyId: 'peekAndHide', success: true, desktopTrigger: 'Press <Control><Shift>space' },
                    { hotkeyId: 'voiceChat', success: true },
                ],
                globalHotkeysEnabled: true,
                registrationPending: false,
                canChangeInDesktop: true,
            };
        }

        it('shows the desktop key and opens the desktop dialog instead of recording', async () => {
            const api = setupMockElectronAPI({ platform: 'linux' });
            vi.mocked(api.getPlatformHotkeyStatus).mockResolvedValue(
                desktopStatus('Press <Shift><Super>XF86Assistant') as never
            );
            vi.mocked(api.changeHotkeysInDesktop).mockResolvedValue(true);
            render(<IndividualHotkeyToggles />);

            const quickChat = await screen.findByTestId('hotkey-desktop-trigger-quickChat');
            expect(quickChat).toHaveAttribute('aria-label', 'Keyboard shortcut: Shift + Super + Copilot');
            expect(screen.getByTestId('hotkey-desktop-trigger-voiceChat')).toHaveTextContent('Not set');
            expect(screen.queryByTestId('hotkey-copilot-preset')).not.toBeInTheDocument();
            // App-only hotkeys keep the recorder
            expect(screen.getByRole('button', { name: /keyboard shortcut: ctrl \+ alt \+ p/i })).toBeInTheDocument();

            fireEvent.click(screen.getByTestId('hotkey-change-in-desktop-quickChat'));
            await waitFor(() => expect(api.changeHotkeysInDesktop).toHaveBeenCalledTimes(1));
            expect(await screen.findByRole('status')).toHaveTextContent(/regular key such as Space/);
        });

        it('updates when the desktop reports new keys', async () => {
            const api = setupMockElectronAPI({ platform: 'linux' });
            vi.mocked(api.getPlatformHotkeyStatus).mockResolvedValue(desktopStatus() as never);
            render(<IndividualHotkeyToggles />);
            await screen.findByTestId('hotkey-desktop-trigger-quickChat');

            const listener = vi.mocked(api.onPlatformHotkeyStatusChanged).mock.calls[0][0];
            listener(desktopStatus('Press <Shift><Super>XF86Assistant') as never);

            await waitFor(() =>
                expect(screen.getByTestId('hotkey-desktop-trigger-quickChat')).toHaveAttribute(
                    'aria-label',
                    'Keyboard shortcut: Shift + Super + Copilot'
                )
            );
        });

        it('says where to change the keys when the dialog cannot open', async () => {
            const api = setupMockElectronAPI({ platform: 'linux' });
            vi.mocked(api.getPlatformHotkeyStatus).mockResolvedValue(desktopStatus() as never);
            vi.mocked(api.changeHotkeysInDesktop).mockResolvedValue(false);
            render(<IndividualHotkeyToggles />);

            fireEvent.click(await screen.findByTestId('hotkey-change-in-desktop-peekAndHide'));

            expect(await screen.findByRole('status')).toHaveTextContent(/Settings, under Apps/);
        });

        it('keeps the in-app recorder when the desktop has no dialog', async () => {
            const api = setupMockElectronAPI({ platform: 'linux' });
            vi.mocked(api.getPlatformHotkeyStatus).mockResolvedValue({
                ...desktopStatus(),
                canChangeInDesktop: false,
            } as never);
            render(<IndividualHotkeyToggles />);

            await waitFor(() => expect(api.getPlatformHotkeyStatus).toHaveBeenCalled());
            expect(screen.queryByTestId('hotkey-desktop-trigger-quickChat')).not.toBeInTheDocument();
            expect(screen.getByTestId('hotkey-copilot-preset')).toBeInTheDocument();
        });
    });
});
