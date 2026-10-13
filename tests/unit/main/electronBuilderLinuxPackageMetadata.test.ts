import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type TargetConfig = string | { target: string; arch?: string[] };

type ElectronBuilderConfig = {
    linux?: {
        target?: TargetConfig[];
        executableName?: string;
        synopsis?: string;
        maintainer?: string;
        desktop?: {
            entry?: Record<string, string>;
        };
    };
    deb?: {
        depends?: string[];
        recommends?: string[];
    };
    rpm?: {
        depends?: string[];
    };
    pacman?: {
        depends?: string[];
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

    it('sets the desktop entry window class to gemini-desktop, the wmClass the Linux adapters use', () => {
        expect(builderConfig.linux?.executableName).toBe('gemini-desktop');
        expect(builderConfig.linux?.desktop?.entry?.StartupWMClass).toBe('gemini-desktop');
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
