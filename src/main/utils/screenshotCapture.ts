/**
 * Take a screenshot for Quick Chat (H10).
 *
 * - Linux on Wayland: the desktop portal's Screenshot interface. GNOME and KDE ask once whether
 *   the app may take screenshots; the `area` mode opens the desktop's own screenshot tool, where
 *   the user picks an area, a window or the screen. The portal saves the image as a file (GNOME
 *   puts it in the Pictures folder); it is read and deleted again.
 * - Linux on X11: Electron's desktopCapturer for the whole screen; `area` uses the portal when
 *   there is one.
 * - macOS: the system's `screencapture` tool (`-i` lets the user pick an area or a window). The
 *   app needs the Screen Recording permission.
 * - Windows: desktopCapturer; `area` takes the whole screen.
 *
 * Never logs image data or file names; only sizes and statuses.
 *
 * @module screenshotCapture
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { desktopCapturer, screen, systemPreferences } from 'electron';

import {
    connectSessionBus,
    PORTAL_BUS_NAME,
    PORTAL_OBJECT_PATH,
    registerAppId,
    waitForPortalResponse,
} from './dbusFallback';
import { isWayland } from './constants';
import { createLogger } from './logger';
import type { ScreenshotMode } from '../../shared/types/screenshot';

const logger = createLogger('[ScreenshotCapture]');

/** The user may spend a while in the desktop's screenshot tool or permission dialog. */
const PORTAL_TIMEOUT_MS = 3 * 60 * 1000;
/** A file the portal returned is only deleted when it was written this recently. */
const FRESH_FILE_MS = 5 * 60 * 1000;
const SCREENCAPTURE_PATH = '/usr/sbin/screencapture';
export const MAC_PERMISSION_MESSAGE =
    'Gemini Desktop may not record the screen yet. Allow it in System Settings > Privacy & Security > Screen & System Audio Recording (macOS may ask you to reopen the app), then try again.';

export type CaptureOutcome = { status: 'captured'; png: Buffer } | { status: 'cancelled' };

/** Thrown with a message fit for Quick Chat. */
export class ScreenshotError extends Error {}

/**
 * The portal refused (Response code 2). On GNOME this is also what a first screenshot gets while
 * none of the app's windows has focus: the portal may only ask "allow screenshots?" for the focused
 * app, so it refuses without asking. ScreenshotManager then asks again with Quick Chat focused.
 */
export class PortalDeniedError extends ScreenshotError {
    constructor() {
        super('The desktop did not allow the screenshot.');
        this.name = 'PortalDeniedError';
    }
}

export interface CaptureDeps {
    platform: NodeJS.Platform;
    wayland: boolean;
    viaPortal: (interactive: boolean) => Promise<CaptureOutcome>;
    viaDesktopCapturer: () => Promise<CaptureOutcome>;
    viaScreencapture: (interactive: boolean) => Promise<CaptureOutcome>;
}

const defaultDeps: CaptureDeps = {
    platform: process.platform,
    wayland: isWayland,
    viaPortal: (interactive) => captureViaPortal(interactive),
    viaDesktopCapturer: () => captureViaDesktopCapturer(),
    viaScreencapture: (interactive) => captureViaScreencapture(interactive),
};

/** Take a screenshot. Resolves `cancelled` when the user closed the desktop's dialog. */
export async function captureScreenshot(
    mode: ScreenshotMode,
    deps: Partial<CaptureDeps> = {}
): Promise<CaptureOutcome> {
    const d = { ...defaultDeps, ...deps };
    const interactive = mode === 'area';

    if (d.platform === 'darwin') {
        return d.viaScreencapture(interactive);
    }
    if (d.platform === 'linux' && (d.wayland || interactive)) {
        try {
            return await d.viaPortal(interactive);
        } catch (error) {
            if (error instanceof ScreenshotError) {
                throw error;
            }
            // No portal, or no Screenshot interface: Electron's capturer still works on X11, and
            // on Wayland it goes through the ScreenCast portal's picker.
            logger.warn('Screenshot portal failed, using desktopCapturer:', (error as Error)?.message);
        }
    }
    return d.viaDesktopCapturer();
}

// =============================================================================
// Desktop portal (Linux)
// =============================================================================

interface ScreenshotPortalInterface {
    Screenshot?: (parentWindow: string, options: Record<string, unknown>) => Promise<unknown>;
}

