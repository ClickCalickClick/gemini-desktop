/**
 * Unit tests for the desktop accent color reader.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    DesktopAccentWatcher,
    parseKdeColor,
    parseKdeGlobalsAccent,
    parsePortalAccent,
    readKdeGlobalsAccent,
    rgbFloatsToHex,
    unwrapVariant,
} from '../../../../src/main/utils/desktopAccent';
import type { DBusNextLike } from '../../../../src/main/utils/desktopAccent';

const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, default: actual, promises: { ...actual.promises, readFile: mockReadFile } };
});

vi.mock('../../../../src/main/utils/logger', () => ({
    createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));

/** A dbus-next variant as the library unmarshals it */
const variant = (signature: string, value: unknown) => ({ signature, value });

const SESSION_ENV = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };

interface FakeMessage {
    options: Record<string, unknown>;
}

type Listener = (...args: unknown[]) => void;

function createFakeDBus(replies: Record<string, (message: FakeMessage) => unknown>) {
    const listeners = new Map<string, Listener[]>();
    const bus = {
        call: vi.fn(async (message: FakeMessage) => {
            const reply = replies[message.options.member as string];
            return reply ? reply(message) : null;
        }),
        on: vi.fn((event: string, handler: Listener) => {
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        }),
        removeListener: vi.fn((event: string, handler: Listener) => {
            listeners.set(
                event,
                (listeners.get(event) ?? []).filter((h) => h !== handler)
            );
        }),
        disconnect: vi.fn(),
        emit: (event: string, ...args: unknown[]) => (listeners.get(event) ?? []).forEach((h) => h(...args)),
    };
    const sessionBus = vi.fn(() => bus);
    const dbus = {
        sessionBus,
        Message: class {
            constructor(public options: Record<string, unknown>) {}
        },
    } as unknown as DBusNextLike;
    return { bus, dbus, sessionBus };
}

function settingChanged(namespace: string, key: string, value: unknown) {
    return {
        type: 4,
        path: '/org/freedesktop/portal/desktop',
        interface: 'org.freedesktop.portal.Settings',
        member: 'SettingChanged',
        body: [namespace, key, value],
    };
}

function linuxWatcher(dbus: DBusNextLike, extra: Partial<ConstructorParameters<typeof DesktopAccentWatcher>[0]> = {}) {
    return new DesktopAccentWatcher({ platform: 'linux', env: SESSION_ENV, loadDBus: async () => dbus, ...extra });
}

