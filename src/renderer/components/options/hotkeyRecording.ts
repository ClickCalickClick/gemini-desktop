/**
 * Hotkey recording helpers
 *
 * Turns the key presses the Options hotkey recorder sees into Electron accelerator strings, and
 * accelerators back into keycap labels. Kept free of React so the rules can be tested directly.
 *
 * - Ctrl is recorded as `CommandOrControl` (Cmd on macOS); on macOS, Cmd is `CommandOrControl` and
 *   Ctrl is `Control`.
 * - The Super / Windows key (`metaKey` outside macOS) is recorded as `Super`, so chords such as the
 *   Copilot key's Shift+Super+F23 can be used.
 * - F13-F24 work on their own; every other key needs a modifier.
 * - A key Electron has no name for (such as one the browser reports as "Unidentified") is reported
 *   back instead of being saved, so the recorder can explain what to do.
 *
 * @module hotkeyRecording
 */

/** The parts of a keyboard event the recorder reads */
export interface RecordedKeyEvent {
    key: string;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

/** What one key press means while recording */
export type HotkeyRecordResult =
    /** A complete shortcut */
    | { kind: 'accelerator'; accelerator: string }
    /** Only modifiers so far: keep recording */
    | { kind: 'pending' }
    /** A key that needs Ctrl, Alt, Shift or Super with it */
    | { kind: 'needs-modifier'; keyName: string }
    /** A key Electron cannot register */
    | { kind: 'unsupported'; keyName: string };

/** Keys that only modify another key */
const MODIFIER_KEYS = new Set([
    'Control',
    'Meta',
    'Alt',
    'AltGraph',
    'Shift',
    'OS',
    'Super',
    'Hyper',
    'Fn',
    'CapsLock',
    'NumLock',
    'ScrollLock',
]);

/** Keys named by `KeyboardEvent.code`, mapped to Electron's accelerator key names */
const CODE_TO_ACCELERATOR_KEY: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    PrintScreen: 'PrintScreen',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
};

/** Media keys named by `KeyboardEvent.key`, mapped to Electron's accelerator key names */
const MEDIA_KEY_TO_ACCELERATOR_KEY: Record<string, string> = {
    AudioVolumeUp: 'VolumeUp',
    AudioVolumeDown: 'VolumeDown',
    AudioVolumeMute: 'VolumeMute',
    MediaTrackNext: 'MediaNextTrack',
    MediaTrackPrevious: 'MediaPreviousTrack',
    MediaStop: 'MediaStop',
    MediaPlayPause: 'MediaPlayPause',
};

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

/** F13-F24 are free on almost every keyboard, so they may be used without a modifier */
function isStandaloneKey(key: string): boolean {
    const match = FUNCTION_KEY.exec(key);
    return match !== null && Number(match[1]) >= 13;
}

/** Find Electron's name for the pressed key, or null when it has none */
function getAcceleratorKey(event: RecordedKeyEvent): string | null {
    const { code, key } = event;

    if (/^Key[A-Z]$/.test(code)) {
        return code.slice(3);
    }
    if (/^Digit\d$/.test(code)) {
        return code.slice(5);
    }
    // The Copilot key reaches the browser as code F23 even where the keyboard layout gives it another
    // key name, so function keys are read from the code first
    if (FUNCTION_KEY.test(code)) {
        return code;
    }
    if (FUNCTION_KEY.test(key)) {
        return key;
    }
    if (CODE_TO_ACCELERATOR_KEY[code]) {
        return CODE_TO_ACCELERATOR_KEY[code];
    }
    if (MEDIA_KEY_TO_ACCELERATOR_KEY[key]) {
        return MEDIA_KEY_TO_ACCELERATOR_KEY[key];
    }
    if (key === '+') {
        return 'Plus';
    }
    if (key.length === 1 && key.trim() !== '') {
        return key.toUpperCase();
    }
    return null;
}

/** A readable name for a key the recorder cannot use */
function describeKey(event: RecordedKeyEvent): string {
    if (event.key && event.key !== 'Unidentified' && event.key !== 'Dead') {
        return event.key;
    }
    return event.code || 'Unidentified';
}

/**
 * Convert one key press to an Electron accelerator.
 *
 * @param event - The key press
 * @param platform - `process.platform` of the app, from the preload bridge
 */
export function keyEventToAccelerator(event: RecordedKeyEvent, platform: string | undefined): HotkeyRecordResult {
    if (MODIFIER_KEYS.has(event.key)) {
        return { kind: 'pending' };
    }

    const key = getAcceleratorKey(event);
    if (!key) {
        return { kind: 'unsupported', keyName: describeKey(event) };
    }

    const isMac = platform === 'darwin';
    const modifiers: string[] = [];
    if (isMac) {
        if (event.ctrlKey) modifiers.push('Control');
        if (event.metaKey) modifiers.push('CommandOrControl');
    } else if (event.ctrlKey) {
        modifiers.push('CommandOrControl');
    }
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (!isMac && event.metaKey) modifiers.push('Super');

    if (modifiers.length === 0 && !isStandaloneKey(key)) {
        return { kind: 'needs-modifier', keyName: key };
    }

    return { kind: 'accelerator', accelerator: [...modifiers, key].join('+') };
}

