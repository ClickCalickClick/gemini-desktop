/**
 * Look Context for the application.
 *
 * Keeps the desktop look (GNOME, KDE Plasma, macOS, ...) in step with the main process and
 * applies it to the window:
 * - `data-look="<effectiveLook>"` on `<html>`, which the stylesheets in `src/renderer/looks/` key on
 * - `--desktop-accent` on `<html>` when the desktop exposes an accent color
 *
 * The look is separate from the light/dark theme (ThemeContext); every look supports both.
 * Each window (main, Options, Quick Chat) wraps its root in a LookProvider.
 *
 * @module LookContext
 * @example
 * <LookProvider>
 *   <App />
 * </LookProvider>
 *
 * const { look, setLook } = useLook();
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createRendererLogger } from '../utils';
import { getAccentForeground, isSafeAccentColor } from '../utils/accentColor';
import { isDesktopLook, isDesktopLookPreference } from '../../shared/constants/looks';
import type { DesktopLookPreference, LookData } from '../../shared/types/look';

const logger = createRendererLogger('[LookContext]');

// ============================================================================
// Types
// ============================================================================

/** Look context value exposed to consumers */
export interface LookContextType {
    /** Preference, applied look, detected desktop and accent */
    look: LookData;
    /** Change the preference ('auto' follows the desktop) */
    setLook: (preference: DesktopLookPreference) => void;
}

/** The look before the main process answers, and outside Electron: today's look. */
// eslint-disable-next-line react-refresh/only-export-components -- default exported for tests and consumers
export const DEFAULT_LOOK_DATA: LookData = {
    preference: 'default',
    effectiveLook: 'default',
    detectedDesktop: null,
    accentColor: null,
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check and normalise look data from the main process.
 * @returns The data, or null when it is not look data
 */
// eslint-disable-next-line react-refresh/only-export-components -- helper exported for tests
export function normalizeLookData(data: unknown): LookData | null {
    if (typeof data !== 'object' || data === null) {
        return null;
    }
    const candidate = data as Partial<LookData>;
    if (!isDesktopLook(candidate.effectiveLook)) {
        return null;
    }
    const preference: DesktopLookPreference = isDesktopLookPreference(candidate.preference)
        ? candidate.preference
        : 'default';
    return {
        preference,
        effectiveLook: candidate.effectiveLook,
        detectedDesktop: typeof candidate.detectedDesktop === 'string' ? candidate.detectedDesktop : null,
        accentColor:
            typeof candidate.accentColor === 'string' && isSafeAccentColor(candidate.accentColor)
                ? candidate.accentColor.trim()
                : null,
    };
}

/**
 * Apply a look to the document: `data-look`, the `--desktop-accent` variable and
 * `--desktop-accent-fg`, black or white text for that accent, whichever contrasts more.
 */
// eslint-disable-next-line react-refresh/only-export-components -- helper exported for tests and non-React entries
export function applyLookToDom(data: LookData, root: HTMLElement = document.documentElement): void {
    root.setAttribute('data-look', data.effectiveLook);
    const foreground = data.accentColor ? getAccentForeground(data.accentColor) : null;
    if (data.accentColor && foreground) {
        root.style.setProperty('--desktop-accent', data.accentColor);
        root.style.setProperty('--desktop-accent-fg', foreground);
    } else {
        root.style.removeProperty('--desktop-accent');
        root.style.removeProperty('--desktop-accent-fg');
    }
}

// ============================================================================
// Context
// ============================================================================

const LookContext = createContext<LookContextType | undefined>(undefined);

interface LookProviderProps {
    children: React.ReactNode;
}

/**
 * Look provider: loads the look, follows look:changed and applies it to `<html>`.
 */
export function LookProvider({ children }: LookProviderProps) {
    const [look, setLookState] = useState<LookData>(DEFAULT_LOOK_DATA);

    useEffect(() => {
        const abortController = new AbortController();
        const { signal } = abortController;
        const api = window.electronAPI;

        const apply = (data: unknown, source: string): void => {
            /* v8 ignore next -- race guard for callbacks after unmount */
            if (signal.aborted) return;
            const normalized = normalizeLookData(data);
            if (!normalized) {
                logger.warn(`Received invalid look data (${source}):`, data);
                return;
            }
            setLookState(normalized);
            applyLookToDom(normalized);
        };

        applyLookToDom(DEFAULT_LOOK_DATA);

        if (!api || typeof api.getLook !== 'function') {
            return (): void => abortController.abort();
        }

        api.getLook()
            .then((data) => apply(data, 'get'))
            .catch((error: unknown) => {
                logger.error('Failed to load the look:', error);
            });

        const cleanup =
            typeof api.onLookChanged === 'function' ? api.onLookChanged((data) => apply(data, 'changed')) : undefined;

        return (): void => {
            abortController.abort();
            cleanup?.();
        };
    }, []);

    const setLook = useCallback((preference: DesktopLookPreference) => {
        // The main process answers with look:changed, which carries the resolved look
        setLookState((current) => ({ ...current, preference }));
        try {
            window.electronAPI?.setLook(preference);
        } catch (error) {
            logger.error('Failed to set the look:', error);
        }
    }, []);

    const value = useMemo(() => ({ look, setLook }), [look, setLook]);

    return <LookContext.Provider value={value}>{children}</LookContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

const FALLBACK_CONTEXT: LookContextType = {
    look: DEFAULT_LOOK_DATA,
    setLook: () => {
        logger.warn('setLook called outside a LookProvider');
    },
};

/**
 * Access the look. Outside a LookProvider it returns the default look, so components such as
 * WindowControls keep today's behaviour when rendered on their own (tests, other windows).
 */
// eslint-disable-next-line react-refresh/only-export-components -- context hook export pattern used across renderer contexts
export function useLook(): LookContextType {
    return useContext(LookContext) ?? FALLBACK_CONTEXT;
}
