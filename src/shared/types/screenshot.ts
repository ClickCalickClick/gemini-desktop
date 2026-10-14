/**
 * Screenshots attached to a Quick Chat prompt (H10).
 *
 * The main process takes the screenshot and keeps the image; the renderer only gets a small
 * preview and an id, and passes the id back with the prompt.
 *
 * @module shared/types/screenshot
 */

/**
 * `screen`: the whole screen (the one under the pointer; the main display on macOS; GNOME's portal
 * decides on Wayland). `area`: let the user pick an area or window first (whole screen on Windows).
 */
export type ScreenshotMode = 'screen' | 'area';

/** What Quick Chat shows for an attached screenshot. */
export interface ScreenshotPreview {
    /** Pass it with the prompt (submitQuickChat or runAgent) to attach the screenshot. */
    id: string;
    width: number;
    height: number;
    /** A small PNG data URL for the thumbnail. */
    thumbnailDataUrl: string;
}

export type ScreenshotCaptureResult =
    | { status: 'captured'; preview: ScreenshotPreview }
    /** The user closed the desktop's screenshot dialog or picker. */
    | { status: 'cancelled' }
    | { status: 'error'; error: string };

/** Extra data sent with a Quick Chat prompt for a Gemini tab. */
export interface QuickChatSubmitOptions {
    screenshotId?: string;
}

/** Ids from the main process are UUIDs. */
export const SCREENSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
