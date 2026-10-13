/**
 * Linux Package Type Detection
 *
 * electron-builder writes `resources/package-type` into the deb, rpm and pacman packages, so
 * electron-updater can pick a matching updater. The app only reads it to word the update notice:
 * those installs stay notify-only because the package manager owns them. Never hand them to
 * electron-updater, whose PacmanUpdater runs `pacman -Sy` (a partial upgrade) when an install fails.
 *
 * @module packageType
 */

import * as fs from 'fs';
import * as path from 'path';

import type { LinuxPackageType } from '../../shared/types/updates';

const LINUX_PACKAGE_TYPES: readonly LinuxPackageType[] = ['deb', 'rpm', 'pacman'];

/**
 * Get the package format this app was installed from.
 *
 * @param resourcesPath - The app's resources directory
 * @returns 'deb', 'rpm' or 'pacman', or null for the AppImage, the tar.gz, macOS, Windows and
 * development runs, which have no `package-type` file
 */
export function getLinuxPackageType(
    resourcesPath: string | undefined = process.resourcesPath
): LinuxPackageType | null {
    if (!resourcesPath) {
        return null;
    }

    try {
        const packageType = fs.readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim();
        return LINUX_PACKAGE_TYPES.find((type) => type === packageType) ?? null;
    } catch {
        return null;
    }
}
