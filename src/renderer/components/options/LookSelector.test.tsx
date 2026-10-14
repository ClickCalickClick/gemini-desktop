/**
 * Unit tests for LookSelector component.
 *
 * Tests rendering, the Auto label, selection, keyboard interaction and live updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { LookSelector, LOOK_OPTIONS, getAutoLabel } from './LookSelector';
import { LookProvider } from '../../context/LookContext';
import type { LookData } from '../../../shared/types/look';

const renderWithLook = async (data: Partial<LookData> = {}) => {
    vi.mocked(window.electronAPI.getLook).mockResolvedValue({
        preference: 'auto',
        effectiveLook: 'gnome',
        detectedDesktop: 'GNOME',
        accentColor: null,
        ...data,
    });
    const result = render(
        <LookProvider>
            <LookSelector />
        </LookProvider>
    );
    await waitFor(() => expect(window.electronAPI.getLook).toHaveBeenCalled());
    await waitFor(() => expect(document.documentElement.getAttribute('data-look')).toBe(data.effectiveLook ?? 'gnome'));
    return result;
};

describe('LookSelector', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.mocked(window.electronAPI.getLook).mockResolvedValue({
            preference: 'default',
            effectiveLook: 'default',
            detectedDesktop: null,
            accentColor: null,
        });
        vi.mocked(window.electronAPI.onLookChanged).mockReturnValue(() => {});
    });

    describe('rendering', () => {
        it('renders the selector and a card for every look', async () => {
            await renderWithLook();

            expect(screen.getByTestId('look-selector')).toBeInTheDocument();
            for (const option of LOOK_OPTIONS) {
                expect(screen.getByTestId(`look-card-${option.id}`)).toBeInTheDocument();
            }
            expect(LOOK_OPTIONS.map((option) => option.id)).toEqual([
                'auto',
                'default',
                'gnome',
                'kde',
                'xfce',
                'cinnamon',
                'mate',
                'budgie',
                'elementary',
                'cosmic',
                'macos',
                'windows',
            ]);
        });

        it('names the detected desktop on the Auto card', async () => {
            await renderWithLook();

            expect(screen.getByTestId('look-card-auto')).toHaveTextContent('Auto (GNOME detected)');
            expect(screen.getByTestId('look-selector-description')).toHaveTextContent('Applied: GNOME.');
        });

        it('shows plain Auto when no desktop was detected', async () => {
            await renderWithLook({ preference: 'default', effectiveLook: 'default', detectedDesktop: null });

            expect(screen.getByTestId('look-card-auto')).toHaveTextContent(/^Auto$/);
            expect(screen.getByTestId('look-selector-description')).not.toHaveTextContent('Applied');
        });

        it('builds the Auto label', () => {
            expect(getAutoLabel('KDE Plasma')).toBe('Auto (KDE Plasma detected)');
            expect(getAutoLabel(null)).toBe('Auto');
        });
    });

    describe('selection state', () => {
        it('marks the current preference as checked', async () => {
            await renderWithLook({ preference: 'kde', effectiveLook: 'kde' });

            expect(screen.getByTestId('look-card-kde')).toHaveAttribute('aria-checked', 'true');
            expect(screen.getByTestId('look-card-auto')).toHaveAttribute('aria-checked', 'false');
            expect(screen.getByTestId('look-card-default')).toHaveAttribute('aria-checked', 'false');
        });

        it('uses a radiogroup with labelled radios', async () => {
            await renderWithLook();

            expect(screen.getByRole('radiogroup', { name: 'Look selection' })).toBeInTheDocument();
            expect(screen.getByRole('radio', { name: 'GNOME look' })).toBeInTheDocument();
            expect(screen.getAllByRole('radio')).toHaveLength(LOOK_OPTIONS.length);
        });
    });

    describe('interaction', () => {
        it('calls setLook when a card is clicked', async () => {
            await renderWithLook();

            fireEvent.click(screen.getByTestId('look-card-kde'));

            expect(window.electronAPI.setLook).toHaveBeenCalledWith('kde');
            expect(screen.getByTestId('look-card-kde')).toHaveAttribute('aria-checked', 'true');
        });

        it('selects with Enter and Space', async () => {
            await renderWithLook();

            fireEvent.keyDown(screen.getByTestId('look-card-macos'), { key: 'Enter' });
            expect(window.electronAPI.setLook).toHaveBeenCalledWith('macos');

            fireEvent.keyDown(screen.getByTestId('look-card-default'), { key: ' ' });
            expect(window.electronAPI.setLook).toHaveBeenCalledWith('default');
        });

        it('ignores other keys', async () => {
            await renderWithLook();

            fireEvent.keyDown(screen.getByTestId('look-card-kde'), { key: 'Tab' });
            expect(window.electronAPI.setLook).not.toHaveBeenCalled();
        });
    });

    describe('keyboard (WAI-ARIA radio group)', () => {
        const tabStops = () => screen.getAllByRole('radio').filter((card) => card.getAttribute('tabindex') === '0');

        it('has one tab stop: the selected card', async () => {
            await renderWithLook({ preference: 'kde', effectiveLook: 'kde' });

            expect(tabStops()).toEqual([screen.getByTestId('look-card-kde')]);
            expect(screen.getByTestId('look-card-auto')).toHaveAttribute('tabindex', '-1');
        });

        it('falls back to the Default card for an unknown preference', async () => {
            await renderWithLook({ preference: 'bogus' as LookData['preference'], effectiveLook: 'gnome' });

            expect(tabStops()).toEqual([screen.getByTestId('look-card-default')]);
        });

        it('moves focus and selection with the arrow keys', async () => {
            await renderWithLook({ preference: 'gnome', effectiveLook: 'gnome' });
            const gnome = screen.getByTestId('look-card-gnome');
            gnome.focus();

            fireEvent.keyDown(gnome, { key: 'ArrowRight' });
            expect(window.electronAPI.setLook).toHaveBeenLastCalledWith('kde');
            expect(screen.getByTestId('look-card-kde')).toHaveFocus();
            expect(tabStops()).toEqual([screen.getByTestId('look-card-kde')]);

            fireEvent.keyDown(screen.getByTestId('look-card-kde'), { key: 'ArrowDown' });
            expect(window.electronAPI.setLook).toHaveBeenLastCalledWith('xfce');
            expect(screen.getByTestId('look-card-xfce')).toHaveFocus();

            fireEvent.keyDown(screen.getByTestId('look-card-xfce'), { key: 'ArrowLeft' });
            expect(window.electronAPI.setLook).toHaveBeenLastCalledWith('kde');

            fireEvent.keyDown(screen.getByTestId('look-card-kde'), { key: 'ArrowUp' });
            expect(window.electronAPI.setLook).toHaveBeenLastCalledWith('gnome');
            expect(gnome).toHaveFocus();
        });

        it('wraps around at both ends', async () => {
            await renderWithLook({ preference: 'auto' });

            fireEvent.keyDown(screen.getByTestId('look-card-auto'), { key: 'ArrowLeft' });
            expect(window.electronAPI.setLook).toHaveBeenLastCalledWith('windows');
            expect(screen.getByTestId('look-card-windows')).toHaveFocus();

            fireEvent.keyDown(screen.getByTestId('look-card-windows'), { key: 'ArrowRight' });
            expect(window.electronAPI.setLook).toHaveBeenLastCalledWith('auto');
            expect(screen.getByTestId('look-card-auto')).toHaveFocus();
        });

        it('goes to the first and last card with Home and End', async () => {
            await renderWithLook({ preference: 'kde', effectiveLook: 'kde' });

            fireEvent.keyDown(screen.getByTestId('look-card-kde'), { key: 'End' });
            expect(window.electronAPI.setLook).toHaveBeenLastCalledWith('windows');
            expect(screen.getByTestId('look-card-windows')).toHaveFocus();

            fireEvent.keyDown(screen.getByTestId('look-card-windows'), { key: 'Home' });
            expect(window.electronAPI.setLook).toHaveBeenLastCalledWith('auto');
            expect(screen.getByTestId('look-card-auto')).toHaveFocus();
        });
    });

    describe('live updates', () => {
        it('follows look changes from another window', async () => {
            let lookChanged: ((data: LookData) => void) | undefined;
            vi.mocked(window.electronAPI.onLookChanged).mockImplementation((callback) => {
                lookChanged = callback;
                return () => {};
            });
            await renderWithLook();

            act(() => {
                lookChanged?.({
                    preference: 'windows',
                    effectiveLook: 'windows',
                    detectedDesktop: 'GNOME',
                    accentColor: null,
                });
            });

            expect(screen.getByTestId('look-card-windows')).toHaveAttribute('aria-checked', 'true');
            expect(document.documentElement.getAttribute('data-look')).toBe('windows');
        });
    });
});
