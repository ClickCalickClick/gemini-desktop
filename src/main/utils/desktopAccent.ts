/**
 * Desktop accent color.
 *
 * Reads the accent color the desktop exposes, so a look can use it:
 * - The XDG Settings portal (`org.freedesktop.appearance` `accent-color`), which GNOME 47+, KDE
 *   Plasma 6 and other desktops fill. Its `SettingChanged` signal keeps the color live.
 * - KDE's `kdeglobals` file, when the portal has no accent.
 *
 * Everything fails soft and fast: with no session bus, no portal or on macOS and Windows the
 * accent is simply null. dbus-next is always connected with `getSessionBusAddress()` so its
 * native `usocket` module is never loaded (it crashes the app on Linux kernel 7, B1).
 *
 * @module desktopAccent
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createLogger } from './logger';
import { getSessionBusAddress } from './dbusFallback';

const logger = createLogger('[DesktopAccent]');

const PORTAL_BUS_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/desktop';
const SETTINGS_INTERFACE = 'org.freedesktop.portal.Settings';
const APPEARANCE_NAMESPACE = 'org.freedesktop.appearance';
const ACCENT_KEY = 'accent-color';
const DBUS_MESSAGE_TYPE_SIGNAL = 4;

/** How long a portal call may take before the accent is treated as unset. */
export const PORTAL_CALL_TIMEOUT_MS = 1500;

// ============================================================================
// Parsing
// ============================================================================

/** Format one 0..255 channel as two hex digits. */
function toHex(channel: number): string {
    return Math.round(channel).toString(16).padStart(2, '0');
}

/**
 * Convert an RGB triple of 0..1 doubles (the portal's `(ddd)`) to `#rrggbb`.
 * Any channel outside 0..1, or not a finite number, means the accent is unset.
 */
export function rgbFloatsToHex(rgb: readonly unknown[]): string | null {
    if (rgb.length !== 3) {
        return null;
    }
    const channels: number[] = [];
    for (const value of rgb) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
            return null;
        }
        channels.push(value * 255);
    }
    return `#${channels.map(toHex).join('')}`;
}

/**
 * Unwrap dbus-next variants (`{ signature, value }`), however deeply nested. `ReadOne` returns
 * one variant and the older `Read` returns a variant holding a variant.
 */
export function unwrapVariant(value: unknown): unknown {
    let current = value;
    for (let depth = 0; depth < 4; depth++) {
        if (
            current !== null &&
            typeof current === 'object' &&
            !Array.isArray(current) &&
            'value' in current &&
            'signature' in current
        ) {
            current = (current as { value: unknown }).value;
        } else {
            break;
        }
    }
    return current;
}

/**
 * Parse the portal's accent-color value (possibly wrapped in variants) to `#rrggbb`, or null.
 */
export function parsePortalAccent(value: unknown): string | null {
    const unwrapped = unwrapVariant(value);
    return Array.isArray(unwrapped) ? rgbFloatsToHex(unwrapped) : null;
}

/**
 * Parse a KDE color value: `r,g,b` (0..255, an optional fourth alpha value is ignored) or `#rrggbb`.
 */
export function parseKdeColor(value: string): string | null {
    const trimmed = value.trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
    if (hex) {
        return `#${(hex[1] ?? '').toLowerCase()}`;
    }
    const parts = trimmed.split(',').map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) {
        return null;
    }
    const channels: number[] = [];
    for (const part of parts.slice(0, 3)) {
        if (!/^\d{1,3}$/.test(part)) {
            return null;
        }
        const channel = Number(part);
        if (channel > 255) {
            return null;
        }
        channels.push(channel);
    }
    return `#${channels.map(toHex).join('')}`;
}

/**
 * Read the accent color from the text of KDE's `kdeglobals`: `[General] AccentColor`, falling back
 * to `[Colors:Selection] BackgroundNormal`.
 */