/** Portal Response codes: 0 success, 1 cancelled by the user, 2 other failure. */
export function portalOutcome(
    code: number,
    results: Record<string, { value?: unknown }>
): { status: 'captured'; uri: string } | { status: 'cancelled' } {
    if (code === 1) {
        return { status: 'cancelled' };
    }
    if (code !== 0) {
        throw new PortalDeniedError();
    }
    const uri = results.uri?.value;
    if (typeof uri !== 'string' || !uri.startsWith('file://')) {
        throw new ScreenshotError('The desktop did not return a screenshot.');
    }
    return { status: 'captured', uri };
}

export async function captureViaPortal(interactive: boolean): Promise<CaptureOutcome> {
    const dbusNext = await import('dbus-next');
    const bus = connectSessionBus(dbusNext);
    try {
        await registerAppId(bus, dbusNext);
        const proxy = await bus.getProxyObject(PORTAL_BUS_NAME, PORTAL_OBJECT_PATH);
        const portal = proxy.getInterface('org.freedesktop.portal.Screenshot') as unknown as ScreenshotPortalInterface;
        if (!portal?.Screenshot) {
            throw new Error('The portal has no Screenshot interface');
        }
        const sender = bus.name?.replace(/^:/, '').replace(/\./g, '_');
        if (!sender) {
            throw new Error('No D-Bus sender name');
        }
        const token = `gemini_screenshot_${randomUUID().replace(/-/g, '')}`;
        const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
        // Listen before calling: the Response can arrive before the call returns.
        const response = waitForPortalResponse(bus, requestPath, PORTAL_TIMEOUT_MS);
        response.catch(() => {});
        await portal.Screenshot('', {
            handle_token: new dbusNext.Variant('s', token),
            interactive: new dbusNext.Variant('b', interactive),
            modal: new dbusNext.Variant('b', true),
        });
        const { code, results } = await response;
        const outcome = portalOutcome(code, results);
        if (outcome.status === 'cancelled') {
            logger.log('Screenshot cancelled in the desktop dialog');
            return outcome;
        }
        const file = fileURLToPath(outcome.uri);
        const png = await fs.readFile(file);
        await removeIfFresh(file);
        logger.log('Screenshot taken through the portal:', { bytes: png.length, interactive });
        return { status: 'captured', png };
    } finally {
        try {
            bus.disconnect();
        } catch {
            // already closed
        }
    }
}

/** Delete the file the portal saved for this request (GNOME saves it in Pictures). */
async function removeIfFresh(file: string): Promise<void> {
    try {
        const stat = await fs.stat(file);
        if (stat.isFile() && Date.now() - stat.mtimeMs < FRESH_FILE_MS) {
            await fs.unlink(file);
        }
    } catch (error) {
        logger.warn('Could not remove the portal screenshot file:', (error as NodeJS.ErrnoException)?.code);
    }
}

// =============================================================================
// desktopCapturer (Windows, Linux X11, fallback)
// =============================================================================

export async function captureViaDesktopCapturer(): Promise<CaptureOutcome> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const thumbnailSize = {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
    if (!source) {
        // The Wayland picker returns no source when the user closes it.
        return { status: 'cancelled' };
    }
    if (source.thumbnail.isEmpty()) {
        throw new ScreenshotError('The screenshot came back empty.');
    }
    const png = source.thumbnail.toPNG();
    logger.log('Screenshot taken with desktopCapturer:', { bytes: png.length });
    return { status: 'captured', png };
}

// =============================================================================
// screencapture (macOS)
// =============================================================================

export async function captureViaScreencapture(interactive: boolean): Promise<CaptureOutcome> {
    const access = systemPreferences.getMediaAccessStatus('screen');
    if (access !== 'granted') {
        if (access === 'not-determined') {
            // Without the permission screencapture returns only the wallpaper. Asking for screen
            // sources makes macOS show its permission prompt.
            try {
                await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
            } catch {
                // the prompt is what matters
            }
        }
        throw new ScreenshotError(MAC_PERMISSION_MESSAGE);
    }
    const file = path.join(os.tmpdir(), `gemini-desktop-screenshot-${randomUUID()}.png`);
    const args = ['-x', '-t', 'png', ...(interactive ? ['-i'] : []), file];
    const runError = await new Promise<Error | null>((resolve) => {
        execFile(SCREENCAPTURE_PATH, args, { timeout: PORTAL_TIMEOUT_MS }, (error) => resolve(error));
    });
    let png: Buffer;
    try {
        png = await fs.readFile(file);
    } catch {
        if (interactive) {
            // Escape in the picker writes no file.
            return { status: 'cancelled' };
        }
        logger.error('screencapture failed:', runError?.message);
        throw new ScreenshotError('The screenshot could not be taken.');
    }
    await fs.rm(file, { force: true });
    logger.log('Screenshot taken with screencapture:', { bytes: png.length, interactive });
    return { status: 'captured', png };
}
