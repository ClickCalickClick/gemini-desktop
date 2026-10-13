/**
 * Update Types
 *
 * Shared types for auto-update functionality across main and renderer processes.
 */

/**
 * A Linux package format whose installs belong to the system package manager.
 */
export type LinuxPackageType = 'deb' | 'rpm' | 'pacman';

/**
 * Update information from electron-updater.
 * Simplified version for use in both main and renderer processes.
 */
export interface UpdateInfo {
    /** The version of the update */
    version: string;
    /** Release name */
    releaseName?: string;
    /** Release notes (may be HTML or markdown) */
    releaseNotes?: string | Array<{ version: string; note: string }>;
    /** Release date */
    releaseDate?: string;
    /**
     * Set on a manual-update notice when the app was installed from a deb, rpm or pacman package,
     * so the notice can say to install the new package with the package manager.
     */
    packageType?: LinuxPackageType;
}

/**
 * Download progress information.
 */
export interface DownloadProgress {
    /** Percentage of download completed (0-100) */
    percent: number;
    /** Download speed in bytes per second */
    bytesPerSecond?: number;
    /** Bytes transferred so far */
    transferred?: number;
    /** Total bytes to download */
    total?: number;
}
