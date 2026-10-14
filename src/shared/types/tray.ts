/**
 * Tray Types
 *
 * What clicking the tray icon opens. On GNOME (AppIndicator extension) a single
 * click shows the tray menu and a double click sends `Activate`, which Electron
 * reports as the Tray `click` event; other desktops send it on a single click.
 */

/** What the tray icon's click opens: Quick Chat or the main window. */
export type TrayClickAction = 'quickChat' | 'mainWindow';

/** Every tray click action, in the order Options lists them. */
export const TRAY_CLICK_ACTIONS: readonly TrayClickAction[] = ['quickChat', 'mainWindow'];

/** The tray click action when none is saved. */
export const DEFAULT_TRAY_CLICK_ACTION: TrayClickAction = 'quickChat';

/** Whether a value is a valid tray click action. */
export function isTrayClickAction(value: unknown): value is TrayClickAction {
    return typeof value === 'string' && (TRAY_CLICK_ACTIONS as readonly string[]).includes(value);
}