export function parseKdeGlobalsAccent(text: string): string | null {
    const sections = new Map<string, Map<string, string>>();
    let section = '';
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) {
            continue;
        }
        const header = /^\[(.+)\]$/.exec(line);
        if (header) {
            section = header[1] ?? '';
            continue;
        }
        const equals = line.indexOf('=');
        if (equals <= 0) {
            continue;
        }
        // Keys can carry KDE flags such as AccentColor[$e]
        const key = line
            .slice(0, equals)
            .trim()
            .replace(/\[\$[a-z]+\]$/i, '');
        const entries = sections.get(section) ?? new Map<string, string>();
        entries.set(key, line.slice(equals + 1));
        sections.set(section, entries);
    }

    const accent = sections.get('General')?.get('AccentColor');
    const parsedAccent = accent !== undefined ? parseKdeColor(accent) : null;
    if (parsedAccent) {
        return parsedAccent;
    }
    const selection = sections.get('Colors:Selection')?.get('BackgroundNormal');
    return selection !== undefined ? parseKdeColor(selection) : null;
}

/**
 * Read the accent from `$XDG_CONFIG_HOME/kdeglobals` (or `~/.config/kdeglobals`). Null when the
 * file is missing or has no accent.
 */
export async function readKdeGlobalsAccent(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
    const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
    try {
        const text = await fs.promises.readFile(path.join(configHome, 'kdeglobals'), 'utf8');
        return parseKdeGlobalsAccent(text);
    } catch {
        return null;
    }
}

// ============================================================================
// Portal
// ============================================================================

/** The parts of a dbus-next message this module reads. */
interface DBusMessageLike {
    type?: number;
    path?: string;
    interface?: string;
    member?: string;
    body?: unknown[];
}

/** The parts of a dbus-next MessageBus this module uses. */
interface DBusBusLike {
    call(message: unknown): Promise<DBusMessageLike | null>;
    on(event: string, handler: (...args: unknown[]) => void): void;
    removeListener?(event: string, handler: (...args: unknown[]) => void): void;
    disconnect(): void;
}

/** The parts of the dbus-next module this module uses. */
export interface DBusNextLike {
    sessionBus(options: { busAddress: string }): unknown;
    Message: new (options: Record<string, unknown>) => unknown;
}

/** Reject when a promise takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        timer.unref?.();
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/** Options for {@link DesktopAccentWatcher}. */
export interface DesktopAccentWatcherOptions {
    /** process.platform */
    platform?: NodeJS.Platform;
    /** Environment for the session bus address and kdeglobals */
    env?: NodeJS.ProcessEnv;
    /** Whether the desktop is KDE, so kdeglobals is read when the portal has no accent */
    isKde?: boolean;
    /** Load dbus-next (injected in tests) */
    loadDBus?: () => Promise<DBusNextLike>;
    /** Read kdeglobals (injected in tests) */
    readKdeAccent?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
    /** Timeout for each portal call */
    timeoutMs?: number;
}

/**
 * Reads the desktop accent once and follows the portal's `SettingChanged` signal.
 */
export class DesktopAccentWatcher {
    private readonly platform: NodeJS.Platform;
    private readonly env: NodeJS.ProcessEnv;
    private readonly isKde: boolean;
    private readonly loadDBus: () => Promise<DBusNextLike>;
    private readonly readKdeAccent: (env: NodeJS.ProcessEnv) => Promise<string | null>;
    private readonly timeoutMs: number;
    private bus: DBusBusLike | null = null;
    private messageHandler: ((...args: unknown[]) => void) | null = null;
    private accent: string | null = null;
    private stopped = false;

    constructor(options: DesktopAccentWatcherOptions = {}) {
        this.platform = options.platform ?? process.platform;
        this.env = options.env ?? process.env;
        this.isKde = options.isKde ?? false;
        /* v8 ignore next -- production loader, tests inject a fake */
        this.loadDBus = options.loadDBus ?? (async () => (await import('dbus-next')) as unknown as DBusNextLike);
        this.readKdeAccent = options.readKdeAccent ?? readKdeGlobalsAccent;
        this.timeoutMs = options.timeoutMs ?? PORTAL_CALL_TIMEOUT_MS;
    }

    /** The last accent read, or null. */
    getAccent(): string | null {
        return this.accent;
    }

    /**
     * Read the accent and start following changes. Never throws.
     *
     * @param onChange - Called with the new accent when the desktop changes it after start
     * @param onLost - Called once when the session bus connection fails after it was set up, so
     *   the owner can start a new watcher later
     * @returns The accent at start, or null
     */
    async start(onChange: (accent: string | null) => void, onLost?: () => void): Promise<string | null> {
        if (this.platform !== 'linux') {
            return null;
        }

        let portalAccent: string | null = null;
        try {
            portalAccent = await this.startPortal(onChange, onLost);
        } catch (error) {
            logger.log(`Desktop accent not read from the portal: ${error instanceof Error ? error.message : error}`);
            this.disconnect();
        }

        let accent = portalAccent;
        if (!accent && this.isKde) {
            accent = await this.readKdeAccent(this.env).catch(() => null);
        }
        if (!this.stopped) {
            this.accent = accent;
        }
        logger.log(`Desktop accent: ${accent ?? 'none'}`);
        return accent;
    }

