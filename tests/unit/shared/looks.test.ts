/**
 * Unit tests for the shared desktop look constants.
 */
import { describe, it, expect } from 'vitest';
import {
    DESKTOP_LOOK_NAMES,
    DESKTOP_LOOKS,
    isDesktopLook,
    isDesktopLookPreference,
} from '../../../src/shared/constants/looks';

describe('shared look constants', () => {
    it('lists every look once, default first', () => {
        expect(DESKTOP_LOOKS[0]).toBe('default');
        expect(new Set(DESKTOP_LOOKS).size).toBe(DESKTOP_LOOKS.length);
        expect(DESKTOP_LOOKS).toHaveLength(11);
    });

    it('names every look', () => {
        expect(Object.keys(DESKTOP_LOOK_NAMES).sort()).toEqual([...DESKTOP_LOOKS].sort());
        expect(DESKTOP_LOOK_NAMES.gnome).toBe('GNOME');
        expect(DESKTOP_LOOK_NAMES.kde).toBe('KDE Plasma');
    });

    it('guards looks and preferences', () => {
        expect(isDesktopLook('gnome')).toBe(true);
        expect(isDesktopLook('auto')).toBe(false);
        expect(isDesktopLook(3)).toBe(false);
        expect(isDesktopLookPreference('auto')).toBe(true);
        expect(isDesktopLookPreference('windows')).toBe(true);
        expect(isDesktopLookPreference('Windows')).toBe(false);
    });
});
