/**
 * The agent's scratch workspace and the safety checks around it.
 *
 * Agent runs use an app-owned folder as their working directory. Antigravity CLI and
 * Gemini CLI only let their file tools write inside the active workspace without asking,
 * and in headless mode anything that would ask is refused, so with the CLIs' default
 * permissions an agent run cannot change the user's files. The app never widens those
 * permissions, and refuses to run Antigravity CLI when the user's global settings do.
 *
 * @module agent/workspace
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Settings files a run could leave in the workspace to change the next run's permissions. */
const WORKSPACE_SETTINGS_FILES = [
    ['.gemini', 'settings.json'],
    ['.gemini', 'antigravity-cli', 'settings.json'],
    ['.antigravity', 'settings.json'],
    ['.agents', 'settings.json'],
];

/** Input copies older than this are removed when a new run starts. */
const INPUTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Create the workspace and make it a Git root of its own, so a CLI that looks for the
 * enclosing repository (a home folder kept in Git, for example) stops at the workspace.
 * Also removes per-workspace settings files an earlier run may have written.
 */
export async function prepareWorkspace(workspaceDir: string, now: number = Date.now()): Promise<void> {
    await fs.mkdir(workspaceDir, { recursive: true });

    const gitDir = path.join(workspaceDir, '.git');
    try {
        await fs.access(path.join(gitDir, 'HEAD'));
    } catch {
        await fs.mkdir(path.join(gitDir, 'objects'), { recursive: true });
        await fs.mkdir(path.join(gitDir, 'refs', 'heads'), { recursive: true });
        await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    }

    for (const segments of WORKSPACE_SETTINGS_FILES) {
        await fs.rm(path.join(workspaceDir, ...segments), { force: true });
    }

    const inputsDir = path.join(workspaceDir, 'inputs');
    let entries: string[] = [];
    try {
        entries = await fs.readdir(inputsDir);
    } catch {
        return;
    }
    for (const entry of entries) {
        const entryPath = path.join(inputsDir, entry);
        try {
            const stat = await fs.lstat(entryPath);
            if (now - stat.mtimeMs > INPUTS_MAX_AGE_MS) {
                await fs.rm(entryPath, { recursive: true, force: true });
            }
        } catch {
            // Already gone.
        }
    }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse JSON that may contain `//` line comments. */
function parseLenientJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        const withoutComments = text
            .split(/\r?\n/)
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        return JSON.parse(withoutComments);
    }
}

/** True for a write_file target that stays inside the workspace (a relative path without `..`). */
function isWorkspaceRelative(target: string): boolean {
    const trimmed = target.trim();
    if (trimmed === '' || trimmed === '*' || trimmed.startsWith('~') || path.isAbsolute(trimmed)) {
        return false;
    }
    if (/^[A-Za-z]:/.test(trimmed)) {
        return false;
    }
    return !trimmed.split(/[\\/]/).includes('..');
}

/**
 * Find global Antigravity CLI settings that would let a run change files outside its
 * workspace without asking. The settings file is only read, never changed.
 *
 * Blocking: `toolPermission: "always-proceed"`, `allowNonWorkspaceAccess: true`, and
 * allow rules `write_file(...)` outside the workspace, `command(*)`, `command(regex:...)`
 * and `unsandboxed(...)`. Allow rules for specific command prefixes are the user's choice
 * and stay allowed.
 */
export async function findRiskyAntigravitySettings(homeDir: string): Promise<string[]> {
    const settingsPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
    let text: string;
    try {
        text = await fs.readFile(settingsPath, 'utf8');
    } catch {
        return [];
    }

    let settings: unknown;
    try {
        settings = parseLenientJson(text);
    } catch {
        return [];
    }
    if (!isObject(settings)) {
        return [];
    }

    const findings: string[] = [];
    if (settings.toolPermission === 'always-proceed') {
        findings.push('"toolPermission": "always-proceed"');
    }
    if (settings.allowNonWorkspaceAccess === true) {
        findings.push('"allowNonWorkspaceAccess": true');
    }

    const permissions = isObject(settings.permissions) ? settings.permissions : {};
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    for (const rule of allow) {
        if (typeof rule !== 'string') {
            continue;
        }
        const match = /^\s*([a-z_]+)\s*\((.*)\)\s*$/i.exec(rule);
        if (!match) {
            continue;
        }
        const action = (match[1] ?? '').toLowerCase();
        const target = (match[2] ?? '').trim();
        if (action === 'write_file' && !isWorkspaceRelative(target)) {
            findings.push(rule.trim());
        } else if (action === 'command' && (target === '*' || target.startsWith('regex:'))) {
            findings.push(rule.trim());
        } else if (action === 'unsandboxed') {
            findings.push(rule.trim());
        }
    }
    return findings;
}

/** User-facing message for {@link findRiskyAntigravitySettings} findings. */
export function describeRiskySettings(findings: string[]): string {
    return (
        `Antigravity CLI's settings (~/.gemini/antigravity-cli/settings.json) let the agent change files outside its workspace ` +
        `without asking: ${findings.join(', ')}. Quick Chat only runs the agent when changes to your files go through a plan ` +
        `you confirm, so remove these settings to use it.`
    );
}
