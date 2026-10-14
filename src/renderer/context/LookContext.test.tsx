/**
 * Unit tests for LookContext: loading the look, applying data-look and --desktop-accent,
 * following look:changed and setting the preference.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { LookProvider, useLook, applyLookToDom, normalizeLookData, DEFAULT_LOOK_DATA } from './LookContext';
import type { LookData } from '../../shared/types/look';

const GNOME: LookData = {
    preference: 'auto',
    effectiveLook: 'gnome',
    detectedDesktop: 'GNOME',
    accentColor: '#3584e4',
};

function Consumer() {
    const { look, setLook } = useLook();
    return (
        <div>
            <span data-testid="effective">{look.effectiveLook}</span>
            <span data-testid="preference">{look.preference}</span>
            <span data-testid="accent">{look.accentColor ?? 'none'}</span>
            <button onClick={() => setLook('kde')}>kde</button>
        </div>
    );
}

const root = () => document.documentElement;

describe('LookContext', () => {
    let lookChanged: ((data: unknown) => void) | undefined;
    const unsubscribe = vi.fn();

    beforeEach(() => {
        lookChanged = undefined;
        root().removeAttribute('data-look');
        root().style.removeProperty('--desktop-accent');
        vi.mocked(window.electronAPI.getLook).mockResolvedValue(GNOME);
        vi.mocked(window.electronAPI.onLookChanged).mockImplementation((callback) => {
            lookChanged = callback as (data: unknown) => void;
            return unsubscribe;
        });
    });

    afterEach(() => {
        vi.mocked(window.electronAPI.getLook).mockResolvedValue(DEFAULT_LOOK_DATA);
        vi.mocked(window.electronAPI.onLookChanged).mockReturnValue(() => {});
    });

    it('applies data-look and the accent variable from getLook', async () => {
        render(
            <LookProvider>
                <Consumer />
            </LookProvider>
        );

        await waitFor(() => expect(screen.getByTestId('effective')).toHaveTextContent('gnome'));
        expect(root().getAttribute('data-look')).toBe('gnome');
        expect(root().style.getPropertyValue('--desktop-accent')).toBe('#3584e4');
        expect(root().style.getPropertyValue('--desktop-accent-fg')).toBe('#ffffff');
        expect(screen.getByTestId('preference')).toHaveTextContent('auto');
    });

    it('starts with the default look before the main process answers', () => {
        vi.mocked(window.electronAPI.getLook).mockReturnValue(new Promise(() => {}));
        render(
            <LookProvider>
                <Consumer />
            </LookProvider>
        );
        expect(root().getAttribute('data-look')).toBe('default');
        expect(screen.getByTestId('effective')).toHaveTextContent('default');
    });

    it('follows look:changed and removes the accent when it goes away', async () => {
        render(
            <LookProvider>
                <Consumer />
            </LookProvider>
        );
        await waitFor(() => expect(root().getAttribute('data-look')).toBe('gnome'));

        act(() => {
            lookChanged?.({ preference: 'kde', effectiveLook: 'kde', detectedDesktop: 'GNOME', accentColor: null });
        });

        expect(root().getAttribute('data-look')).toBe('kde');
        expect(root().style.getPropertyValue('--desktop-accent')).toBe('');
        expect(root().style.getPropertyValue('--desktop-accent-fg')).toBe('');
        expect(screen.getByTestId('accent')).toHaveTextContent('none');
    });

    it('ignores invalid look data', async () => {
        render(
            <LookProvider>
                <Consumer />
            </LookProvider>
        );
        await waitFor(() => expect(root().getAttribute('data-look')).toBe('gnome'));

        act(() => {
            lookChanged?.({ effectiveLook: 'aqua' });
            lookChanged?.(null);
        });
        expect(root().getAttribute('data-look')).toBe('gnome');
    });

    it('sends the preference to the main process', async () => {
        render(
            <LookProvider>
                <Consumer />
            </LookProvider>
        );
        await waitFor(() => expect(screen.getByTestId('effective')).toHaveTextContent('gnome'));

        act(() => {
            screen.getByText('kde').click();
        });
        expect(window.electronAPI.setLook).toHaveBeenCalledWith('kde');
        expect(screen.getByTestId('preference')).toHaveTextContent('kde');
    });

    it('keeps the default look when getLook fails', async () => {
        vi.mocked(window.electronAPI.getLook).mockRejectedValue(new Error('no handler'));
        render(
            <LookProvider>
                <Consumer />
            </LookProvider>
        );
        await waitFor(() => expect(window.electronAPI.getLook).toHaveBeenCalled());
        expect(root().getAttribute('data-look')).toBe('default');
    });

    it('unsubscribes on unmount', async () => {
        const { unmount } = render(
            <LookProvider>
                <Consumer />
            </LookProvider>
        );
        await waitFor(() => expect(window.electronAPI.onLookChanged).toHaveBeenCalled());
        unmount();
        expect(unsubscribe).toHaveBeenCalled();
    });

    it('works without the look API', () => {
        const api = window.electronAPI as unknown as Record<string, unknown>;
        const original = api.getLook;
        api.getLook = undefined;
        try {
            render(
                <LookProvider>
                    <Consumer />
                </LookProvider>
            );
            expect(root().getAttribute('data-look')).toBe('default');
        } finally {
            api.getLook = original;
        }
    });

    it('returns the default look outside a provider', () => {
        render(<Consumer />);
        expect(screen.getByTestId('effective')).toHaveTextContent('default');
        act(() => {
            screen.getByText('kde').click();
        });
        expect(window.electronAPI.setLook).not.toHaveBeenCalled();
    });

    describe('normalizeLookData', () => {
        it('accepts valid data and drops unsafe accents', () => {
            expect(normalizeLookData(GNOME)).toEqual(GNOME);
            expect(normalizeLookData({ ...GNOME, accentColor: 'rgb(53, 132, 228)' })?.accentColor).toBe(
                'rgb(53, 132, 228)'
            );
            expect(normalizeLookData({ ...GNOME, accentColor: 'red; background: url(x)' })?.accentColor).toBeNull();
            expect(normalizeLookData({ ...GNOME, accentColor: '#12345' })?.accentColor).toBeNull();
            expect(normalizeLookData({ ...GNOME, accentColor: '#1234567' })?.accentColor).toBeNull();
            expect(normalizeLookData({ ...GNOME, accentColor: '#3584e4cc' })?.accentColor).toBe('#3584e4cc');
            expect(normalizeLookData({ ...GNOME, preference: 'bogus', detectedDesktop: 3 })).toMatchObject({
                preference: 'default',
                detectedDesktop: null,
            });
            expect(normalizeLookData('gnome')).toBeNull();
        });
    });

    describe('applyLookToDom', () => {
        it('sets and clears the attribute and variable', () => {
            const element = document.createElement('div');
            applyLookToDom(GNOME, element);
            expect(element.getAttribute('data-look')).toBe('gnome');
            expect(element.style.getPropertyValue('--desktop-accent')).toBe('#3584e4');
            expect(element.style.getPropertyValue('--desktop-accent-fg')).toBe('#ffffff');
            applyLookToDom(DEFAULT_LOOK_DATA, element);
            expect(element.getAttribute('data-look')).toBe('default');
            expect(element.style.getPropertyValue('--desktop-accent')).toBe('');
            expect(element.style.getPropertyValue('--desktop-accent-fg')).toBe('');
        });

        it('uses dark text on a light desktop accent such as GNOME yellow', () => {
            const element = document.createElement('div');
            applyLookToDom({ ...GNOME, accentColor: '#e5a50a' }, element);
            expect(element.style.getPropertyValue('--desktop-accent')).toBe('#e5a50a');
            expect(element.style.getPropertyValue('--desktop-accent-fg')).toBe('#000000');
        });
    });
});
