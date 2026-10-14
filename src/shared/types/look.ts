/**
 * Desktop Look Types
 *
 * The app's look (titlebar, window controls, fonts, Quick Chat and Options styling)
 * can follow a desktop environment. This is separate from the light/dark theme,
 * which every look supports.
 */

/** Looks the user can pick in Options. */
export type DesktopLook =
    | 'default'
    | 'gnome'
    | 'kde'
    | 'xfce'
    | 'cinnamon'
    | 'mate'
    | 'budgie'
    | 'elementary'
    | 'cosmic'
    | 'macos'
    | 'windows';

/** Preference: a specific look, or 'auto' to match the desktop the app runs on. */
export type DesktopLookPreference = 'auto' | DesktopLook;

/** Look data returned from the main process. */
export interface LookData {
    preference: DesktopLookPreference;
    /** The look actually applied ('auto' resolved). */
    effectiveLook: DesktopLook;
    /** The desktop detected from the platform and XDG_CURRENT_DESKTOP, e.g. 'GNOME', or null. */
    detectedDesktop: string | null;
    /** The desktop's accent color as a CSS color, when the desktop exposes one; otherwise null. */
    accentColor: string | null;
}
