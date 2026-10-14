/**
 * Unit tests for WindowControls component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WindowControls } from './WindowControls';
import { LookProvider } from '../../context/LookContext';
import type { DesktopLook } from '../../../shared/types/look';
import { setMockPlatform } from '../../../../tests/unit/renderer/test/setup';

// Mock dependencies
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

describe('WindowControls', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockPlatform('win32');
    });

    describe('platform behavior', () => {
        it('renders controls on Windows', () => {
            setMockPlatform('win32');
            render(<WindowControls />);

            expect(screen.getByRole('button', { name: /minimize/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /maximize/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
        });

        it('renders controls on Linux', () => {
            setMockPlatform('linux');
            render(<WindowControls />);

            expect(screen.getByRole('button', { name: /minimize/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /maximize/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
        });

        it('returns null on macOS', () => {
            setMockPlatform('darwin');
            const { container } = render(<WindowControls />);

            expect(container.firstChild).toBeNull();
        });
    });

    describe('button interactions', () => {
        it('clicking minimize button calls minimize handler', () => {
            render(<WindowControls />);
            const minimizeBtn = screen.getByRole('button', { name: /minimize/i });

            fireEvent.click(minimizeBtn);

            expect(mockMinimize).toHaveBeenCalledTimes(1);
        });

        it('clicking maximize button calls maximize handler', () => {
            render(<WindowControls />);
            const maximizeBtn = screen.getByRole('button', { name: /maximize/i });

            fireEvent.click(maximizeBtn);

            expect(mockMaximize).toHaveBeenCalledTimes(1);
        });

        it('clicking close button calls close handler', () => {
            render(<WindowControls />);
            const closeBtn = screen.getByRole('button', { name: /close/i });

            fireEvent.click(closeBtn);

            expect(mockClose).toHaveBeenCalledTimes(1);
        });
    });

    describe('accessibility', () => {
        it('minimize button has correct aria-label', () => {
            render(<WindowControls />);
            const btn = screen.getByRole('button', { name: 'Minimize window' });

            expect(btn).toBeInTheDocument();
        });

        it('maximize button has correct aria-label', () => {
            render(<WindowControls />);
            const btn = screen.getByRole('button', { name: 'Maximize window' });

            expect(btn).toBeInTheDocument();
        });

        it('close button has correct aria-label', () => {
            render(<WindowControls />);
            const btn = screen.getByRole('button', { name: 'Close window' });

            expect(btn).toBeInTheDocument();
        });

        it('buttons have title attributes for tooltips', () => {
            render(<WindowControls />);

            expect(screen.getByTitle('Minimize')).toBeInTheDocument();
            expect(screen.getByTitle('Maximize')).toBeInTheDocument();
            expect(screen.getByTitle('Close')).toBeInTheDocument();
        });
    });

    describe('CSS classes', () => {
        it('has correct CSS classes for styling', () => {
            render(<WindowControls />);

            const minimizeBtn = screen.getByRole('button', { name: /minimize/i });
            const maximizeBtn = screen.getByRole('button', { name: /maximize/i });
            const closeBtn = screen.getByRole('button', { name: /close/i });

            expect(minimizeBtn).toHaveClass('window-control-button', 'minimize');
            expect(maximizeBtn).toHaveClass('window-control-button', 'maximize');
            expect(closeBtn).toHaveClass('window-control-button', 'close');
        });
    });

    describe('desktop looks', () => {
        const renderWithLook = async (look: DesktopLook) => {
            vi.mocked(window.electronAPI.getLook).mockResolvedValue({
                preference: look,
                effectiveLook: look,
                detectedDesktop: 'GNOME',
                accentColor: null,
            });
            const result = render(
                <LookProvider>
                    <WindowControls />
                </LookProvider>
            );
            await waitFor(() => expect(document.documentElement.getAttribute('data-look')).toBe(look));
            return result;
        };

        const testIds = (container: HTMLElement | null) =>
            Array.from(container?.querySelectorAll('button') ?? []).map((button) => button.getAttribute('data-testid'));

        afterEach(() => {
            vi.mocked(window.electronAPI.getLook).mockResolvedValue({
                preference: 'default',
                effectiveLook: 'default',
                detectedDesktop: null,
                accentColor: null,
            });
        });

        it('GNOME shows only close, on the right', async () => {
            setMockPlatform('linux');
            const { container } = await renderWithLook('gnome');

            expect(screen.queryByTestId('minimize-button')).not.toBeInTheDocument();
            expect(screen.queryByTestId('maximize-button')).not.toBeInTheDocument();
            expect(screen.queryByTestId('window-controls-left')).not.toBeInTheDocument();
            fireEvent.click(screen.getByTestId('close-button'));
            expect(mockClose).toHaveBeenCalledTimes(1);
            expect(container.querySelector('.window-controls')).toContainElement(screen.getByTestId('close-button'));
        });

        it('elementary puts close on the left and maximize on the right', async () => {
            setMockPlatform('linux');
            const { container } = await renderWithLook('elementary');

            expect(testIds(screen.getByTestId('window-controls-left'))).toEqual(['close-button']);
            expect(testIds(container.querySelector('.window-controls:not(.window-controls--left)'))).toEqual([
                'maximize-button',
            ]);
            expect(screen.queryByTestId('minimize-button')).not.toBeInTheDocument();
        });

        it('the macOS look on Linux puts traffic lights on the left', async () => {
            setMockPlatform('linux');
            const { container } = await renderWithLook('macos');

            expect(testIds(screen.getByTestId('window-controls-left'))).toEqual([
                'close-button',
                'minimize-button',
                'maximize-button',
            ]);
            expect(container.querySelector('.window-controls:not(.window-controls--left)')).toBeNull();
            fireEvent.click(screen.getByTestId('minimize-button'));
            expect(mockMinimize).toHaveBeenCalledTimes(1);
        });

        it.each(['kde', 'windows', 'xfce', 'cinnamon', 'mate', 'budgie', 'cosmic', 'default'] as DesktopLook[])(
            '%s keeps minimize, maximize and close on the right',
            async (look) => {
                setMockPlatform('linux');
                const { container } = await renderWithLook(look);

                expect(screen.queryByTestId('window-controls-left')).not.toBeInTheDocument();
                expect(testIds(container.querySelector('.window-controls'))).toEqual([
                    'minimize-button',
                    'maximize-button',
                    'close-button',
                ]);
            }
        );

        it('keeps the native macOS controls whatever the look', async () => {
            setMockPlatform('darwin');
            const { container } = await renderWithLook('gnome');

            expect(container.querySelector('button')).toBeNull();
        });
    });
});