describe('desktopAccent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('parsing', () => {
        it('converts portal RGB doubles to hex', () => {
            expect(rgbFloatsToHex([0.20784, 0.51765, 0.89412])).toBe('#3584e4');
            expect(rgbFloatsToHex([0, 0, 0])).toBe('#000000');
            expect(rgbFloatsToHex([1, 1, 1])).toBe('#ffffff');
        });

        it('treats out-of-range or malformed tuples as unset', () => {
            expect(rgbFloatsToHex([-1, -1, -1])).toBeNull();
            expect(rgbFloatsToHex([1.5, 0, 0])).toBeNull();
            expect(rgbFloatsToHex([Number.NaN, 0, 0])).toBeNull();
            expect(rgbFloatsToHex([0, 0])).toBeNull();
            expect(rgbFloatsToHex(['0', 0, 0])).toBeNull();
        });

        it('unwraps ReadOne and nested Read variants', () => {
            const tuple = [0.2, 0.4, 0.6];
            expect(unwrapVariant(variant('(ddd)', tuple))).toBe(tuple);
            expect(parsePortalAccent(variant('(ddd)', tuple))).toBe('#336699');
            expect(parsePortalAccent(variant('v', variant('(ddd)', tuple)))).toBe('#336699');
            expect(parsePortalAccent(tuple)).toBe('#336699');
        });

        it('returns null for portal values that are not tuples', () => {
            expect(parsePortalAccent(variant('u', 1))).toBeNull();
            expect(parsePortalAccent(undefined)).toBeNull();
            expect(parsePortalAccent(null)).toBeNull();
        });

        it('parses KDE colors', () => {
            expect(parseKdeColor('61,174,233')).toBe('#3daee9');
            expect(parseKdeColor(' 61, 174, 233, 255 ')).toBe('#3daee9');
            expect(parseKdeColor('#3DAEE9')).toBe('#3daee9');
            expect(parseKdeColor('256,0,0')).toBeNull();
            expect(parseKdeColor('a,b,c')).toBeNull();
            expect(parseKdeColor('1,2')).toBeNull();
            expect(parseKdeColor('')).toBeNull();
        });

        it('reads AccentColor from [General]', () => {
            const text = ['[General]', 'ColorScheme=BreezeDark', 'AccentColor=233,100,61', ''].join('\n');
            expect(parseKdeGlobalsAccent(text)).toBe('#e9643d');
        });

        it('accepts KDE key flags and Windows line endings', () => {
            expect(parseKdeGlobalsAccent('[General]\r\nAccentColor[$e]=1,2,3\r\n')).toBe('#010203');
        });

        it('falls back to [Colors:Selection] BackgroundNormal', () => {
            const text = [
                '# comment',
                '[Colors:View]',
                'BackgroundNormal=20,22,24',
                '[Colors:Selection]',
                'BackgroundNormal=61,174,233',
                '[General]',
                'AccentColor=not-a-color',
            ].join('\n');
            expect(parseKdeGlobalsAccent(text)).toBe('#3daee9');
        });

        it('returns null when kdeglobals has no accent', () => {
            expect(parseKdeGlobalsAccent('[General]\nColorScheme=Breeze\nbroken line\n')).toBeNull();
            expect(parseKdeGlobalsAccent('')).toBeNull();
        });

        it('reads kdeglobals from XDG_CONFIG_HOME or ~/.config', async () => {
            mockReadFile.mockResolvedValueOnce('[General]\nAccentColor=1,2,3\n');
            await expect(readKdeGlobalsAccent({ XDG_CONFIG_HOME: '/cfg' })).resolves.toBe('#010203');
            expect(mockReadFile).toHaveBeenCalledWith('/cfg/kdeglobals', 'utf8');

            mockReadFile.mockResolvedValueOnce('');
            await readKdeGlobalsAccent({ HOME: '/home/me' });
            expect(mockReadFile).toHaveBeenLastCalledWith('/home/me/.config/kdeglobals', 'utf8');

            mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
            await expect(readKdeGlobalsAccent({ HOME: '/home/me' })).resolves.toBeNull();
        });
    });

    describe('DesktopAccentWatcher', () => {
        it('returns null on macOS and Windows without loading dbus-next', async () => {
            const loadDBus = vi.fn();
            for (const platform of ['darwin', 'win32'] as const) {
                const watcher = new DesktopAccentWatcher({ platform, env: SESSION_ENV, loadDBus });
                await expect(watcher.start(vi.fn())).resolves.toBeNull();
            }
            expect(loadDBus).not.toHaveBeenCalled();
        });

        it('returns null when there is no session bus', async () => {
            const loadDBus = vi.fn();
            const watcher = new DesktopAccentWatcher({ platform: 'linux', env: {}, loadDBus });
            await expect(watcher.start(vi.fn())).resolves.toBeNull();
            expect(loadDBus).not.toHaveBeenCalled();
        });

        it('reads the accent with ReadOne on a usocket-free connection', async () => {
            const { bus, dbus, sessionBus } = createFakeDBus({
                ReadOne: () => ({ body: [variant('(ddd)', [0.2, 0.4, 0.6])] }),
                AddMatch: () => ({ body: [] }),
            });
            const watcher = linuxWatcher(dbus);
            await expect(watcher.start(vi.fn())).resolves.toBe('#336699');
            expect(sessionBus).toHaveBeenCalledWith({ busAddress: 'unix:socket=/run/user/1000/bus' });
            const members = bus.call.mock.calls.map(([message]) => message.options.member);
            expect(members).toEqual(['ReadOne', 'AddMatch']);
            expect(bus.call.mock.calls[0][0].options).toMatchObject({
                destination: 'org.freedesktop.portal.Desktop',
                path: '/org/freedesktop/portal/desktop',
                interface: 'org.freedesktop.portal.Settings',
                body: ['org.freedesktop.appearance', 'accent-color'],
            });
            expect(watcher.getAccent()).toBe('#336699');
        });

        it('falls back to Read when ReadOne is unknown', async () => {
            const { dbus } = createFakeDBus({
                ReadOne: () => {
                    throw Object.assign(new Error('No such method'), {
                        type: 'org.freedesktop.DBus.Error.UnknownMethod',
                    });
                },
                Read: () => ({ body: [variant('v', variant('(ddd)', [1, 0, 0]))] }),
                AddMatch: () => ({ body: [] }),
            });
            await expect(linuxWatcher(dbus).start(vi.fn())).resolves.toBe('#ff0000');
        });

        it('treats NotFound as no accent', async () => {
            const notFound = () => {
                throw Object.assign(new Error('Requested setting not found'), {
                    type: 'org.freedesktop.portal.Error.NotFound',
                });
            };
            const { dbus } = createFakeDBus({ ReadOne: notFound, AddMatch: () => ({ body: [] }) });
            await expect(linuxWatcher(dbus).start(vi.fn())).resolves.toBeNull();

            const { dbus: oldPortal } = createFakeDBus({
                ReadOne: () => {
                    throw new Error('UnknownMethod');
                },
                Read: notFound,
                AddMatch: () => ({ body: [] }),
            });
            await expect(linuxWatcher(oldPortal).start(vi.fn())).resolves.toBeNull();
        });

        it('gives up quickly when the portal does not answer', async () => {
            const { bus, dbus } = createFakeDBus({});
            bus.call.mockImplementation(() => new Promise(() => {}));
            const watcher = linuxWatcher(dbus, { timeoutMs: 10 });
            await expect(watcher.start(vi.fn())).resolves.toBeNull();
            expect(bus.disconnect).toHaveBeenCalled();
        });

        it('fails soft when dbus-next cannot load', async () => {
            const watcher = new DesktopAccentWatcher({
                platform: 'linux',
                env: SESSION_ENV,
                loadDBus: async () => {
                    throw new Error('missing');
                },
            });
            await expect(watcher.start(vi.fn())).resolves.toBeNull();
        });

        it('falls back to kdeglobals on KDE when the portal has no accent', async () => {
            const { dbus } = createFakeDBus({
                ReadOne: () => ({ body: [variant('(ddd)', [-1, -1, -1])] }),
                AddMatch: () => ({ body: [] }),
            });
            const readKdeAccent = vi.fn().mockResolvedValue('#3daee9');
            await expect(linuxWatcher(dbus, { isKde: true, readKdeAccent }).start(vi.fn())).resolves.toBe('#3daee9');

            readKdeAccent.mockClear();
            const notKde = new DesktopAccentWatcher({ platform: 'linux', env: {}, readKdeAccent });
            await expect(notKde.start(vi.fn())).resolves.toBeNull();
            expect(readKdeAccent).not.toHaveBeenCalled();
        });

        it('follows SettingChanged for the accent only', async () => {
            const { bus, dbus } = createFakeDBus({
                ReadOne: () => ({ body: [variant('(ddd)', [0.2, 0.4, 0.6])] }),
                AddMatch: () => ({ body: [] }),
            });
            const onChange = vi.fn();
            const watcher = linuxWatcher(dbus);
            await watcher.start(onChange);

            const addMatch = bus.call.mock.calls[1][0].options;
            expect(addMatch.member).toBe('AddMatch');
            expect(String((addMatch.body as string[])[0])).toContain("member='SettingChanged'");

            bus.emit('message', settingChanged('org.freedesktop.appearance', 'color-scheme', variant('u', 1)));
            bus.emit('message', settingChanged('org.gnome.desktop.interface', 'accent-color', variant('s', 'red')));
            bus.emit('message', { type: 1, member: 'SettingChanged' });
            bus.emit('message', undefined);
            expect(onChange).not.toHaveBeenCalled();

            const red = settingChanged('org.freedesktop.appearance', 'accent-color', variant('(ddd)', [1, 0, 0]));
            bus.emit('message', red);
            expect(onChange).toHaveBeenCalledWith('#ff0000');
            expect(watcher.getAccent()).toBe('#ff0000');

            // Same value again: no change
            bus.emit('message', red);
            expect(onChange).toHaveBeenCalledTimes(1);

            // Unset
            bus.emit(
                'message',
                settingChanged('org.freedesktop.appearance', 'accent-color', variant('(ddd)', [-1, -1, -1]))
            );
            expect(onChange).toHaveBeenLastCalledWith(null);
        });

        it('stops following changes and disconnects on stop', async () => {
            const { bus, dbus } = createFakeDBus({
                ReadOne: () => ({ body: [variant('(ddd)', [0, 0, 0])] }),
                AddMatch: () => ({ body: [] }),
            });
            const onChange = vi.fn();
            const watcher = linuxWatcher(dbus);
            await watcher.start(onChange);
            watcher.stop();
            expect(bus.disconnect).toHaveBeenCalled();
            bus.emit(
                'message',
                settingChanged('org.freedesktop.appearance', 'accent-color', variant('(ddd)', [1, 0, 0]))
            );
            expect(onChange).not.toHaveBeenCalled();
        });

        it('disconnects on a bus error', async () => {
            const { bus, dbus } = createFakeDBus({
                ReadOne: () => ({ body: [variant('(ddd)', [0, 0, 0])] }),
                AddMatch: () => ({ body: [] }),
            });
            await linuxWatcher(dbus).start(vi.fn());
            bus.emit('error', new Error('connection reset'));
            expect(bus.disconnect).toHaveBeenCalled();
        });
    });
});
