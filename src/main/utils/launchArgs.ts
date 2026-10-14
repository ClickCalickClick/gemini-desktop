/**
 * Launch Arguments
 *
 * Reads the app's own command-line flags. The desktop entries on Linux start the app with
 * `--quick-chat` (the "Gemini Quick Chat" launcher and the main entry's "Quick Chat" action),
 * and autostart uses `--hidden`.
 *
 * @module launchArgs
 */

/** Opens Quick Chat: at startup, or in the running app when a second instance is started with it */
export const QUICK_CHAT_FLAG = '--quick-chat';

/** Starts the app in the background, with the main window hidden */
export const HIDDEN_FLAG = '--hidden';

/**
 * Data a starting instance hands the running one through `app.requestSingleInstanceLock()`.
 * Electron passes the second instance's argv too, but Chromium may reorder or drop switches,
 * so the flag travels in both.
 */
export interface SingleInstanceData {
    quickChat?: boolean;
}

/** What the command line asks the app to do at startup */
export interface LaunchOptions {
    /** Create the main window hidden instead of showing it */
    startHidden: boolean;
    /** Show Quick Chat once the app is ready */
    openQuickChat: boolean;
}

/**
 * Whether a command line contains a flag. Arguments after a bare `--` are not switches.
 *
 * @param argv - The command line, as in `process.argv`
 * @param flag - The flag to look for, such as `--quick-chat`
 */
export function hasFlag(argv: readonly string[], flag: string): boolean {
    for (const arg of argv) {
        if (arg === '--') {
            return false;
        }
        if (arg === flag) {
            return true;
        }
    }
    return false;
}

/**
 * Whether a starting or second instance asks for Quick Chat.
 *
 * @param argv - The instance's command line
 * @param additionalData - The data it passed to `requestSingleInstanceLock()`, if any
 */
export function wantsQuickChat(argv: readonly string[], additionalData?: unknown): boolean {
    if (hasFlag(argv, QUICK_CHAT_FLAG)) {
        return true;
    }
    return (
        typeof additionalData === 'object' &&
        additionalData !== null &&
        (additionalData as SingleInstanceData).quickChat === true
    );
}

/**
 * Work out the startup options from the app's own command line.
 *
 * `--quick-chat` starts the app in the background like `--hidden` and shows Quick Chat: the main
 * window is still created, hidden, because sending a Quick Chat prompt types it into the main
 * window's Gemini tab, and that flow brings the main window forward itself.
 *
 * @param argv - The command line, as in `process.argv`
 */
export function parseLaunchOptions(argv: readonly string[]): LaunchOptions {
    const openQuickChat = wantsQuickChat(argv);
    return {
        startHidden: openQuickChat || hasFlag(argv, HIDDEN_FLAG),
        openQuickChat,
    };
}