/**
 * The recorder's explanation for a key press it could not save, or null when there is none.
 *
 * @param result - What `keyEventToAccelerator()` returned
 * @param platform - `process.platform` of the app
 */
export function getRecordingMessage(result: HotkeyRecordResult, platform: string | undefined): string | null {
    if (result.kind === 'needs-modifier') {
        const modifiers = platform === 'darwin' ? '⌘, ⌃, ⌥ or ⇧' : 'Ctrl, Alt, Shift or Super';
        return `Hold ${modifiers} with ${result.keyName}. Only F13–F24 work on their own.`;
    }
    if (result.kind === 'unsupported') {
        const copilotHint =
            platform === 'darwin'
                ? ''
                : ' A Copilot key usually works with “Use Copilot key” under Quick Chat (Shift+Super+F23).';
        return (
            `This key reached the app as “${result.keyName}”, which can't be used as a shortcut.${copilotHint}` +
            ' Otherwise, assign the key in your system’s keyboard settings.'
        );
    }
    return null;
}

/**
 * Split an accelerator into keycap labels for display.
 *
 * @param accelerator - An Electron accelerator
 * @param platform - `process.platform` of the app
 */
export function parseAcceleratorParts(accelerator: string, platform: string | undefined): string[] {
    if (!accelerator) return [];

    const isMac = platform === 'darwin';
    const superLabel = isMac ? '⌘' : platform === 'win32' ? 'Win' : 'Super';

    return accelerator.split('+').map((part) => {
        switch (part) {
            case 'CommandOrControl':
            case 'CmdOrCtrl':
                return isMac ? '⌘' : 'Ctrl';
            case 'Control':
            case 'Ctrl':
                return isMac ? '⌃' : 'Ctrl';
            case 'Alt':
            case 'Option':
                return isMac ? '⌥' : 'Alt';
            case 'Shift':
                return isMac ? '⇧' : 'Shift';
            case 'Command':
            case 'Cmd':
                return '⌘';
            case 'Super':
            case 'Meta':
                return superLabel;
            case 'Space':
                return '␣';
            default:
                return part;
        }
    });
}

/** Desktop modifier names (GTK `<Shift>`, KDE `Meta+`), mapped to keycap labels */
const DESKTOP_MODIFIER_LABELS: Record<string, string> = {
    shift: 'Shift',
    control: 'Ctrl',
    ctrl: 'Ctrl',
    primary: 'Ctrl',
    alt: 'Alt',
    super: 'Super',
    meta: 'Super',
    logo: 'Super',
    mod4: 'Super',
    hyper: 'Hyper',
};

/** Keysym names a desktop may report, mapped to friendlier keycap labels */
const DESKTOP_KEY_LABELS: Record<string, string> = {
    // The Copilot key: xkeyboard-config 2.44 and later give Shift+Super+F23 this keysym
    XF86Assistant: 'Copilot',
    space: '␣',
    Return: 'Enter',
};

function desktopKeyLabel(key: string): string {
    if (DESKTOP_KEY_LABELS[key]) return DESKTOP_KEY_LABELS[key];
    if (key.startsWith('XF86')) return key.slice(4);
    return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Split the key a desktop reports for a portal shortcut into keycap labels. GNOME describes it as
 * "Press <Shift><Super>XF86Assistant" (in the user's language), KDE as a chord such as
 * "Meta+Shift+F23".
 *
 * @param description - The portal's trigger description
 * @returns Keycap labels, or an empty array when no key is bound
 */
export function parseDesktopTrigger(description: string | undefined): string[] {
    const text = description?.trim();
    if (!text) return [];

    const gtk = /((?:<[A-Za-z0-9_]+>)+)([^\s<>]+)/.exec(text);
    if (gtk) {
        const [, modifierText = '', key = ''] = gtk;
        const modifiers = [...modifierText.matchAll(/<([A-Za-z0-9_]+)>/g)].map((m) => {
            const name = m[1] ?? '';
            return DESKTOP_MODIFIER_LABELS[name.toLowerCase()] ?? name;
        });
        return [...modifiers, desktopKeyLabel(key)];
    }

    // A single key ("Press F13") or a KDE-style chord: the last word is the key
    const lastWord = text.split(/\s+/).pop() ?? '';
    const parts = lastWord.split('+').filter(Boolean);
    return parts.map((part, index) =>
        index < parts.length - 1 ? (DESKTOP_MODIFIER_LABELS[part.toLowerCase()] ?? part) : desktopKeyLabel(part)
    );
}
