/**
 * Unit tests for quickChatLauncher, which writes the Gemini Quick Chat launcher for AppImage and
 * tar.gz installs. Uses a temporary home and resources directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildQuickChatDesktopEntry,
    ensureQuickChatLauncher,
    GENERATED_MARKER,
    NO_LAUNCHER_ENV,
    QUICK_CHAT_DESKTOP_FILE,
    QUICK_CHAT_ICON_FILE,
    QUICK_CHAT_SOURCE_ICON,
    quoteDesktopExecArg,
} from '../../../../src/main/utils/quickChatLauncher';

vi.mock('../../../../src/main/utils/logger');

describe('quoteDesktopExecArg', () => {
    it('leaves plain paths alone', () => {
        expect(quoteDesktopExecArg('/home/jared/Apps/Gemini-Desktop-0.13.0-x86_64.AppImage')).toBe(
            '/home/jared/Apps/Gemini-Desktop-0.13.0-x86_64.AppImage'
        );
    });

    it('quotes paths with spaces', () => {
        expect(quoteDesktopExecArg('/opt/Gemini Desktop/gemini-desktop')).toBe('"/opt/Gemini Desktop/gemini-desktop"');
    });

    it('escapes reserved characters inside quotes, then doubles backslashes for the string value', () => {
        // Exec arg: "/a b/$x`\"" → each of $ ` " gets a backslash, and backslashes are written twice
        expect(quoteDesktopExecArg('/a b/$x`"')).toBe('"/a b/\\\\$x\\\\`\\\\""');
    });

    it('doubles percent signs, which start field codes', () => {
        expect(quoteDesktopExecArg('/apps/100%/app')).toBe('/apps/100%%/app');
    });
});

describe('buildQuickChatDesktopEntry', () => {
    it('starts the app with --quick-chat and no startup notification', () => {
        const lines = buildQuickChatDesktopEntry('/apps/Gemini Desktop.AppImage', '/icons/q.png').split('\n');

        expect(lines[0]).toBe('[Desktop Entry]');
        expect(lines).toContain('Name=Gemini Quick Chat');
        expect(lines).toContain('Exec="/apps/Gemini Desktop.AppImage" --quick-chat');
        expect(lines).toContain('Icon=/icons/q.png');
        expect(lines).toContain('StartupNotify=false');
        expect(lines).toContain(GENERATED_MARKER);
        expect(lines.some((line) => line.startsWith('StartupWMClass='))).toBe(false);
    });
});

describe('ensureQuickChatLauncher', () => {
    let root: string;
    let homeDir: string;
    let resourcesPath: string;
    let desktopFile: string;
    let iconFile: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-chat-launcher-'));
        homeDir = path.join(root, 'home');
        resourcesPath = path.join(root, 'app', 'resources');
        fs.mkdirSync(homeDir, { recursive: true });
        fs.mkdirSync(resourcesPath, { recursive: true });
        fs.writeFileSync(path.join(resourcesPath, 'icon.png'), 'app png');
        fs.writeFileSync(path.join(resourcesPath, QUICK_CHAT_SOURCE_ICON), 'png');
        desktopFile = path.join(homeDir, '.local', 'share', 'applications', QUICK_CHAT_DESKTOP_FILE);
        iconFile = path.join(homeDir, '.local', 'share', 'icons', QUICK_CHAT_ICON_FILE);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function run(overrides: { env?: NodeJS.ProcessEnv; isPackaged?: boolean; platform?: NodeJS.Platform } = {}) {
        return ensureQuickChatLauncher({
            isPackaged: overrides.isPackaged ?? true,
            platform: overrides.platform ?? 'linux',
            env: overrides.env ?? {},
            homeDir,
            resourcesPath,
        });
    }

    it('does nothing in development runs or on other platforms', async () => {
        expect(await run({ isPackaged: false })).toBe('skipped');
        expect(await run({ platform: 'darwin' })).toBe('skipped');
        expect(await run({ platform: 'win32' })).toBe('skipped');
        expect(fs.existsSync(desktopFile)).toBe(false);
    });

    it('writes a launcher for the AppImage file, with a copy of its own icon', async () => {
        const appImage = path.join(root, 'Apps', 'Gemini Desktop.AppImage');

        expect(await run({ env: { APPIMAGE: appImage } })).toBe('written');

        const content = fs.readFileSync(desktopFile, 'utf8');
        expect(content).toContain(`Exec="${appImage}" --quick-chat\n`);
        expect(content).toContain(`Icon=${iconFile}\n`);
        expect(fs.readFileSync(iconFile, 'utf8')).toBe('png');
    });

    it('writes nothing for a tar.gz or release/linux-unpacked run, which has no $APPIMAGE', async () => {
        expect(await run()).toBe('skipped');
        expect(fs.existsSync(desktopFile)).toBe(false);
        expect(fs.existsSync(iconFile)).toBe(false);
    });

    it('leaves a launcher an AppImage wrote alone in a tar.gz or unpacked run', async () => {
        await run({ env: { APPIMAGE: '/a/App.AppImage' } });

        expect(await run()).toBe('skipped');
        expect(fs.readFileSync(desktopFile, 'utf8')).toContain('Exec=/a/App.AppImage --quick-chat');
    });

    it('does nothing at all with GEMINI_DESKTOP_NO_LAUNCHER=1 (test runs)', async () => {
        expect(await run({ env: { APPIMAGE: '/a/App.AppImage', [NO_LAUNCHER_ENV]: '1' } })).toBe('skipped');
        expect(fs.existsSync(desktopFile)).toBe(false);

        await run({ env: { APPIMAGE: '/a/App.AppImage' } });
        fs.writeFileSync(path.join(resourcesPath, 'package-type'), 'pacman');
        expect(await run({ env: { [NO_LAUNCHER_ENV]: '1' } })).toBe('skipped');
        expect(fs.existsSync(desktopFile)).toBe(true);
    });

    it('follows XDG_DATA_HOME', async () => {
        const dataHome = path.join(root, 'data');

        expect(await run({ env: { XDG_DATA_HOME: dataHome, APPIMAGE: '/a/App.AppImage' } })).toBe('written');
        expect(fs.existsSync(path.join(dataHome, 'applications', QUICK_CHAT_DESKTOP_FILE))).toBe(true);
    });

    it('leaves an up-to-date launcher alone and updates one that moved', async () => {
        await run({ env: { APPIMAGE: '/a/Old.AppImage' } });
        expect(await run({ env: { APPIMAGE: '/a/Old.AppImage' } })).toBe('unchanged');

        expect(await run({ env: { APPIMAGE: '/a/New.AppImage' } })).toBe('written');
        expect(fs.readFileSync(desktopFile, 'utf8')).toContain('Exec=/a/New.AppImage --quick-chat');
    });

    it('never overwrites a launcher the user wrote at the same path', async () => {
        fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
        fs.writeFileSync(desktopFile, '[Desktop Entry]\nName=Mine\n');

        expect(await run({ env: { APPIMAGE: '/a/App.AppImage' } })).toBe('kept-user-file');
        expect(fs.readFileSync(desktopFile, 'utf8')).toBe('[Desktop Entry]\nName=Mine\n');
    });

    it('in a deb, rpm or pacman install, removes the launcher it wrote earlier but nothing else', async () => {
        await run({ env: { APPIMAGE: '/a/App.AppImage' } });
        fs.writeFileSync(path.join(resourcesPath, 'package-type'), 'pacman');

        expect(await run()).toBe('removed');
        expect(fs.existsSync(desktopFile)).toBe(false);
        expect(fs.existsSync(iconFile)).toBe(false);

        fs.writeFileSync(desktopFile, '[Desktop Entry]\nName=Mine\n');
        expect(await run()).toBe('package-ships-launcher');
        expect(fs.existsSync(desktopFile)).toBe(true);
    });
});