    /** Stop following changes and close the bus connection. */
    stop(): void {
        this.stopped = true;
        this.disconnect();
    }

    private disconnect(): void {
        if (this.bus) {
            if (this.messageHandler) {
                this.bus.removeListener?.('message', this.messageHandler);
            }
            try {
                this.bus.disconnect();
            } catch {
                // Already closed
            }
        }
        this.bus = null;
        this.messageHandler = null;
    }

    private async startPortal(onChange: (accent: string | null) => void, onLost?: () => void): Promise<string | null> {
        const busAddress = getSessionBusAddress(this.env);
        if (!busAddress) {
            throw new Error('no session bus');
        }
        const dbus = await this.loadDBus();
        const bus = dbus.sessionBus({ busAddress }) as DBusBusLike;
        this.bus = bus;
        // An unhandled 'error' event would crash the main process
        bus.on('error', (error: unknown) => {
            logger.log(`Session bus error: ${error instanceof Error ? error.message : String(error)}`);
            const wasFollowing = this.messageHandler !== null;
            this.disconnect();
            if (wasFollowing && !this.stopped) {
                onLost?.();
            }
        });

        const accent = await this.readPortalAccent(bus, dbus);

        await withTimeout(
            bus.call(
                new dbus.Message({
                    destination: 'org.freedesktop.DBus',
                    path: '/org/freedesktop/DBus',
                    interface: 'org.freedesktop.DBus',
                    member: 'AddMatch',
                    signature: 's',
                    body: [
                        `type='signal',interface='${SETTINGS_INTERFACE}',member='SettingChanged',` +
                            `path='${PORTAL_OBJECT_PATH}',arg0='${APPEARANCE_NAMESPACE}'`,
                    ],
                })
            ),
            this.timeoutMs,
            'AddMatch'
        );

        if (this.stopped || this.bus !== bus) {
            return accent;
        }

        this.messageHandler = (...args: unknown[]) => {
            const message = args[0] as DBusMessageLike | undefined;
            if (
                !message ||
                message.type !== DBUS_MESSAGE_TYPE_SIGNAL ||
                message.interface !== SETTINGS_INTERFACE ||
                message.member !== 'SettingChanged'
            ) {
                return;
            }
            const [namespace, key, value] = message.body ?? [];
            if (namespace !== APPEARANCE_NAMESPACE || key !== ACCENT_KEY || this.stopped) {
                return;
            }
            const next = parsePortalAccent(value);
            if (next !== this.accent) {
                this.accent = next;
                logger.log(`Desktop accent changed: ${next ?? 'none'}`);
                onChange(next);
            }
        };
        bus.on('message', this.messageHandler);
        return accent;
    }

    /** ReadOne (portal version 2), falling back to the older Read. */
    private async readPortalAccent(bus: DBusBusLike, dbus: DBusNextLike): Promise<string | null> {
        const call = (member: 'ReadOne' | 'Read') =>
            withTimeout(
                bus.call(
                    new dbus.Message({
                        destination: PORTAL_BUS_NAME,
                        path: PORTAL_OBJECT_PATH,
                        interface: SETTINGS_INTERFACE,
                        member,
                        signature: 'ss',
                        body: [APPEARANCE_NAMESPACE, ACCENT_KEY],
                    })
                ),
                this.timeoutMs,
                member
            );

        try {
            const reply = await call('ReadOne');
            return parsePortalAccent(reply?.body?.[0]);
        } catch (error) {
            const type = (error as { type?: unknown } | null)?.type;
            if (type === 'org.freedesktop.portal.Error.NotFound') {
                return null;
            }
            if (error instanceof Error && error.message.includes('timed out')) {
                throw error;
            }
        }
        try {
            const reply = await call('Read');
            return parsePortalAccent(reply?.body?.[0]);
        } catch (error) {
            const type = (error as { type?: unknown } | null)?.type;
            if (type === 'org.freedesktop.portal.Error.NotFound') {
                return null;
            }
            throw error;
        }
    }
}
