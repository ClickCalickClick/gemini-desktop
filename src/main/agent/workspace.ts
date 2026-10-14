/**
 * The agent's scratch workspace and the safety checks around it.
 *
 * Agent runs use an app-owned folder as their working directory. Antigravity CLI and
 * Gemini CLI only let their file tools write inside the active workspace without asking,
 * and in headless mode anything that would ask is refused, so with the CLIs' default
 * permissions an agent run cannot change the user's files. The app never widens those
 * permissions, and refuses to run a CLI whose user or system settings do.
 *
 * @module agent/workspace
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentEngineId } from '../../shared/types/agent';
import { isObject } from './json';

/**
 * Empty the workspace and make it a Git root of its own, so a CLI that looks for the
 * enclosing repository (a home folder kept in Git, for example) stops at the workspace.
 *
 * Everything an earlier run left behind is removed, `.git` included: instructions
 * (`GEMINI.md`, `.agents/` rules, workflows and skills), `.env` files, settings files and
 * other runs' input copies would otherwise steer the next run.
 */
export async function prepareWorkspace(workspaceDir: string): Promise<void> {
    if (!path.isAbsolute(workspaceDir) || path.resolve(workspaceDir) === path.parse(workspaceDir).root) {
        throw new Error('Invalid agent workspace.');
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
    const gitDir = path.join(workspaceDir, '.git');
    await fs.mkdir(path.join(gitDir, 'objects'), { recursive: true });
    await fs.mkdir(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
}

/** Remove a run's input copies once the run has finished. */
export async function removeRunInputs(workspaceDir: string, runId: string): Promise<void> {
    if (!/^[A-Za-z0-9-]+$/.test(runId)) {
        return;
    }
    await fs.rm(path.join(workspaceDir, 'inputs', runId), { recursive: true, force: true });
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

async function readSettingsFile(file: string): Promise<unknown> {
    let text: string;
    try {
        text = await fs.readFile(file, 'utf8');
    } catch {
        return undefined;
    }
    try {
        return parseLenientJson(text);
    } catch {
        return undefined;
    }
}

const MAX_WALK_DEPTH = 12;

/** Visit every object in a JSON value with its key, depth first. */
function walkObjects(value: unknown, visit: (key: string, value: unknown) => void, depth = 0): void {
    if (depth > MAX_WALK_DEPTH) {
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            walkObjects(item, visit, depth + 1);
        }
        return;
    }
    if (!isObject(value)) {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        visit(key, child);
        walkObjects(child, visit, depth + 1);
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
 * Permission presets that let Antigravity run tools without asking. `proceed-in-sandbox`
 * is included on every platform: the docs do not say which folders besides the workspace
 * the sandbox lets commands write (the desktop app's sandbox preset also allows temporary
 * folders), nor how the sandbox works on Windows.
 */
const RISKY_ANTIGRAVITY_MODES = ['always-proceed', 'proceed-in-sandbox', 'turbo'];

/** Antigravity allow rules that let a run change things outside its workspace. */
function isRiskyAntigravityRule(rule: string): boolean {
    const match = /^\s*([a-z_]+)\s*\((.*)\)\s*$/i.exec(rule);
    if (!match) {
        return false;
    }
    const action = (match[1] ?? '').toLowerCase();
    const target = (match[2] ?? '').trim();
    switch (action) {
        case 'write_file':
            return !isWorkspaceRelative(target);
        case 'command':
            return target === '*' || target.startsWith('regex:');
        case 'unsandboxed':
        case 'mcp':
            return true;
        default:
            return false;
    }
}

function antigravityFindings(settings: unknown): string[] {
    const findings: string[] = [];
    walkObjects(settings, (key, value) => {
        if (
            typeof value === 'string' &&
            /permission|preset|mode/i.test(key) &&
            RISKY_ANTIGRAVITY_MODES.includes(value.toLowerCase())
        ) {
            findings.push(`"${key}": "${value}"`);
        } else if (key === 'allowNonWorkspaceAccess' && value === true) {
            findings.push('"allowNonWorkspaceAccess": true');
        } else if (/^allow(ed|list)?$/i.test(key) && Array.isArray(value)) {
            for (const rule of value) {
                if (typeof rule === 'string' && isRiskyAntigravityRule(rule)) {
                    findings.push(rule.trim());
                }
            }
        }
    });
    return findings;
}

/** Gemini CLI tools that change files or run commands. */
const GEMINI_CHANGING_TOOLS = new Set([
    'run_shell_command',
    'shelltool',
    'shell',
    'write_file',
    'writefiletool',
    'replace',
    'edit',
    'edittool',
    'smart_edit',
]);

function geminiFindings(settings: unknown): string[] {
    const findings: string[] = [];
    walkObjects(settings, (key, value) => {
        if ((key === 'allowed' || key === 'allowedTools') && Array.isArray(value)) {
            // tools.allowed: tools that run without asking.
            for (const entry of value) {
                const name = typeof entry === 'string' ? (entry.split('(')[0] ?? '').trim().toLowerCase() : '';
                if (GEMINI_CHANGING_TOOLS.has(name)) {
                    findings.push(`"${key}": "${String(entry)}"`);
                }
            }
        } else if (key === 'includeDirectories' && Array.isArray(value) && value.length > 0) {
            findings.push('"includeDirectories"');
        } else if ((key === 'autoAccept' || key === 'yolo') && value === true) {
            findings.push(`"${key}": true`);
        } else if (
            /approvalmode/i.test(key) &&
            typeof value === 'string' &&
            ['yolo', 'auto_edit'].includes(value.toLowerCase())
        ) {
            findings.push(`"${key}": "${value}"`);
        } else if (key === 'trust' && value === true) {
            // mcpServers.<name>.trust skips confirmation for that server's tools.
            findings.push('"trust": true (MCP server)');
        }
    });
    // coreTools only limits which tools exist; it does not approve them, so it is not flagged.
    return findings;
}

/** Settings files each engine reads, user first, then system-wide. */
export function settingsFilesFor(
    engine: AgentEngineId,
    homeDir: string,
    platform: NodeJS.Platform = os.platform()
): string[] {
    if (engine === 'antigravity') {
        return [
            path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'),
            // Permission grants stored by the Antigravity desktop app, which the CLI also reads.
            path.join(homeDir, '.gemini', 'config', 'config.json'),
        ];
    }
    const system =
        platform === 'darwin'
            ? '/Library/Application Support/GeminiCli/settings.json'
            : platform === 'win32'
              ? 'C:\\ProgramData\\gemini-cli\\settings.json'
              : '/etc/gemini-cli/settings.json';
    return [path.join(homeDir, '.gemini', 'settings.json'), system];
}

export interface RiskySettings {
    file: string;
    findings: string[];
}

/**
 * Find settings that would let a run change files outside its workspace without asking.
 * The files are only read, never changed; files that are missing or not JSON are skipped.
 *
 * Antigravity: permission presets other than asking (`always-proceed`,
 * `proceed-in-sandbox`, Turbo), `allowNonWorkspaceAccess: true`, and allow rules
 * `write_file(...)` outside the workspace, `command(*)`, `command(regex:...)`,
 * `unsandboxed(...)` and `mcp(...)`. Allow rules for specific command prefixes are the
 * user's choice and stay allowed.
 *
 * Gemini CLI: shell or file-writing tools in `tools.allowed`, `includeDirectories`,
 * `autoAccept`, YOLO or auto-edit approval modes, and trusted MCP servers.
 */
export async function findRiskySettings(engine: AgentEngineId, files: string[]): Promise<RiskySettings[]> {
    const result: RiskySettings[] = [];
    for (const file of files) {
        const settings = await readSettingsFile(file);
        if (settings === undefined) {
            continue;
        }
        const findings = engine === 'antigravity' ? antigravityFindings(settings) : geminiFindings(settings);
        if (findings.length > 0) {
            result.push({ file, findings: [...new Set(findings)] });
        }
    }
    return result;
}

/** User-facing message for {@link findRiskySettings} results. */
export function describeRiskySettings(engine: AgentEngineId, risky: RiskySettings[]): string {
    const name = engine === 'antigravity' ? 'Antigravity CLI' : 'Gemini CLI';
    const details = risky.map(({ file, findings }) => `${file}: ${findings.join(', ')}`).join('; ');
    return (
        `${name}'s settings let the agent run tools or change files outside its workspace without asking (${details}). ` +
        'Quick Chat only uses an agent whose changes to your files go through a plan you confirm, so remove these settings to use it.'
    );
}
