/**
 * Unit tests for the hotkey recorder's key-to-accelerator rules (hotkeyRecording.ts).
 */

import { describe, expect, it } from 'vitest';

import {
    getRecordingMessage,
    keyEventToAccelerator,
    parseAcceleratorParts,
    type RecordedKeyEvent,
} from '../../../../../src/renderer/components/options/hotkeyRecording';

function press(partial: Partial<RecordedKeyEvent>): RecordedKeyEvent {
    return { key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...partial };
}

describe('keyEventToAccelerator', () => {
    it.each(['linux', 'win32'])('records the Copilot key (Shift+Meta+F23) as Shift+Super+F23 on %s', (platform) => {
        expect(
            keyEventToAccelerator(press({ key: 'F23', code: 'F23', shiftKey: true, metaKey: true }), platform)
        ).toEqual({ kind: 'accelerator', accelerator: 'Shift+Super+F23' });
    });

    it('reads F23 from the code when the layout gives the key another name', () => {
        // Some xkeyboard-config layouts give the F23 key the XF86TouchpadOff keysym
        expect(
            keyEventToAccelerator(press({ key: 'Unidentified', code: 'F23', shiftKey: true, metaKey: true }), 'linux')
        ).toEqual({ kind: 'accelerator', accelerator: 'Shift+Super+F23' });
    });

    it('accepts F13-F24 without a modifier, but not F1-F12 or letters', () => {
        expect(keyEventToAccelerator(press({ key: 'F23', code: 'F23' }), 'linux')).toEqual({
            kind: 'accelerator',
            accelerator: 'F23',
        });
        expect(keyEventToAccelerator(press({ key: 'F13', code: 'F13' }), 'win32')).toEqual({
            kind: 'accelerator',
            accelerator: 'F13',
        });
        expect(keyEventToAccelerator(press({ key: 'F5', code: 'F5' }), 'linux')).toEqual({
            kind: 'needs-modifier',
            keyName: 'F5',
        });
        expect(keyEventToAccelerator(press({ key: 'a', code: 'KeyA' }), 'linux')).toEqual({
            kind: 'needs-modifier',
            keyName: 'A',
        });
    });

    it('records Super chords on Linux and Windows', () => {
        expect(keyEventToAccelerator(press({ key: 'g', code: 'KeyG', metaKey: true }), 'linux')).toEqual({
            kind: 'accelerator',
            accelerator: 'Super+G',
        });
        expect(
            keyEventToAccelerator(
                press({ key: 'G', code: 'KeyG', ctrlKey: true, altKey: true, metaKey: true }),
                'win32'
            )
        ).toEqual({ kind: 'accelerator', accelerator: 'CommandOrControl+Alt+Super+G' });
    });

    it('keeps Cmd as CommandOrControl and Ctrl as Control on macOS', () => {
        expect(keyEventToAccelerator(press({ key: 'k', code: 'KeyK', metaKey: true }), 'darwin')).toEqual({
            kind: 'accelerator',
            accelerator: 'CommandOrControl+K',
        });
        expect(keyEventToAccelerator(press({ key: 'k', code: 'KeyK', ctrlKey: true }), 'darwin')).toEqual({
            kind: 'accelerator',
            accelerator: 'Control+K',
        });
    });

    it('keeps the existing Ctrl recording on Linux and Windows', () => {
        expect(
            keyEventToAccelerator(
                press({ key: 'P', code: 'KeyP', ctrlKey: true, altKey: true, shiftKey: true }),
                'linux'
            )
        ).toEqual({ kind: 'accelerator', accelerator: 'CommandOrControl+Alt+Shift+P' });
    });

    it('waits while only modifiers are held, the Super key included', () => {
        for (const key of ['Shift', 'Meta', 'OS', 'Control', 'Alt', 'AltGraph']) {
            expect(keyEventToAccelerator(press({ key, shiftKey: true, metaKey: true }), 'linux')).toEqual({
                kind: 'pending',
            });
        }
    });

    it('names digits, punctuation, media and navigation keys the way Electron does', () => {
        expect(
            keyEventToAccelerator(press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), 'linux')
        ).toEqual({ kind: 'accelerator', accelerator: 'CommandOrControl+Shift+1' });
        expect(keyEventToAccelerator(press({ key: '/', code: 'Slash', ctrlKey: true }), 'linux')).toEqual({
            kind: 'accelerator',
            accelerator: 'CommandOrControl+/',
        });
        expect(keyEventToAccelerator(press({ key: 'ArrowUp', code: 'ArrowUp', altKey: true }), 'linux')).toEqual({
            kind: 'accelerator',
            accelerator: 'Alt+Up',
        });
        expect(
            keyEventToAccelerator(press({ key: 'MediaPlayPause', code: 'MediaPlayPause', ctrlKey: true }), 'linux')
        ).toEqual({ kind: 'accelerator', accelerator: 'CommandOrControl+MediaPlayPause' });
    });

    it('reports keys Electron has no name for instead of saving them', () => {
        expect(keyEventToAccelerator(press({ key: 'Unidentified', code: '', metaKey: true }), 'linux')).toEqual({
            kind: 'unsupported',
            keyName: 'Unidentified',
        });
        expect(keyEventToAccelerator(press({ key: 'LaunchAssistant', code: '', shiftKey: true }), 'linux')).toEqual({
            kind: 'unsupported',
            keyName: 'LaunchAssistant',
        });
        expect(keyEventToAccelerator(press({ key: 'Unidentified', code: 'Lang3' }), 'win32')).toEqual({
            kind: 'unsupported',
            keyName: 'Lang3',
        });
    });
});

describe('getRecordingMessage', () => {
    it('explains an unknown key and points at the Copilot preset outside macOS', () => {
        const message = getRecordingMessage({ kind: 'unsupported', keyName: 'Unidentified' }, 'linux');
        expect(message).toContain('“Unidentified”');
        expect(message).toContain('Use Copilot key');
        expect(message).toContain('keyboard settings');

        expect(getRecordingMessage({ kind: 'unsupported', keyName: 'X' }, 'darwin')).not.toContain('Copilot');
    });

    it('asks for a modifier', () => {
        expect(getRecordingMessage({ kind: 'needs-modifier', keyName: 'A' }, 'linux')).toContain(
            'Ctrl, Alt, Shift or Super'
        );
    });

    it('says nothing for a saved shortcut or held modifiers', () => {
        expect(getRecordingMessage({ kind: 'accelerator', accelerator: 'F23' }, 'linux')).toBeNull();
        expect(getRecordingMessage({ kind: 'pending' }, 'linux')).toBeNull();
    });
});

describe('parseAcceleratorParts', () => {
    it('labels the Super key for each platform', () => {
        expect(parseAcceleratorParts('Shift+Super+F23', 'linux')).toEqual(['Shift', 'Super', 'F23']);
        expect(parseAcceleratorParts('Shift+Super+F23', 'win32')).toEqual(['Shift', 'Win', 'F23']);
        expect(parseAcceleratorParts('Shift+Meta+F23', 'darwin')).toEqual(['⇧', '⌘', 'F23']);
    });

    it('keeps the existing labels', () => {
        expect(parseAcceleratorParts('CommandOrControl+Shift+Alt+Space', 'win32')).toEqual([
            'Ctrl',
            'Shift',
            'Alt',
            '␣',
        ]);
        expect(parseAcceleratorParts('', 'linux')).toEqual([]);
    });
});
