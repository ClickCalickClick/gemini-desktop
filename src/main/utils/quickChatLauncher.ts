/**
 * Gemini Quick Chat launcher for AppImage and tar.gz installs
 *
 * The deb, rpm and pacman packages ship `/usr/share/applications/gemini-desktop-quick-chat.desktop`
 * (see `build/linux/` and `linux.fpm` in the electron-builder config). An AppImage or a tar.gz
 * cannot install system files, so the app writes the same launcher to
 * `~/.local/share/applications/` itself, pointing at the AppImage file or the unpacked executable.
 * The user can then pin "Gemini Quick Chat" to the GNOME dash or a dock.
 *
 * Files are marked with `X-Gemini-Desktop-Generated=true`. The app only rewrites or removes a
 * launcher that carries the mark, so a file the user made at that path is left alone.
 *
 * @module quickChatLauncher
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createLogger } from './logger';
import { getLinuxPackageType } from './packageType';

const logger = createLogger('[QuickChatLauncher]');

/** The launcher's desktop file name, the same for packages and user installs */
export const QUICK_CHAT_DESKTOP_FILE = 'gemini-desktop-quick-chat.desktop';

/** The icon the user launcher points at, copied from the app's resources */
export const QUICK_CHAT_ICON_FILE = 'gemini-desktop-quick-chat.png';

/** Marks a launcher the app wrote, so it never touches one the user wrote */
export const GENERATED_MARKER = 'X-Gemini-Desktop-Generated=true';

/**
 * Quote one argument for a desktop entry's Exec key.
 *
 * The desktop entry spec reserves spaces, quotes and shell characters inside arguments, which must
 * be double-quoted with `"`, `` ` ``, `$` and `\` escaped by a backslash; `%` is doubled because it
 * starts a field code. The value is then a desktop entry string, so each backslash is written twice.
 *
 * @see https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html
 */
export function quoteDesktopExecArg(arg: string): string {
    const percentEscaped = arg.replace(/%/g, '%%');
    if (/^[A-Za-z0-9_/.+,:@%=-]+$/.test(percentEscaped)) {
        return percentEscaped;
    }
    const quoted = `"${percentEscaped.replace(/(["`$\\])/g, '\\$1')}"`;
    return quoted.replace(/\\/g, '\\\\');
}

/**
 * Build the user launcher's desktop entry.
 *
 * @param executable - The AppImage file or the app's executable
 * @param icon - An absolute icon path, or an icon theme name
 */
export function buildQuickChatDesktopEntry(executable: string, icon: string): string {
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Gemini Quick Chat',
        'GenericName=Quick Chat',
        'Comment=Ask Gemini from the floating Quick Chat window',
        `Exec=${quoteDesktopExecArg(executable)} --quick-chat`,
        `Icon=${icon}`,
        'Terminal=false',
        // The app shows Quick Chat itself and the launch may only hand over to the running app, so a
        // startup notification would leave a busy cursor until it times out.
        'StartupNotify=false',
        'Categories=Utility;',
        'Keywords=Gemini;AI;Chat;Assistant;Quick;',
        GENERATED_MARKER,
        '',
    ].join('\n');
}

/** Where the app runs from and where it may write; injectable for tests */
export interface QuickChatLauncherEnvironment {
    /** `app.isPackaged`: development and unpackaged test runs never write a launcher */
    isPackaged: boolean;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    resourcesPath?: string;
    execPath?: string;
}

/** What `ensureQuickChatLauncher()` did */
export type QuickChatLauncherResult =
    'skipped' | 'written' | 'unchanged' | 'removed' | 'kept-user-file' | 'kept-package-file';

function getApplicationsDir(env: NodeJS.ProcessEnv, homeDir: string): string {
    const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : null;
    return path.join(dataHome ?? path.join(homeDir, '.local', 'share'), 'applications');
}

async function readFileOrNull(file: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(file, 'utf8');
    } catch {
        return null;
    }
}

/**
 * Create, update or remove the user's Gemini Quick Chat launcher, depending on how the app was installed.
 *
 * - Not Linux, or not packaged: nothing.
 * - deb, rpm or pacman (`resources/package-type`): the package ships the launcher, so a launcher
 *   the app wrote earlier (from an AppImage, say) is removed; it would hide the package's one.
 * - AppImage (`$APPIMAGE`) or tar.gz: write the launcher if it is missing or out of date.
 */
export async function ensureQuickChatLauncher(
    environment: QuickChatLauncherEnvironment
): Promise<QuickChatLauncherResult> {
    const platform = environment.platform ?? process.platform;
    const env = environment.env ?? process.env;
    const homeDir = environment.homeDir ?? os.homedir();
    const resourcesPath = environment.resourcesPath ?? process.resourcesPath;
    const execPath = environment.execPath ?? process.execPath;

    if (platform !== 'linux' || !environment.isPackaged || !homeDir) {
        return 'skipped';
    }

    const applicationsDir = getApplicationsDir(env, homeDir);
    const desktopFile = path.join(applicationsDir, QUICK_CHAT_DESKTOP_FILE);
    const existing = await readFileOrNull(desktopFile);
    const isOurs = existing !== null && existing.split('\n').includes(GENERATED_MARKER);

    if (getLinuxPackageType(resourcesPath)) {
        if (isOurs) {
            await fs.promises.rm(desktopFile, { force: true });
            await fs.promises.rm(path.join(path.dirname(applicationsDir), 'icons', QUICK_CHAT_ICON_FILE), {
                force: true,
            });
            logger.log(`Removed ${desktopFile}: the installed package ships the Quick Chat launcher`);
            return 'removed';
        }
        return 'kept-package-file';
    }

    if (existing !== null && !isOurs) {
        logger.log(`Leaving ${desktopFile} alone: it was not written by the app`);
        return 'kept-user-file';
    }

    const appImage = env.APPIMAGE && path.isAbsolute(env.APPIMAGE) ? env.APPIMAGE : null;
    const executable = appImage ?? execPath;

    // The AppImage is mounted at a new path each run, so its icon is copied somewhere that lasts.
    let icon = 'gemini-desktop';
    const sourceIcon = resourcesPath ? path.join(resourcesPath, 'icon.png') : null;
    if (sourceIcon && fs.existsSync(sourceIcon)) {
        const iconDir = path.join(path.dirname(applicationsDir), 'icons');
        const iconFile = path.join(iconDir, QUICK_CHAT_ICON_FILE);
        const sourceSize = fs.statSync(sourceIcon).size;
        const copiedSize = fs.existsSync(iconFile) ? fs.statSync(iconFile).size : -1;
        if (sourceSize !== copiedSize) {
            await fs.promises.mkdir(iconDir, { recursive: true });
            await fs.promises.copyFile(sourceIcon, iconFile);
        }
        icon = iconFile;
    }

    const content = buildQuickChatDesktopEntry(executable, icon);
    if (existing === content) {
        return 'unchanged';
    }

    await fs.promises.mkdir(applicationsDir, { recursive: true });
    await fs.promises.writeFile(desktopFile, content, { mode: 0o644 });
    logger.log(`Wrote the Gemini Quick Chat launcher to ${desktopFile} (Exec ${executable})`);
    return 'written';
}
