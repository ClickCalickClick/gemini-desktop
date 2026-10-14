/**
 * Finds the agent CLIs (Antigravity CLI `agy`, Gemini CLI `gemini`) on this machine.
 *
 * Apps started from a desktop launcher often get a short PATH, so besides PATH this
 * looks in the usual per-user and system install folders.
 *
 * @module agent/engineDiscovery
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentEngineId, AgentEnginePreference, AgentEngineStatus } from '../../shared/types/agent';

/** Binary name of each engine (without a Windows extension). */
export const ENGINE_BINARIES: Record<AgentEngineId, string> = {
    antigravity: 'agy',
    'gemini-cli': 'gemini',
};

/** Display name of each engine, for messages. */
export const ENGINE_NAMES: Record<AgentEngineId, string> = {
    antigravity: 'Antigravity CLI (agy)',
    'gemini-cli': 'Gemini CLI (gemini)',
};

/** Engines tried for each preference, in order. */
export const ENGINE_ORDER: Record<AgentEnginePreference, AgentEngineId[]> = {
    auto: ['antigravity', 'gemini-cli'],
    antigravity: ['antigravity'],
    'gemini-cli': ['gemini-cli'],
};

export const VERSION_TIMEOUT_MS = 5000;

const INSTALL_HINT =
    'Install Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash) and run `agy` once in a terminal to sign in, ' +
    'or install Gemini CLI (npm install -g @google/gemini-cli) and set GEMINI_API_KEY.';

export interface DiscoveryEnvironment {
    /** Environment to read PATH (and on Windows LOCALAPPDATA/APPDATA) from. */
    env: NodeJS.ProcessEnv;
    homeDir: string;
    platform: NodeJS.Platform;
    /** Replaces the usual install folders (tests). */
    extraDirectories?: string[];
}

export interface DiscoveryOptions extends DiscoveryEnvironment {
    /** Reads a binary's version; replaceable in tests. */
    readVersion?: (binaryPath: string) => Promise<string | undefined>;
    /**
     * Returns why a found engine must not be used (its settings allow too much), or null.
     * A refused engine is skipped; when no other engine is usable, its message is reported.
     */
    checkEngine?: (engine: AgentEngineId) => Promise<string | null>;
}

/**
 * Folders to search, in order: PATH first, then the usual install folders.
 * Duplicates are removed.
 */
export function getSearchDirectories({ env, homeDir, platform, extraDirectories }: DiscoveryEnvironment): string[] {
    const delimiter = platform === 'win32' ? ';' : ':';
    const pathEntries = (env.PATH ?? env.Path ?? '').split(delimiter).filter((entry) => entry.trim().length > 0);

    const extra: string[] = [];
    if (extraDirectories) {
        extra.push(...extraDirectories);
    } else if (platform === 'win32') {
        const localAppData = env.LOCALAPPDATA ?? path.win32.join(homeDir, 'AppData', 'Local');
        const appData = env.APPDATA ?? path.win32.join(homeDir, 'AppData', 'Roaming');
        // Antigravity's documented Windows install folder, then npm's global folder.
        extra.push(path.win32.join(localAppData, 'agy', 'bin'), path.win32.join(appData, 'npm'));
    } else {
        extra.push(
            // Antigravity's documented install folder on macOS and Linux.
            path.posix.join(homeDir, '.local', 'bin'),
            '/usr/local/bin',
            '/usr/bin',
            '/opt/homebrew/bin',
            path.posix.join(homeDir, '.npm-global', 'bin'),
            path.posix.join(homeDir, '.bun', 'bin'),
            path.posix.join(homeDir, '.volta', 'bin')
        );
    }

    const seen = new Set<string>();
    const result: string[] = [];
    for (const dir of [...pathEntries, ...extra]) {
        const key = platform === 'win32' ? dir.toLowerCase() : dir;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(dir);
        }
    }
    return result;
}

