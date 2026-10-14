/**
 * Unit tests for packageType.
 *
 * Writes `package-type` files into a temporary resources directory, as electron-builder does for
 * the deb, rpm and pacman packages.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getLinuxPackageType } from '../../../../src/main/utils/packageType';

describe('getLinuxPackageType', () => {
    let resourcesPath: string;

    beforeEach(() => {
        resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'package-type-'));
    });

    afterEach(() => {
        fs.rmSync(resourcesPath, { recursive: true, force: true });
    });

    it.each(['deb', 'rpm', 'pacman'] as const)('returns %s for a %s package', (packageType) => {
        fs.writeFileSync(path.join(resourcesPath, 'package-type'), packageType);

        expect(getLinuxPackageType(resourcesPath)).toBe(packageType);
    });

    it('ignores surrounding whitespace', () => {
        fs.writeFileSync(path.join(resourcesPath, 'package-type'), 'pacman\n');

        expect(getLinuxPackageType(resourcesPath)).toBe('pacman');
    });

    it('returns null without a package-type file (AppImage, tar.gz, macOS, Windows)', () => {
        expect(getLinuxPackageType(resourcesPath)).toBeNull();
    });

    it('returns null for a format no package manager owns', () => {
        fs.writeFileSync(path.join(resourcesPath, 'package-type'), 'AppImage');

        expect(getLinuxPackageType(resourcesPath)).toBeNull();
    });

    it('returns null outside Electron, where process.resourcesPath is undefined', () => {
        expect(getLinuxPackageType()).toBeNull();
    });
});
