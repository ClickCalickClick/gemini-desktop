/**
 * Accent color helpers for desktop looks.
 *
 * The desktop accent arrives at runtime (GNOME's yellow, KDE's custom colors...), so the text
 * drawn on it is checked by WCAG contrast instead of always being white.
 *
 * @module accentColor
 */

/** Accent colors are only applied in these forms, so nothing else reaches the stylesheet. */
export const SAFE_ACCENT_COLOR =
    /^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\))$/i;

/** Check that a value is an accent color in one of the accepted forms. */
export function isSafeAccentColor(value: string): boolean {
    return SAFE_ACCENT_COLOR.test(value.trim());
}

/**
 * Parse an accepted accent color to 0..255 RGB channels (alpha is ignored).
 * @returns The channels, or null when the value is not an accepted color
 */
export function parseAccentColor(value: string): [number, number, number] | null {
    const color = value.trim();
    if (!isSafeAccentColor(color)) {
        return null;
    }
    if (color.startsWith('#')) {
        const hex = color.slice(1);
        const short = hex.length <= 4;
        const channel = (index: number): number =>
            short ? parseInt(hex.charAt(index).repeat(2), 16) : parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        return [channel(0), channel(1), channel(2)];
    }
    const parts = color
        .slice(color.indexOf('(') + 1, color.indexOf(')'))
        .split(',')
        .map((part) => part.trim());
    const toChannel = (part: string): number => {
        const number = parseFloat(part);
        const scaled = part.endsWith('%') ? (number / 100) * 255 : number;
        return Math.min(255, Math.max(0, scaled));
    };
    return [toChannel(parts[0] ?? '0'), toChannel(parts[1] ?? '0'), toChannel(parts[2] ?? '0')];
}

/** WCAG relative luminance of 0..255 RGB channels. */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
    const linear = (channel: number): number => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Below this WCAG contrast with white, text on the accent turns black (3:1, the minimum for UI parts and large text). */
export const MIN_WHITE_TEXT_CONTRAST = 3;

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a: number, b: number): number {
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Pick black or white text for an accent background.
 *
 * Desktops draw white text on their accents (libadwaita, Breeze), so white stays while it keeps at
 * least 3:1 WCAG contrast. For light accents (GNOME's yellow gives white about 2.2:1) black is used,
 * and only when black actually contrasts more.
 *
 * @returns '#000000' or '#ffffff', or null when the color cannot be parsed
 */
export function getAccentForeground(accent: string): '#000000' | '#ffffff' | null {
    const rgb = parseAccentColor(accent);
    if (!rgb) {
        return null;
    }
    const luminance = relativeLuminance(rgb);
    const withWhite = contrastRatio(luminance, 1);
    const withBlack = contrastRatio(luminance, 0);
    return withWhite < MIN_WHITE_TEXT_CONTRAST && withBlack > withWhite ? '#000000' : '#ffffff';
}
