/**
 * Desktop look detection.
 *
 * Pure helpers that work out which desktop environment the app runs on and which
 * look 'auto' resolves to. Nothing here touches Electron, so the rules are easy to test.
 *
 * @module desktopLook
 */

import type { DesktopLook, DesktopLookPreference } from '../../shared/types/look';

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

/** Display name of the desktop behind each look. */
export const DESKTOP_NAMES: Record<Exclude<DesktopLook, 'default'>, string> = {
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

/** The desktop the app runs on. */
export interface DetectedDesktop {
    /** The look 'auto' resolves to ('default' when the desktop is unknown) */
    look: DesktopLook;
    /** A name to show the user, e.g. 'GNOME', or null when nothing was detected */
    name: string | null;
}

/**
 * Check that a value from the renderer or the settings file is a look preference.
 */
export function isDesktopLookPreference(value: unknown): value is DesktopLookPreference {
    return value === 'auto' || (typeof value === 'string' && (DESKTOP_LOOKS as readonly string[]).includes(value));
}

/**
 * Map one desktop name, as XDG_CURRENT_DESKTOP, DESKTOP_SESSION or XDG_SESSION_DESKTOP spell it,
 * to a look. Returns null for desktops without a look of their own.
 */
export function lookFromDesktopToken(token: string): DesktopLook | null {
    const name = token.trim().toLowerCase().replace(/^x-/, '');
    if (!name) {
        return null;
    }
    // Before the GNOME rule, which also takes 'ubuntu' and the names derived from it
    if (name === 'xubuntu' || name.startsWith('xfce')) return 'xfce';
    if (name === 'mate' || name.startsWith('mate-') || name === 'ubuntu-mate') return 'mate';
    if (name.includes('budgie')) return 'budgie';
    if (name === 'kde' || name.startsWith('plasma') || name === 'kde-plasma' || name === 'kubuntu') return 'kde';
    if (name.startsWith('cinnamon')) return 'cinnamon';
    if (name === 'pantheon' || name === 'elementary') return 'elementary';
    if (name.startsWith('cosmic')) return 'cosmic';
    if (name.startsWith('gnome') || name === 'ubuntu' || name.startsWith('ubuntu-') || name === 'zorin') {
        return 'gnome';
    }
    return null;
}

/**
 * Detect the desktop environment.
 *
 * macOS and Windows map to their own looks. On Linux the colon-separated XDG_CURRENT_DESKTOP list is
 * read first, in order (so 'Budgie:GNOME' is Budgie and 'ubuntu:GNOME' is GNOME), then
 * XDG_SESSION_DESKTOP and DESKTOP_SESSION.
 *
 * @param platform - process.platform
 * @param env - The environment to read
 */
export function detectDesktop(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): DetectedDesktop {
    if (platform === 'darwin') {
        return { look: 'macos', name: DESKTOP_NAMES.macos };
    }
    if (platform === 'win32') {
        return { look: 'windows', name: DESKTOP_NAMES.windows };
    }

    const current = (env.XDG_CURRENT_DESKTOP ?? '')
        .split(':')
        .map((token) => token.trim())
        .filter(Boolean);
    const sessions = [env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION]
        .map((value) => (value ?? '').trim())
        .filter(Boolean)
        // DESKTOP_SESSION can be a path to a session file
        .map((value) => value.split('/').pop() ?? value);

    for (const token of [...current, ...sessions]) {
        const look = lookFromDesktopToken(token);
        if (look) {
            return { look, name: DESKTOP_NAMES[look as Exclude<DesktopLook, 'default'>] };
        }
    }

    const unknownName = current[0] ?? sessions[0] ?? null;
    return { look: 'default', name: unknownName };
}

/**
 * Resolve a preference to the look that is applied.
 */
export function resolveEffectiveLook(preference: DesktopLookPreference, detected: DetectedDesktop): DesktopLook {
    return preference === 'auto' ? detected.look : preference;
}
