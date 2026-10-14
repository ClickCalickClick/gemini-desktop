/**
 * Window control layout per desktop look.
 *
 * Where the app draws its own titlebar (Windows and Linux), the window controls follow the
 * desktop the look imitates: which buttons show and on which side.
 *
 * @module windowControlsLayout
 */

import type { DesktopLook } from '../../shared/types/look';

/** A window control button. */
export type WindowControlKind = 'minimize' | 'maximize' | 'close';

/** Buttons on each side of the titlebar, in the order they appear. */
export interface WindowControlsLayout {
    left: WindowControlKind[];
    right: WindowControlKind[];
}

const RIGHT_ALL: WindowControlsLayout = { left: [], right: ['minimize', 'maximize', 'close'] };

const LAYOUTS: Partial<Record<DesktopLook, WindowControlsLayout>> = {
    // GNOME's default button layout is 'appmenu:close'
    gnome: { left: [], right: ['close'] },
    // elementary OS: close on the left, maximize on the right
    elementary: { left: ['close'], right: ['maximize'] },
    // macOS traffic lights: close, minimize, zoom on the left
    macos: { left: ['close', 'minimize', 'maximize'], right: [] },
};

/**
 * Get the window control layout for a look. Looks without their own layout (default, KDE,
 * Windows, Xfce, Cinnamon, MATE, Budgie, COSMIC) keep minimize, maximize and close on the right.
 */
export function getWindowControlsLayout(look: DesktopLook): WindowControlsLayout {
    return LAYOUTS[look] ?? RIGHT_ALL;
}