async function isExecutableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
    try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) {
            return false;
        }
        if (platform !== 'win32') {
            await fs.access(candidate, fs.constants.X_OK);
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Find an engine's binary. On Windows only `.exe` files are accepted: `.cmd` and `.bat`
 * shims cannot be started without a shell, and the app never starts the agent through one.
 */
export async function findEngineBinary(
    engine: AgentEngineId,
    environment: DiscoveryEnvironment
): Promise<string | null> {
    const name = ENGINE_BINARIES[engine];
    const fileNames = environment.platform === 'win32' ? [`${name}.exe`] : [name];

    for (const dir of getSearchDirectories(environment)) {
        for (const fileName of fileNames) {
            // The file system is the running one, so use its own path rules.
            const candidate = path.join(dir, fileName);
            if (await isExecutableFile(candidate, environment.platform)) {
                return candidate;
            }
        }
    }
    return null;
}

/**
 * On Windows, find a script launcher (`gemini.cmd` from npm, for example) that the app
 * does not start: it would need a command shell, and the prompt must never go through one.
 */
export async function findWindowsScriptLauncher(
    engine: AgentEngineId,
    environment: DiscoveryEnvironment
): Promise<string | null> {
    if (environment.platform !== 'win32') {
        return null;
    }
    const name = ENGINE_BINARIES[engine];
    for (const dir of getSearchDirectories(environment)) {
        for (const extension of ['.cmd', '.bat', '.ps1']) {
            const candidate = path.join(dir, `${name}${extension}`);
            if (await isExecutableFile(candidate, 'win32')) {
                return candidate;
            }
        }
    }
    return null;
}

/** Run `<binary> --version` with a short timeout and return its first line. */
export function readBinaryVersion(
    binaryPath: string,
    env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
    return new Promise((resolve) => {
        try {
            execFile(
                binaryPath,
                ['--version'],
                { timeout: VERSION_TIMEOUT_MS, windowsHide: true, env, maxBuffer: 64 * 1024 },
                (error, stdout) => {
                    if (error) {
                        resolve(undefined);
                        return;
                    }
                    const firstLine = String(stdout)
                        .split(/\r?\n/)
                        .map((line) => line.trim())
                        .find((line) => line.length > 0);
                    resolve(firstLine ? firstLine.slice(0, 100) : undefined);
                }
            );
        } catch {
            resolve(undefined);
        }
    });
}

/**
 * Resolve the engine to use for a preference: 'auto' prefers Antigravity, then Gemini CLI.
 */
export async function discoverEngine(
    preference: AgentEnginePreference,
    options: DiscoveryOptions
): Promise<AgentEngineStatus> {
    const readVersion = options.readVersion ?? ((binaryPath: string) => readBinaryVersion(binaryPath, options.env));
    const order = ENGINE_ORDER[preference] ?? ENGINE_ORDER.auto;

    let refused: AgentEngineStatus | null = null;
    const launcherNotes: string[] = [];
    for (const engine of order) {
        const binaryPath = await findEngineBinary(engine, options);
        if (!binaryPath) {
            const launcher = await findWindowsScriptLauncher(engine, options);
            if (launcher) {
                launcherNotes.push(
                    `${ENGINE_NAMES[engine]} is installed as ${launcher}, a script the app does not start ` +
                        'because it needs a command shell and your prompt must not pass through one.'
                );
            }
            continue;
        }
        const version = await readVersion(binaryPath);
        const status: AgentEngineStatus = {
            engine,
            available: true,
            path: binaryPath,
            ...(version ? { version } : {}),
        };
        const reason = options.checkEngine ? await options.checkEngine(engine) : null;
        if (!reason) {
            return status;
        }
        refused ??= { ...status, available: false, error: reason };
    }
    if (refused) {
        return refused;
    }

    const base =
        preference === 'auto'
            ? `No agent CLI was found. ${INSTALL_HINT}`
            : `${ENGINE_NAMES[preference]} was not found on PATH or in the usual install folders. ${INSTALL_HINT}`;
    const error = launcherNotes.length > 0 ? `${base} ${launcherNotes.join(' ')}` : base;
    return { engine: null, available: false, error };
}
