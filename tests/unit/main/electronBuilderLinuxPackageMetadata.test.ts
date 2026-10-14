import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type TargetConfig = string | { target: string; arch?: string[] };

type DesktopConfig = {
    entry?: Record<string, string>;
    desktopActions?: Record<string, Record<string, string>>;
};

type ElectronBuilderConfig = {
    linux?: {
        target?: TargetConfig[];
        executableName?: string;
        synopsis?: string;
        maintainer?: string;
        desktop?: DesktopConfig;
    };
    appImage?: {
        desktop?: DesktopConfig;
    };
    deb?: {
        depends?: string[];
        recommends?: string[];
        fpm?: string[];
    };
    rpm?: {
        depends?: string[];
        fpm?: string[];
    };
    pacman?: {
        depends?: string[];
        fpm?: string[];
    };
    toolsets?: {
        appimage?: string | null;
    };
    publish?: {
        provider?: string;
        owner?: string;
        repo?: string;
    };
};

type PackageJson = {
    license?: string;
    homepage?: string;
    repository?: {
        url?: string;
    };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const builderConfig = require(path.join(repoRoot, 'config/electron-builder.config.cjs')) as ElectronBuilderConfig;
const packageJson = require(path.join(repoRoot, 'package.json')) as PackageJson;

function getTarget(name: string): TargetConfig | undefined {
    return builderConfig.linux?.target?.find(
        (target) => (typeof target === 'string' ? target : target.target) === name
    );
}

describe('electron-builder Linux package metadata', () => {
    it('does not hard-depend on deprecated Debian packages', () => {
        expect(builderConfig.deb?.depends).toEqual(
            expect.arrayContaining(['libnotify4', 'libxtst6', 'libnss3', 'libasound2'])
        );
        expect(builderConfig.deb?.depends).not.toEqual(expect.arrayContaining(['gconf2']));
        expect(builderConfig.deb?.depends).not.toEqual(expect.arrayContaining(['gconf-service']));
        expect(builderConfig.deb?.depends).not.toEqual(expect.arrayContaining(['libappindicator1']));
    });

    it('recommends modern Ayatana AppIndicator support for tray integration', () => {
        expect(builderConfig.deb?.recommends).toEqual(expect.arrayContaining(['libayatana-appindicator3-1']));
    });

    it('keeps the runtime libraries from electron-builder defaults in the deb and rpm lists', () => {
        // A custom depends list replaces the defaults, so dropping one here breaks launches on minimal systems.
        expect(builderConfig.deb?.depends).toEqual(
            expect.arrayContaining(['libgtk-3-0', 'xdg-utils', 'libatspi2.0-0', 'libsecret-1-0'])
        );
        expect(builderConfig.rpm?.depends).toEqual(
            expect.arrayContaining(['gtk3', 'nss', 'xdg-utils', 'at-spi2-core', 'alsa-lib'])
        );
        expect(builderConfig.rpm?.depends).not.toEqual(expect.arrayContaining(['libappindicator']));
    });

    it('builds an x64 pacman package with explicit Arch dependencies', () => {
        expect(getTarget('pacman')).toEqual({ target: 'pacman', arch: ['x64'] });
        expect(builderConfig.pacman?.depends).toEqual(
            expect.arrayContaining(['gtk3', 'nss', 'nspr', 'alsa-lib', 'libnotify', 'libsecret', 'mesa'])
        );
        for (const unwanted of ['ffmpeg', 'http-parser', 'libappindicator-gtk3']) {
            expect(builderConfig.pacman?.depends).not.toContain(unwanted);
        }
    });

    it('builds the AppImage with the type2 runtime, which needs fuse3 instead of fuse2', () => {
        // Without a toolset, or with 0.0.0, electron-builder uses the legacy runtime that loads libfuse.so.2.
        expect(getTarget('AppImage')).toEqual({ target: 'AppImage', arch: ['x64'] });
        expect(builderConfig.toolsets?.appimage).toBeTruthy();
        expect(builderConfig.toolsets?.appimage).not.toBe('0.0.0');
    });

    it('sets the desktop entry window class to gemini-desktop, the wmClass the Linux adapters use', () => {
        expect(builderConfig.linux?.executableName).toBe('gemini-desktop');
        expect(builderConfig.linux?.desktop?.entry?.StartupWMClass).toBe('gemini-desktop');
    });

    it('adds a Quick Chat action to the main desktop entry (H7)', () => {
        for (const desktop of [builderConfig.linux?.desktop, builderConfig.appImage?.desktop]) {
            expect(desktop?.entry?.Actions).toBe('QuickChat;');
            expect(desktop?.entry?.StartupWMClass).toBe('gemini-desktop');
            expect(desktop?.desktopActions?.QuickChat?.Name).toBe('Quick Chat');
            expect(desktop?.desktopActions?.QuickChat?.Exec).toMatch(/ --quick-chat$/);
        }
        expect(builderConfig.linux?.desktop?.desktopActions?.QuickChat?.Exec).toBe(
            '"/opt/Gemini Desktop/gemini-desktop" --quick-chat'
        );
        expect(builderConfig.appImage?.desktop?.desktopActions?.QuickChat?.Exec).toMatch(/^AppRun /);
    });

    it('installs the Gemini Quick Chat launcher with the deb, rpm and pacman packages (H7)', () => {
        // electron-builder's schema rejects `fpm` under `linux`, so each fpm target carries it
        const [debFpm, rpmFpm, pacmanFpm] = [builderConfig.deb?.fpm, builderConfig.rpm?.fpm, builderConfig.pacman?.fpm];
        expect(rpmFpm).toEqual(debFpm);
        expect(pacmanFpm).toEqual(debFpm);
        expect((builderConfig.linux as Record<string, unknown> | undefined)?.fpm).toBeUndefined();

        const mapping = (debFpm ?? []).find((arg) =>
            arg.endsWith('=/usr/share/applications/gemini-desktop-quick-chat.desktop')
        );
        expect(mapping).toBeDefined();

        const source = mapping!.slice(0, mapping!.lastIndexOf('='));
        expect(path.isAbsolute(source)).toBe(true);
        expect(source).toBe(path.join(repoRoot, 'build/linux/gemini-desktop-quick-chat.desktop'));

        const lines = readFileSync(source, 'utf8').split('\n');
        expect(lines[0]).toBe('[Desktop Entry]');
        expect(lines).toEqual(
            expect.arrayContaining([
                'Type=Application',
                'Name=Gemini Quick Chat',
                'Exec="/opt/Gemini Desktop/gemini-desktop" --quick-chat',
                'Icon=gemini-desktop-quick-chat',
                'StartupNotify=false',
            ])
        );
        // Its windows belong to the main app: a StartupWMClass here would take them from the main entry.
        expect(lines.some((line) => line.startsWith('StartupWMClass='))).toBe(false);
        // The same path the main entry's action starts
        expect(lines).toContain(`Exec=${builderConfig.linux?.desktop?.desktopActions?.QuickChat?.Exec}`);
    });

    it('installs its own icon for the Gemini Quick Chat launcher, so the app grid tells it apart', () => {
        const mapping = (builderConfig.deb?.fpm ?? []).find((arg) =>
            arg.endsWith('=/usr/share/icons/hicolor/512x512/apps/gemini-desktop-quick-chat.png')
        );
        expect(mapping).toBeDefined();

        const source = mapping!.slice(0, mapping!.lastIndexOf('='));
        expect(source).toBe(path.join(repoRoot, 'build/icon-quick-chat.png'));
        const png = readFileSync(source);
        // PNG signature, then the IHDR width and height: hicolor's 512x512 folder needs a 512 px icon
        expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
        expect(png.readUInt32BE(16)).toBe(512);
        expect(png.readUInt32BE(20)).toBe(512);
        expect(readFileSync(path.join(repoRoot, 'build/icon-quick-chat.png'))).not.toEqual(
            readFileSync(path.join(repoRoot, 'build/icon.png'))
        );
    });

    it('declares the metadata fpm needs instead of reading it from .git', () => {
        expect(packageJson.license).toBe('MIT');
        expect(packageJson.homepage).toMatch(/^https:\/\//);
        expect(builderConfig.linux?.maintainer).toMatch(/^.+ <.+@.+>$/);
        expect(builderConfig.linux?.synopsis).toBeTruthy();
    });

    it('points update metadata at the repository named in package.json', () => {
        const { provider, owner, repo } = builderConfig.publish ?? {};

        expect(provider).toBe('github');
        expect(owner).toBeTruthy();
        expect(repo).toBeTruthy();
        expect(packageJson.homepage).toBe(`https://github.com/${owner}/${repo}`);
        expect(packageJson.repository?.url).toBe(`git+https://github.com/${owner}/${repo}.git`);
    });
});
