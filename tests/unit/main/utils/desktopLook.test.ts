/**
 * Unit tests for desktop look detection.
 */
import { describe, it, expect } from 'vitest';
import {
    detectDesktop,
    isDesktopLookPreference,
    lookFromDesktopToken,
    resolveEffectiveLook,
} from '../../../../src/main/utils/desktopLook';

describe('desktopLook', () => {
    describe('detectDesktop', () => {
        it('maps macOS and Windows to their own looks', () => {
            expect(detectDesktop('darwin', {})).toEqual({ look: 'macos', name: 'macOS' });
            expect(detectDesktop('win32', { XDG_CURRENT_DESKTOP: 'GNOME' })).toEqual({
                look: 'windows',
                name: 'Windows',
            });
        });

        it.each([
            ['GNOME', 'gnome', 'GNOME'],
            ['ubuntu:GNOME', 'gnome', 'GNOME'],
            ['zorin:GNOME', 'gnome', 'GNOME'],
            ['Zorin', 'gnome', 'GNOME'],
            ['gnome', 'gnome', 'GNOME'],
            ['KDE', 'kde', 'KDE Plasma'],
            ['XFCE', 'xfce', 'Xfce'],
            ['X-Cinnamon', 'cinnamon', 'Cinnamon'],
            ['Cinnamon', 'cinnamon', 'Cinnamon'],
            ['MATE', 'mate', 'MATE'],
            ['Budgie:GNOME', 'budgie', 'Budgie'],
            ['Pantheon', 'elementary', 'elementary OS'],
            ['COSMIC', 'cosmic', 'COSMIC'],
            ['pop:COSMIC', 'cosmic', 'COSMIC'],
        ])('reads XDG_CURRENT_DESKTOP=%s as %s', (value, look, name) => {
            expect(detectDesktop('linux', { XDG_CURRENT_DESKTOP: value })).toEqual({ look, name });
        });

        it('falls back to XDG_SESSION_DESKTOP and DESKTOP_SESSION', () => {
            expect(detectDesktop('linux', { XDG_SESSION_DESKTOP: 'plasmawayland' }).look).toBe('kde');
            expect(detectDesktop('linux', { DESKTOP_SESSION: 'xubuntu' }).look).toBe('xfce');
            expect(detectDesktop('linux', { DESKTOP_SESSION: '/usr/share/xsessions/cinnamon' }).look).toBe('cinnamon');
            expect(detectDesktop('linux', { DESKTOP_SESSION: 'ubuntu-wayland' }).look).toBe('gnome');
            expect(detectDesktop('linux', { DESKTOP_SESSION: 'ubuntu-budgie' }).look).toBe('budgie');
            expect(detectDesktop('linux', { DESKTOP_SESSION: 'ubuntu-mate' }).look).toBe('mate');
            expect(detectDesktop('linux', { DESKTOP_SESSION: 'pantheon' }).look).toBe('elementary');
        });

        it('prefers XDG_CURRENT_DESKTOP over the session names', () => {
            expect(detectDesktop('linux', { XDG_CURRENT_DESKTOP: 'KDE', DESKTOP_SESSION: 'gnome' }).look).toBe('kde');
        });

        it('returns the default look and the raw name for unknown desktops', () => {
            expect(detectDesktop('linux', { XDG_CURRENT_DESKTOP: 'Hyprland' })).toEqual({
                look: 'default',
                name: 'Hyprland',
            });
            expect(detectDesktop('linux', { DESKTOP_SESSION: 'sway' })).toEqual({ look: 'default', name: 'sway' });
        });

        it('returns no name when nothing is set', () => {
            expect(detectDesktop('linux', {})).toEqual({ look: 'default', name: null });
        });

        it('is case-insensitive and ignores empty entries', () => {
            expect(detectDesktop('linux', { XDG_CURRENT_DESKTOP: ' :gNoMe: ' }).look).toBe('gnome');
        });
    });

    describe('lookFromDesktopToken', () => {
        it('returns null for empty and unknown tokens', () => {
            expect(lookFromDesktopToken('')).toBeNull();
            expect(lookFromDesktopToken('sway')).toBeNull();
        });
    });

    describe('isDesktopLookPreference', () => {
        it('accepts auto and every look', () => {
            for (const value of ['auto', 'default', 'gnome', 'kde', 'macos', 'windows', 'cosmic']) {
                expect(isDesktopLookPreference(value)).toBe(true);
            }
        });

        it('rejects anything else', () => {
            for (const value of ['', 'GNOME', 'aqua', 1, null, undefined, {}]) {
                expect(isDesktopLookPreference(value)).toBe(false);
            }
        });
    });

    describe('resolveEffectiveLook', () => {
        it('resolves auto to the detected look and keeps explicit looks', () => {
            const detected = { look: 'gnome' as const, name: 'GNOME' };
            expect(resolveEffectiveLook('auto', detected)).toBe('gnome');
            expect(resolveEffectiveLook('kde', detected)).toBe('kde');
            expect(resolveEffectiveLook('default', detected)).toBe('default');
        });
    });
});
