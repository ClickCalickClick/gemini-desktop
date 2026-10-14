/**
 * Unit tests for agent CLI discovery, with a fake PATH in a temporary folder.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    discoverEngine,
    findEngineBinary,
    findWindowsScriptLauncher,
    getSearchDirectories,
    readBinaryVersion,
} from '../../../../src/main/agent/engineDiscovery';
import { createTempLayout, fakePath, installFakeCli, type TempLayout } from './fakeCli';

describe('engineDiscovery', () => {
    let layout: TempLayout;

    beforeEach(() => {
        layout = createTempLayout();
    });

    afterEach(() => {
        layout.cleanup();
    });

    const environment = (pathValue: string, extraDirectories: string[] = []) => ({
        env: { PATH: pathValue },
        homeDir: layout.home,
        platform: 'linux' as NodeJS.Platform,
        extraDirectories,
    });

    describe('getSearchDirectories', () => {
        it('puts PATH first, then the usual install folders, without duplicates', () => {
            const dirs = getSearchDirectories({
                env: { PATH: '/usr/bin::/custom/bin' },
                homeDir: '/home/u',
                platform: 'linux',
            });
            expect(dirs.slice(0, 2)).toEqual(['/usr/bin', '/custom/bin']);
            expect(dirs).toContain('/home/u/.local/bin');
            expect(dirs).toContain('/usr/local/bin');
            expect(dirs).toContain('/opt/homebrew/bin');
            expect(dirs).toContain('/home/u/.npm-global/bin');
            expect(dirs.filter((dir) => dir === '/usr/bin')).toHaveLength(1);
        });

        it('uses Antigravity and npm folders on Windows', () => {
            const dirs = getSearchDirectories({
                env: { Path: 'C:\\Windows;c:\\windows', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
                homeDir: 'C:\\Users\\u',
                platform: 'win32',
            });
            expect(dirs).toEqual([
                'C:\\Windows',
                'C:\\Users\\u\\AppData\\Local\\agy\\bin',
                'C:\\Users\\u\\AppData\\Roaming\\npm',
            ]);
        });

        it('lets tests replace the install folders', () => {
            expect(
                getSearchDirectories({ env: {}, homeDir: '/h', platform: 'linux', extraDirectories: ['/x'] })
            ).toEqual(['/x']);
        });
    });

    describe('findEngineBinary', () => {
        it('finds an executable on PATH and ignores non-executable files and folders', async () => {
            const notExecutable = path.join(layout.root, 'plain');
            fs.mkdirSync(notExecutable);
            fs.writeFileSync(path.join(notExecutable, 'agy'), 'x', { mode: 0o644 });
            fs.mkdirSync(path.join(layout.root, 'dir', 'agy'), { recursive: true });
            const agy = installFakeCli(layout.bin, 'agy');

            const found = await findEngineBinary(
                'antigravity',
                environment([notExecutable, path.join(layout.root, 'dir'), layout.bin].join(':'))
            );
            expect(found).toBe(agy);
        });

        it('finds a binary in an install folder that is not on PATH', async () => {
            const localBin = path.join(layout.home, '.local', 'bin');
            fs.mkdirSync(localBin, { recursive: true });
            const agy = installFakeCli(localBin, 'agy');
            expect(await findEngineBinary('antigravity', environment('', [localBin]))).toBe(agy);
        });
    });

    describe('discoverEngine', () => {
        it('prefers Antigravity in auto mode and reads the version', async () => {
            const agy = installFakeCli(layout.bin, 'agy');
            installFakeCli(layout.bin, 'gemini');
            const status = await discoverEngine('auto', {
                ...environment(layout.bin),
                readVersion: async () => 'agy 9.9',
            });
            expect(status).toEqual({ engine: 'antigravity', available: true, path: agy, version: 'agy 9.9' });
        });

        it('falls back to Gemini CLI in auto mode', async () => {
            const gemini = installFakeCli(layout.bin, 'gemini');
            const status = await discoverEngine('auto', {
                ...environment(layout.bin),
                readVersion: async () => undefined,
            });
            expect(status).toEqual({ engine: 'gemini-cli', available: true, path: gemini });
        });

        it('only looks for the chosen engine', async () => {
            installFakeCli(layout.bin, 'gemini');
            const status = await discoverEngine('antigravity', {
                ...environment(layout.bin),
                readVersion: async () => undefined,
            });
            expect(status.available).toBe(false);
            expect(status.engine).toBeNull();
            expect(status.error).toContain('Antigravity CLI (agy) was not found');
        });

        it('explains how to install an engine when none is found', async () => {
            const status = await discoverEngine('auto', environment(layout.bin));
            expect(status).toMatchObject({ engine: null, available: false });
            expect(status.error).toContain('No agent CLI was found');
            expect(status.error).toContain('agy');
            expect(status.error).toContain('GEMINI_API_KEY');
        });

        it('reads the version by running the binary with --version', async () => {
            const agy = installFakeCli(layout.bin, 'agy');
            const status = await discoverEngine('antigravity', {
                ...environment(fakePath(layout.bin)),
                env: { PATH: fakePath(layout.bin) },
            });
            expect(status.path).toBe(agy);
            expect(status.version).toBe('agy 1.2.3');
        });
    });

    describe('discoverEngine with a settings check', () => {
        it('skips a refused engine and uses the next one', async () => {
            installFakeCli(layout.bin, 'agy');
            const gemini = installFakeCli(layout.bin, 'gemini');
            const status = await discoverEngine('auto', {
                ...environment(layout.bin),
                readVersion: async () => undefined,
                checkEngine: async (engine) => (engine === 'antigravity' ? 'agy settings allow too much' : null),
            });
            expect(status).toEqual({ engine: 'gemini-cli', available: true, path: gemini });
        });

        it("reports the first refused engine's reason when none is usable", async () => {
            const agy = installFakeCli(layout.bin, 'agy');
            const status = await discoverEngine('auto', {
                ...environment(layout.bin),
                readVersion: async () => '1.0',
                checkEngine: async () => 'settings allow too much',
            });
            expect(status).toEqual({
                engine: 'antigravity',
                available: false,
                path: agy,
                version: '1.0',
                error: 'settings allow too much',
            });
        });
    });

    describe('findWindowsScriptLauncher', () => {
        it('finds a .cmd launcher on Windows only and explains it is not started', async () => {
            const npmDir = path.join(layout.root, 'npm');
            fs.mkdirSync(npmDir);
            fs.writeFileSync(path.join(npmDir, 'gemini.cmd'), '@echo off');
            const windows = {
                env: { Path: npmDir },
                homeDir: layout.home,
                platform: 'win32' as NodeJS.Platform,
                extraDirectories: [],
            };
            expect(await findWindowsScriptLauncher('gemini-cli', windows)).toContain('gemini.cmd');
            expect(await findWindowsScriptLauncher('antigravity', windows)).toBeNull();
            expect(await findWindowsScriptLauncher('gemini-cli', { ...windows, platform: 'linux' })).toBeNull();

            const status = await discoverEngine('gemini-cli', { ...windows, readVersion: async () => undefined });
            expect(status.available).toBe(false);
            expect(status.error).toContain('was not found');
            expect(status.error).toContain('gemini.cmd');
            expect(status.error).toContain('command shell');
        });
    });

    describe('readBinaryVersion', () => {
        it('returns undefined when the binary fails or does not exist', async () => {
            const failing = path.join(layout.bin, 'failing');
            fs.writeFileSync(failing, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
            expect(await readBinaryVersion(failing)).toBeUndefined();
            expect(await readBinaryVersion(path.join(layout.bin, 'missing'))).toBeUndefined();
        });

        it('returns undefined for empty output', async () => {
            const silent = path.join(layout.bin, 'silent');
            fs.writeFileSync(silent, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            expect(await readBinaryVersion(silent)).toBeUndefined();
        });
    });
});
