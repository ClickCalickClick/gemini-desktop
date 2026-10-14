/**
 * Unit tests for launchArgs, the app's own command-line flags (--quick-chat, --hidden).
 */

import { describe, expect, it } from 'vitest';

import { hasFlag, parseLaunchOptions, wantsQuickChat } from '../../../../src/main/utils/launchArgs';

const exe = '/opt/Gemini Desktop/gemini-desktop';

describe('launchArgs', () => {
    describe('hasFlag', () => {
        it('finds a flag anywhere before a bare --', () => {
            expect(hasFlag([exe, '--no-sandbox', '--quick-chat'], '--quick-chat')).toBe(true);
            expect(hasFlag([exe, '--', '--quick-chat'], '--quick-chat')).toBe(false);
        });

        it('matches whole arguments only', () => {
            expect(hasFlag([exe, '--quick-chat-foo'], '--quick-chat')).toBe(false);
            expect(hasFlag([exe, 'quick-chat'], '--quick-chat')).toBe(false);
        });
    });

    describe('wantsQuickChat', () => {
        it('is true for a second instance started with --quick-chat', () => {
            expect(wantsQuickChat([exe, '--quick-chat'])).toBe(true);
        });

        it('is false for a plain second start', () => {
            expect(wantsQuickChat([exe])).toBe(false);
            expect(wantsQuickChat([exe, '--hidden'], {})).toBe(false);
        });

        it('reads the single-instance data when Chromium dropped the flag from argv', () => {
            expect(wantsQuickChat([exe], { quickChat: true })).toBe(true);
            expect(wantsQuickChat([exe], { quickChat: false })).toBe(false);
            expect(wantsQuickChat([exe], null)).toBe(false);
            expect(wantsQuickChat([exe], 'quickChat')).toBe(false);
        });
    });

    describe('parseLaunchOptions', () => {
        it('shows the main window on a plain start', () => {
            expect(parseLaunchOptions([exe])).toEqual({ startHidden: false, openQuickChat: false });
        });

        it('starts hidden with --hidden', () => {
            expect(parseLaunchOptions([exe, '--hidden'])).toEqual({ startHidden: true, openQuickChat: false });
        });

        it('starts hidden and opens Quick Chat with --quick-chat', () => {
            expect(parseLaunchOptions([exe, '--no-sandbox', '--quick-chat'])).toEqual({
                startHidden: true,
                openQuickChat: true,
            });
        });
    });
});
