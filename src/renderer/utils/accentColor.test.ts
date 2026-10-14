/**
 * Unit tests for the accent color helpers.
 */

import { describe, it, expect } from 'vitest';
import { getAccentForeground, isSafeAccentColor, parseAccentColor, relativeLuminance } from './accentColor';

describe('accentColor', () => {
    describe('isSafeAccentColor', () => {
        it.each([
            '#fff',
            '#ffff',
            '#3584e4',
            '#3584e4cc',
            'rgb(53, 132, 228)',
            'rgba(53,132,228,0.5)',
            'rgb(10%,20%,30%)',
        ])('accepts %s', (value) => {
            expect(isSafeAccentColor(value)).toBe(true);
        });

        it.each(['#12', '#12345', '#1234567', '#123456789', 'red', 'rgb(1,2)', 'url(x)', 'red; background: url(x)'])(
            'rejects %s',
            (value) => {
                expect(isSafeAccentColor(value)).toBe(false);
            }
        );
    });

    describe('parseAccentColor', () => {
        it('parses hex and rgb forms', () => {
            expect(parseAccentColor('#3584e4')).toEqual([0x35, 0x84, 0xe4]);
            expect(parseAccentColor('#3584e480')).toEqual([0x35, 0x84, 0xe4]);
            expect(parseAccentColor('#fa0')).toEqual([0xff, 0xaa, 0x00]);
            expect(parseAccentColor('#fa08')).toEqual([0xff, 0xaa, 0x00]);
            expect(parseAccentColor('rgb(53, 132, 228)')).toEqual([53, 132, 228]);
            expect(parseAccentColor('rgb(100%, 0%, 50%)')).toEqual([255, 0, 127.5]);
            expect(parseAccentColor('rgb(300, 0, 0)')).toEqual([255, 0, 0]);
            expect(parseAccentColor('nope')).toBeNull();
        });
    });

    describe('relativeLuminance', () => {
        it('is 0 for black and 1 for white', () => {
            expect(relativeLuminance([0, 0, 0])).toBe(0);
            expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1);
        });
    });

    describe('getAccentForeground', () => {
        it.each([
            ['#3584e4', '#ffffff'], // GNOME blue
            ['#e01b24', '#ffffff'], // GNOME red
            ['#9141ac', '#ffffff'], // GNOME purple
            ['#e5a50a', '#000000'], // GNOME yellow: white would be about 2.2:1
            ['#2190a4', '#ffffff'], // GNOME teal: white keeps more than 3:1
            ['#3a944a', '#ffffff'], // GNOME green
            ['#ed5b00', '#ffffff'], // GNOME orange: about 3.3:1
            ['#3daee9', '#000000'], // KDE blue: white is about 2.6:1
            ['#63d0df', '#000000'], // COSMIC cyan
            ['#ffffff', '#000000'],
            ['#000000', '#ffffff'],
        ])('picks %s -> %s', (accent, expected) => {
            expect(getAccentForeground(accent)).toBe(expected);
        });

        it('returns null for colors it cannot parse', () => {
            expect(getAccentForeground('blue')).toBeNull();
        });
    });
});
