/**
 * Unit tests for rendererReloads.
 */

import { describe, expect, it } from 'vitest';

import RendererReloads, { MAX_RELOADS, RELOAD_PERIOD_MS } from '../../../../src/main/utils/rendererReloads';

function createReloads() {
    const clock = { now: 1000000 };
    return { clock, reloads: new RendererReloads(() => clock.now) };
}

describe('RendererReloads', () => {
    it.each(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'memory-eviction'])(
        'reloads a window whose renderer is gone with %s',
        (reason) => {
            const { reloads } = createReloads();

            expect(reloads.shouldReload(1, reason, false)).toBe(true);
        }
    );

    it.each(['clean-exit', 'killed'])('does not reload a window whose renderer is gone with %s', (reason) => {
        const { reloads } = createReloads();

        expect(reloads.shouldReload(1, reason, false)).toBe(false);
    });

    it('does not reload while the app quits', () => {
        const { reloads } = createReloads();

        expect(reloads.shouldReload(1, 'crashed', true)).toBe(false);
    });

    it(`reloads one window at most ${MAX_RELOADS} times within the period`, () => {
        const { clock, reloads } = createReloads();

        for (let i = 0; i < MAX_RELOADS; i++) {
            expect(reloads.shouldReload(1, 'launch-failed', false)).toBe(true);
            clock.now += 10;
        }

        expect(reloads.shouldReload(1, 'launch-failed', false)).toBe(false);
        expect(reloads.shouldReload(1, 'crashed', false)).toBe(false);
    });

    it('counts each window on its own', () => {
        const { reloads } = createReloads();

        for (let i = 0; i < MAX_RELOADS; i++) reloads.shouldReload(1, 'crashed', false);

        expect(reloads.shouldReload(1, 'crashed', false)).toBe(false);
        expect(reloads.shouldReload(2, 'crashed', false)).toBe(true);
    });

    it('reloads again once the earliest reload is older than the period', () => {
        const { clock, reloads } = createReloads();
        const first = clock.now;

        for (let i = 0; i < MAX_RELOADS; i++) {
            reloads.shouldReload(1, 'crashed', false);
            clock.now += 1000;
        }
        expect(reloads.shouldReload(1, 'crashed', false)).toBe(false);

        clock.now = first + RELOAD_PERIOD_MS - 1;
        expect(reloads.shouldReload(1, 'crashed', false)).toBe(false);

        clock.now = first + RELOAD_PERIOD_MS;
        expect(reloads.shouldReload(1, 'crashed', false)).toBe(true);
        expect(reloads.shouldReload(1, 'crashed', false)).toBe(false);
    });

    it('does not count refusals as reloads', () => {
        const { reloads } = createReloads();

        reloads.shouldReload(1, 'killed', false);
        reloads.shouldReload(1, 'clean-exit', false);
        reloads.shouldReload(1, 'crashed', true);

        for (let i = 0; i < MAX_RELOADS; i++) {
            expect(reloads.shouldReload(1, 'crashed', false)).toBe(true);
        }
    });
});
