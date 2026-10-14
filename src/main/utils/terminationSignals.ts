/**
 * Quitting on SIGTERM, SIGINT and SIGHUP on Linux.
 *
 * Electron quits gracefully on these signals by itself. A logout, a shutdown or
 * `pkill gemini-desktop` send the signal to every process of the app at once, though, and the
 * zygote processes die with the others. Chromium cannot start a new GPU process without them,
 * and it ends the app with "GPU process isn't usable. Goodbye." before the quit finishes: a crash,
 * which can keep the app writing a core dump until the system kills it
 * (https://github.com/electron/electron/issues/54547).
 *
 * These handlers take over from Electron's once the app is ready. When the app's other processes
 * are dying too, the app ends at once by the same signal, before Chromium tries to restart them.
 * Otherwise it quits as Electron would, which saves cookies and other session data first.
 *
 * @module TerminationSignals
 */

import * as fs from 'fs';
import type { Logger } from '../types';

export const TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

export type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];

/** Why a child process or renderer was gone when a signal ended it, or when it could not start */
const SIGNAL_GONE_REASONS = new Set(['killed', 'launch-failed']);

/**
 * Whether a process is running, from its state in /proc/<pid>/stat.
 * A process that is gone, or a zombie waiting to be reaped, is not.
 */
export function isProcessRunning(pid: number): boolean {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // The state follows the command name, which is in parentheses and may contain spaces
        const state = stat.charAt(stat.lastIndexOf(')') + 2);
        return state !== 'Z' && state !== 'X';
    } catch {
        return false;
    }
}

export default class TerminationSignals {
    /** The signal that started the quit, if one did */
    private quitSignal: TerminationSignal | null = null;

    /**
     * @param app - Electron's app
     * @param logger - Logger for the main process
     * @param isRunning - Whether a process is running; replaceable in tests
     */
    constructor(
        private readonly app: Pick<Electron.App, 'quit' | 'getAppMetrics'>,
        private readonly logger: Logger,
        private readonly isRunning: (pid: number) => boolean = isProcessRunning
    ) {}

    /**
     * Take the signals over from Electron. Call it once the app is ready: Electron installs its
     * own handlers while it starts, and a listener added before them never runs.
     */
    install(): void {
        for (const signal of TERMINATION_SIGNALS) {
            process.on(signal, () => this.handleSignal(signal));
        }
    }

    /**
     * Quit, or end at once when the signal reached the app's other processes too or came again.
     * @param signal - The signal received
     */
    handleSignal(signal: TerminationSignal): void {
        if (this.quitSignal) {
            this.exitBySignal(signal, 'it came again while quitting');
            return;
        }
        if (this.otherProcessesDying()) {
            this.exitBySignal(signal, "the app's other processes got it too");
            return;
        }
        this.logger.log(`Received ${signal}, quitting`);
        this.quitSignal = signal;
        this.app.quit();
    }

    /**
     * Call when a child process or renderer is gone. One that a signal ended while a signal
     * quits the app means the signal reached every process of the app.
     * @param reason - The reason Electron gives for the process being gone
     */
    handleProcessGone(reason: string): void {
        if (this.quitSignal && SIGNAL_GONE_REASONS.has(reason)) {
            this.exitBySignal(this.quitSignal, `a child process was gone (${reason}) while quitting`);
        }
    }

    private otherProcessesDying(): boolean {
        try {
            return this.app.getAppMetrics().some((metric) => metric.pid !== process.pid && !this.isRunning(metric.pid));
        } catch (error) {
            this.logger.error('Failed to check the app processes:', error);
            return false;
        }
    }

    /** End the app through the signal's default action, which stops it at once */
    private exitBySignal(signal: TerminationSignal, why: string): void {
        this.logger.log(`Received ${signal}; exiting now because ${why}`);
        // Without listeners, the signal's default action applies again
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
    }
}
