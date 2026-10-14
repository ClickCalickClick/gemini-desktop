/**
 * Unit tests for OptionsWindowTitlebar component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OptionsWindowTitlebar } from './OptionsWindowTitlebar';
import { LookProvider } from '../../context/LookContext';
import type { DesktopLook } from '../../../shared/types/look';
import { setMockPlatform } from '../../../../tests/unit/renderer/test/setup';

// Mock the useWindowControls hook
const mockMinimize = vi.fn();
const mockMaximize = vi.fn();
const mockClose = vi.fn();

vi.mock('../../hooks/useWindowControls', () => ({
    useWindowControls: () => ({
        minimize: mockMinimize,
        maximize: mockMaximize,
        close: mockClose,
    }),
}));

describe('OptionsWindowTitlebar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockPlatform('win32'); // Default to Windows
    });

    describe('rendering', () => {
        it('should render the titlebar with default title', () => {
            render(<OptionsWindowTitlebar />);

            expect(screen.getByTestId('options-titlebar')).toBeInTheDocument();
            expect(screen.getByTestId('options-titlebar-title')).toHaveTextContent('Options');
        });

        it('should render with custom title', () => {
            render(<OptionsWindowTitlebar title="Settings" />);

            expect(screen.getByTestId('options-titlebar-title')).toHaveTextContent('Settings');
        });

        it('should render window controls on Windows/Linux', () => {
            setMockPlatform('win32');
            render(<OptionsWindowTitlebar />);

            expect(screen.getByTestId('options-window-controls')).toBeInTheDocument();
            expect(screen.getByTestId('options-minimize-button')).toBeInTheDocument();
            expect(screen.getByTestId('options-close-button')).toBeInTheDocument();

            // Maximize button should NOT be present
            expect(screen.queryByTestId('options-maximize-button')).not.toBeInTheDocument();
        });

        it('should render window controls on all platforms (including macOS)', () => {
            setMockPlatform('darwin'); // macOS
            render(<OptionsWindowTitlebar />);

            // Controls should still be present for consistent UX and testability
            expect(screen.getByTestId('options-window-controls')).toBeInTheDocument();
            expect(screen.getByTestId('options-minimize-button')).toBeInTheDocument();
            expect(screen.getByTestId('options-close-button')).toBeInTheDocument();
        });

        it('should have a draggable region', () => {
            render(<OptionsWindowTitlebar />);

            const dragRegion = screen.getByTestId('options-titlebar-title').parentElement;
            expect(dragRegion).toHaveClass('options-titlebar-drag-region');
        });
    });

    describe('macOS specific styling', () => {
        it('should apply macos class when running on macOS', () => {
            setMockPlatform('darwin');
            render(<OptionsWindowTitlebar />);

            const header = screen.getByTestId('options-titlebar');
            expect(header).toHaveClass('macos');
        });

        it('should NOT apply macos class when running on Windows', () => {
            setMockPlatform('win32');
            render(<OptionsWindowTitlebar />);

            const header = screen.getByTestId('options-titlebar');
            expect(header).not.toHaveClass('macos');
        });
    });

    describe('window controls functionality', () => {
        it('should call minimize when minimize button is clicked', () => {
            render(<OptionsWindowTitlebar />);

            fireEvent.click(screen.getByTestId('options-minimize-button'));
            expect(mockMinimize).toHaveBeenCalledTimes(1);
        });

        it('should call close when close button is clicked', () => {
            render(<OptionsWindowTitlebar />);

            fireEvent.click(screen.getByTestId('options-close-button'));
            expect(mockClose).toHaveBeenCalledTimes(1);
        });
    });

    describe('accessibility', () => {
        it('should have accessible labels on window control buttons', () => {
            render(<OptionsWindowTitlebar />);

            expect(screen.getByLabelText('Minimize window')).toBeInTheDocument();
            expect(screen.getByLabelText('Close window')).toBeInTheDocument();
            expect(screen.queryByLabelText('Maximize window')).not.toBeInTheDocument();
        });

        it('should have title attributes for tooltips', () => {
            render(<OptionsWindowTitlebar />);

            expect(screen.getByTitle('Minimize')).toBeInTheDocument();
            expect(screen.getByTitle('Close')).toBeInTheDocument();
            expect(screen.queryByTitle('Maximize')).not.toBeInTheDocument();
        });
    });

    describe('no menu bar', () => {
        it('should NOT render any menu elements', () => {
            render(<OptionsWindowTitlebar />);

            // Ensure no menu bar is present (unlike main titlebar)
            expect(screen.queryByRole('menubar')).not.toBeInTheDocument();
            expect(screen.queryByTestId('titlebar-menu-bar')).not.toBeInTheDocument();
        });
    });

    describe('desktop looks', () => {
        const renderWithLook = async (look: DesktopLook) => {
            vi.mocked(window.electronAPI.getLook).mockResolvedValue({
                preference: look,
                effectiveLook: look,
                detectedDesktop: null,
                accentColor: null,
            });
            const result = render(
                <LookProvider>
                    <OptionsWindowTitlebar />
                </LookProvider>
            );
            await waitFor(() => expect(document.documentElement.getAttribute('data-look')).toBe(look));
            return result;
        };

        afterEach(() => {
            vi.mocked(window.electronAPI.getLook).mockResolvedValue({
                preference: 'default',
                effectiveLook: 'default',
                detectedDesktop: null,
                accentColor: null,
            });
        });

        it('GNOME shows only close', async () => {
            setMockPlatform('linux');
            await renderWithLook('gnome');

            expect(screen.getByTestId('options-window-controls')).toContainElement(
                screen.getByTestId('options-close-button')
            );
            expect(screen.queryByTestId('options-minimize-button')).not.toBeInTheDocument();
        });

        it('the macOS look on Linux puts close and minimize on the left', async () => {
            setMockPlatform('linux');
            await renderWithLook('macos');

            const left = screen.getByTestId('options-window-controls-left');
            expect(left).toContainElement(screen.getByTestId('options-close-button'));
            expect(left).toContainElement(screen.getByTestId('options-minimize-button'));
            fireEvent.click(screen.getByTestId('options-close-button'));
            expect(mockClose).toHaveBeenCalledTimes(1);
        });

        it('elementary puts close on the left', async () => {
            setMockPlatform('linux');
            await renderWithLook('elementary');

            expect(screen.getByTestId('options-window-controls-left')).toContainElement(
                screen.getByTestId('options-close-button')
            );
        });

        it('KDE keeps minimize and close on the right', async () => {
            setMockPlatform('linux');
            await renderWithLook('kde');

            const right = screen.getByTestId('options-window-controls');
            expect(right).toContainElement(screen.getByTestId('options-minimize-button'));
            expect(right).toContainElement(screen.getByTestId('options-close-button'));
        });

        it('keeps the usual controls on macOS whatever the look', async () => {
            setMockPlatform('darwin');
            await renderWithLook('gnome');

            expect(screen.getByTestId('options-minimize-button')).toBeInTheDocument();
            expect(screen.getByTestId('options-close-button')).toBeInTheDocument();
            expect(screen.queryByTestId('options-window-controls-left')).not.toBeInTheDocument();
        });
    });
});
