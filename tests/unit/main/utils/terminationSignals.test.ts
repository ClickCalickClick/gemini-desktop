/**
 * Unit tests for terminationSignals.
 *
 * process.on, process.kill and process.removeAllListeners are replaced, so no handler is
 * installed in the test process and nothing is killed.
 */

import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TerminationSignals, {
    TERMINATION_SIGNALS,
    isProcessRunning,
} from '../../../../src/main/utils/terminationSignals';

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const CHILD_PIDS = [101, 102, 103];

function createApp(pids: number[] = [process.pid, ...CHILD_PIDS]) {
    return {
        quit: vi.fn(),
        getAppMetrics: vi.fn(() => pids.map((pid) => ({ pid, type: 'Utility' }) as Electron.ProcessMetric)),
    };
}

function createLogger() {
    return { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

describe('isProcessRunning', () => {
    afterEach(() => {
        vi.mocked(fs.readFileSync).mockClear();
    });

    it.runIf(process.platform === 'linux')('is true for this process', () => {
        expect(isProcessRunning(process.pid)).toBe(true);
    });

    it('is false for a process that does not exist', () => {
        vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });

        expect(isProcessRunning(4194305)).toBe(false);
    });

    it.each([
        ['S', true],
        ['R', true],
        ['D', true],
        ['Z', false],
        ['X', false],
    ])('reads state %s as running: %s', (state, running) => {
        vi.mocked(fs.readFileSync).mockReturnValueOnce(`1234 (gemini-desktop) ${state} 1 1234 1234 0 -1`);

        expect(isProcessRunning(1234)).toBe(running);
        expect(fs.readFileSync).toHaveBeenCalledWith('/proc/1234/stat', 'utf8');
    });

    it('finds the state after a command name with spaces and parentheses', () => {
        vi.mocked(fs.readFileSync).mockReturnValueOnce('1234 (Web Content (2)) Z 1 1234 1234 0 -1');

        expect(isProcessRunning(1234)).toBe(false);
    });
});

describe('TerminationSignals', () => {
    let killSpy: ReturnType<typeof vi.spyOn>;
    let removeAllListenersSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
        removeAllListenersSpy = vi.spyOn(process, 'removeAllListeners').mockImplementation(() => process);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function expectExitBy(signal: string) {
        expect(removeAllListenersSpy).toHaveBeenCalledWith(signal);
        expect(killSpy).toHaveBeenCalledWith(process.pid, signal);
    }

    describe('install', () => {
        it('listens for SIGTERM, SIGINT and SIGHUP', () => {
            const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
            const app = createApp();

            new TerminationSignals(app, createLogger(), () => true).install();

            expect(TERMINATION_SIGNALS).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);
            expect(onSpy.mock.calls.map(([event]) => event)).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);

            const sigtermListener = onSpy.mock.calls[0][1] as () => void;
            sigtermListener();
            expect(app.quit).toHaveBeenCalledTimes(1);
        });
    });

    describe('handleSignal', () => {
        it.each(TERMINATION_SIGNALS)('quits normally on %s when the other processes are running', (signal) => {
            const app = createApp();
            const logger = createLogger();

            new TerminationSignals(app, logger, () => true).handleSignal(signal);

            expect(app.quit).toHaveBeenCalledTimes(1);
            expect(killSpy).not.toHaveBeenCalled();
            expect(logger.log).toHaveBeenCalledWith(`Received ${signal}, quitting`);
        });

        it.each(TERMINATION_SIGNALS)('exits at once by %s when another process is dying too', (signal) => {
            const app = createApp();

            new TerminationSignals(app, createLogger(), (pid) => pid !== 102).handleSignal(signal);

            expectExitBy(signal);
            expect(app.quit).not.toHaveBeenCalled();
        });

        it('does not count its own process', () => {
            const app = createApp();
            const isRunning = vi.fn((pid: number) => pid !== process.pid);

            new TerminationSignals(app, createLogger(), isRunning).handleSignal('SIGTERM');

            expect(app.quit).toHaveBeenCalledTimes(1);
            expect(isRunning).not.toHaveBeenCalledWith(process.pid);
        });

        it('exits at once on a second signal while quitting', () => {
            const app = createApp();
            const signals = new TerminationSignals(app, createLogger(), () => true);

            signals.handleSignal('SIGTERM');
            expect(killSpy).not.toHaveBeenCalled();

            signals.handleSignal('SIGINT');
            expectExitBy('SIGINT');
            expect(app.quit).toHaveBeenCalledTimes(1);
        });

        it('quits normally when the processes cannot be listed', () => {
            const app = createApp();
            app.getAppMetrics.mockImplementation(() => {
                throw new Error('not ready');
            });
            const logger = createLogger();

            new TerminationSignals(app, logger, () => true).handleSignal('SIGTERM');

            expect(app.quit).toHaveBeenCalledTimes(1);
            expect(logger.error).toHaveBeenCalledWith('Failed to check the app processes:', expect.any(Error));
        });
    });

    describe('handleProcessGone', () => {
        it.each(['killed', 'launch-failed'])(
            'exits by the quit signal when a process is %s while quitting',
            (reason) => {
                const signals = new TerminationSignals(createApp(), createLogger(), () => true);
                signals.handleSignal('SIGHUP');

                signals.handleProcessGone(reason);

                expectExitBy('SIGHUP');
            }
        );

        it.each(['clean-exit', 'crashed', 'oom', 'abnormal-exit'])(
            'keeps quitting normally when a process is gone with %s',
            (reason) => {
                const signals = new TerminationSignals(createApp(), createLogger(), () => true);
                signals.handleSignal('SIGTERM');

                signals.handleProcessGone(reason);

                expect(killSpy).not.toHaveBeenCalled();
            }
        );

        it('does nothing when no signal started a quit', () => {
            const app = createApp();
            const signals = new TerminationSignals(app, createLogger(), () => true);

            signals.handleProcessGone('killed');

            expect(killSpy).not.toHaveBeenCalled();
            expect(app.quit).not.toHaveBeenCalled();
        });
    });
});
