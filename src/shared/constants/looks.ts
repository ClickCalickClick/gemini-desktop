/**
 * Desktop look constants.
 *
 * The one list of looks and their display names, shared by the main process (detection and
 * validation) and the renderer (LookContext and the Options look selector).
 *
 * @module looks
 */

import type { DesktopLook, DesktopLookPreference } from '../types/look';

/** Every look the user can pick, in the order Options lists them. */
export const DESKTOP_LOOKS: readonly DesktopLook[] = [
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
];

/** Display name of each look. For every look but 'default' this is also the desktop's name. */
export const DESKTOP_LOOK_NAMES: Readonly<Record<DesktopLook, string>> = {
    default: 'Default',
    gnome: 'GNOME',
    kde: 'KDE Plasma',
    xfce: 'Xfce',
    cinnamon: 'Cinnamon',
    mate: 'MATE',
    budgie: 'Budgie',
    elementary: 'elementary OS',
    cosmic: 'COSMIC',
    macos: 'macOS',
    windows: 'Windows',
};

/** Check that a value is a look. */
export function isDesktopLook(value: unknown): value is DesktopLook {
    return typeof value === 'string' && (DESKTOP_LOOKS as readonly string[]).includes(value);
}

/** Check that a value is a look preference ('auto' or a look). */
export function isDesktopLookPreference(value: unknown): value is DesktopLookPreference {
    return value === 'auto' || isDesktopLook(value);
}
