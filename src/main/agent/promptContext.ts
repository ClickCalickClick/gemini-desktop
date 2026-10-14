/**
 * Read-only context the app gathers for an agent run, and the prompt wrapped around the
 * user's request.
 *
 * The agent works in a scratch workspace and cannot read the user's files. Instead the
 * app finds the folders and files a prompt names (paths, `~/...`, "Downloads", ...),
 * lists them (names, sizes, dates; one or two levels, capped) and, for questions about
 * a single file, puts a copy of that file into the workspace for the agent to read.
 *
 * @module agent/promptContext
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { checkPathReal, type PathPolicy } from './filePlan';
import type { AgentEngineId, AgentTaskCategory } from '../../shared/types/agent';

/** Well-known folders, as names for Electron's `app.getPath`. */
export type WellKnownFolder = 'home' | 'downloads' | 'documents' | 'pictures' | 'desktop' | 'music' | 'videos';

export interface ContextOptions extends PathPolicy {
    platform: NodeJS.Platform;
    /** Resolve a well-known folder (Electron `app.getPath`). */
    getFolder: (name: WellKnownFolder) => string | null;
    /** Folder in the workspace to copy referenced files into, for this run. */
    inputsDir: string;
    /** Path of `inputsDir` relative to the workspace, as the agent should use it. */
    inputsRelativeDir: string;
    category: AgentTaskCategory;
    maxContextChars?: number;
}

export interface GatheredContext {
    /** Text describing the folders and files, or '' when the prompt names none. */
    text: string;
    /** Number of folders and files described. */
    locations: number;
    /** Number of files copied into the workspace. */
    copiedFiles: number;
}

const FOLDER_WORDS: { pattern: RegExp; folder: WellKnownFolder }[] = [
    { pattern: /\bdownloads\b|\bdownload folder\b/i, folder: 'downloads' },
    { pattern: /\bdocuments\b|\bdocs folder\b/i, folder: 'documents' },
    { pattern: /\bpictures\b|\bphotos folder\b/i, folder: 'pictures' },
    { pattern: /\bdesktop folder\b|\bon my desktop\b|\bmy desktop\b/i, folder: 'desktop' },
    { pattern: /\bmusic folder\b|\bmy music\b/i, folder: 'music' },
    { pattern: /\bvideos\b/i, folder: 'videos' },
    { pattern: /\bhome (?:folder|directory)\b/i, folder: 'home' },
];

const MAX_LOCATIONS = 6;
const MAX_ENTRIES_PER_FOLDER = 200;
const MAX_TOTAL_ENTRIES = 600;
const MAX_COPIED_FILES = 5;
const MAX_COPY_BYTES = 25 * 1024 * 1024;
/** Windows limits a whole command line to 32,767 characters. */
export const DEFAULT_MAX_CONTEXT_CHARS = 40_000;
export const WINDOWS_MAX_CONTEXT_CHARS = 8_000;

const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/** Paths written in a prompt: quoted paths, `~/...`, absolute paths (and `C:\...` on Windows). */
export function extractPathCandidates(prompt: string, homeDir: string, platform: NodeJS.Platform): string[] {
    const found: string[] = [];
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const add = (raw: string): void => {
        let candidate = raw.trim().replace(TRAILING_PUNCTUATION, '');
        if (candidate === '~') {
            candidate = homeDir;
        } else if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
            candidate = paths.join(homeDir, candidate.slice(2));
        }
        if (candidate.length > 1 && paths.isAbsolute(candidate)) {
            found.push(paths.resolve(candidate));
        }
    };

    const quoted = /["'`“‘]((?:~|\/|[A-Za-z]:\\)[^"'`”’\n]*)["'`”’]/g;
    for (const match of prompt.matchAll(quoted)) {
        add(match[1] ?? '');
    }
    const unquotedSource =
        platform === 'win32' ? /(?:^|[\s(])((?:~[\\/]?|[A-Za-z]:\\)[^\s"'`]*)/g : /(?:^|[\s(])((?:~\/?|\/)[^\s"'`]*)/g;
    for (const match of prompt.replace(quoted, ' ').matchAll(unquotedSource)) {
        add(match[1] ?? '');
    }
    return [...new Set(found)];
}

/** Well-known folders a prompt mentions by name. */
export function extractFolderMentions(prompt: string): WellKnownFolder[] {
    return FOLDER_WORDS.filter(({ pattern }) => pattern.test(prompt)).map(({ folder }) => folder);
}

function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** True when a folder may be read: inside home (or home itself) and not hidden. */
async function isReadableLocation(target: string, policy: PathPolicy): Promise<boolean> {
    let realTarget: string;
    let realHome: string;
    try {
        realTarget = await fs.realpath(target);
        realHome = await fs.realpath(policy.homeDir);
    } catch {
        return false;
    }
    if (realTarget === realHome) {
        return true;
    }
    // Both the path as written and the place a symbolic link leads to must be allowed.
    return (
        (await checkPathReal(target, policy)) === null &&
        (await checkPathReal(realTarget, { ...policy, homeDir: realHome })) === null
    );
}

interface ListingBudget {
    remaining: number;
}

async function listFolder(dir: string, depth: number, indent: string, budget: ListingBudget): Promise<string[]> {
    let names: string[];
    try {
        names = (await fs.readdir(dir)).filter((name) => !name.startsWith('.')).sort((a, b) => a.localeCompare(b));
    } catch {
        return [`${indent}(could not be read)`];
    }
    const lines: string[] = [];
    const shown = names.slice(0, MAX_ENTRIES_PER_FOLDER);
    for (const name of shown) {
        if (budget.remaining <= 0) {
            lines.push(`${indent}… listing cut short`);
            return lines;
        }
        budget.remaining--;
        const entryPath = path.join(dir, name);
        try {
            const stat = await fs.lstat(entryPath);
            if (stat.isDirectory()) {
                lines.push(`${indent}- ${entryPath}/  (folder, modified ${formatDate(stat.mtimeMs)})`);
                if (depth > 1) {
                    lines.push(...(await listFolder(entryPath, depth - 1, `${indent}  `, budget)));
                }
            } else if (stat.isSymbolicLink()) {
                lines.push(`${indent}- ${entryPath}  (link)`);
            } else {
                lines.push(`${indent}- ${entryPath}  (${formatSize(stat.size)}, modified ${formatDate(stat.mtimeMs)})`);
            }
        } catch {
            lines.push(`${indent}- ${entryPath}  (could not be read)`);
        }
    }
    if (names.length > shown.length) {
        lines.push(`${indent}… and ${names.length - shown.length} more`);
    }
    return lines;
}

/**
 * Describe the folders and files a prompt names. Files are copied into the run's inputs
 * folder (except for file tasks, which only need names) so the agent can read them.
 */
export async function gatherContext(prompt: string, options: ContextOptions): Promise<GatheredContext> {
    const maxChars =
        options.maxContextChars ??
        (options.platform === 'win32' ? WINDOWS_MAX_CONTEXT_CHARS : DEFAULT_MAX_CONTEXT_CHARS);

    const locations = new Set<string>();
    for (const folder of extractFolderMentions(prompt)) {
        const resolved = folder === 'home' ? options.homeDir : options.getFolder(folder);
        if (resolved) {
            locations.add(path.resolve(resolved));
        }
    }
    for (const candidate of extractPathCandidates(prompt, options.homeDir, options.platform)) {
        locations.add(candidate);
    }

    const sections: string[] = [];
    const budget: ListingBudget = { remaining: MAX_TOTAL_ENTRIES };
    const depth = options.category === 'files' ? 2 : 1;
    let copiedFiles = 0;
    let described = 0;

    for (const location of [...locations].slice(0, MAX_LOCATIONS)) {
        let stat;
        try {
            stat = await fs.stat(location);
        } catch {
            continue;
        }
        if (!(await isReadableLocation(location, options))) {
            sections.push(`${location}: not shown (outside your home folder or in a hidden folder).`);
            continue;
        }
        described++;
        if (stat.isDirectory()) {
            const lines = await listFolder(location, depth, '', budget);
            sections.push(`Folder ${location}/:\n${lines.length > 0 ? lines.join('\n') : '(empty)'}`);
            continue;
        }
        if (!stat.isFile()) {
            continue;
        }
        let line = `File ${location} (${formatSize(stat.size)}, modified ${formatDate(stat.mtimeMs)})`;
        if (options.category !== 'files' && copiedFiles < MAX_COPIED_FILES && stat.size <= MAX_COPY_BYTES) {
            try {
                await fs.mkdir(options.inputsDir, { recursive: true });
                const copyName = `${copiedFiles + 1}-${path.basename(location)}`;
                await fs.copyFile(location, path.join(options.inputsDir, copyName));
                copiedFiles++;
                line += `; a read-only copy is in the workspace at ${options.inputsRelativeDir}/${copyName}`;
            } catch {
                line += '; it could not be copied for you';
            }
        }
        sections.push(line);
    }

    let text = sections.join('\n\n');
    if (text.length > maxChars) {
        text = cutShort(text, maxChars);
    }
    return { text, locations: described, copiedFiles };
}

/** Cut text to `length` UTF-16 units without splitting a surrogate pair, and say so. */
function cutShort(text: string, length: number): string {
    if (text.length <= length) {
        return text;
    }
    if (length <= 0) {
        return '';
    }
    let end = length;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
        end--;
    }
    return `${text.slice(0, end)}\n… (cut short)`;
}

/**
 * Largest prompt argument in UTF-8 bytes. Linux refuses a single argument over 128 KiB
 * (MAX_ARG_STRLEN) with E2BIG, and file names in other scripts take several bytes per
 * character.
 */
export const MAX_PROMPT_BYTES = 100_000;

export interface BuildPromptOptions {
    prompt: string;
    category: AgentTaskCategory;
    engine: AgentEngineId;
    context: string;
    homeDir: string;
    /** Defaults to {@link MAX_PROMPT_BYTES}. */
    maxBytes?: number;
}

/**
 * Wrap the user's request with the app's instructions and context, keeping the result
 * under `maxBytes` UTF-8 bytes by cutting the context short first. A plain question with
 * no context is passed as it is.
 */
export function buildAgentPrompt(options: BuildPromptOptions): string {
    const maxBytes = options.maxBytes ?? MAX_PROMPT_BYTES;
    const fits = (text: string): boolean => Buffer.byteLength(text, 'utf8') <= maxBytes;
    const full = wrapPrompt(options);
    if (fits(full)) {
        return full;
    }
    // Find the longest context that fits (binary search on its length).
    let low = 0;
    let high = options.context.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(wrapPrompt({ ...options, context: cutShort(options.context, middle) }))) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    // The prompt itself is at most 20,000 characters, so it fits on its own.
    return wrapPrompt({ ...options, context: cutShort(options.context, low) });
}

function wrapPrompt({ prompt, category, engine, context, homeDir }: BuildPromptOptions): string {
    const contextBlock = context
        ? `The app gathered this read-only information about the user's files for you:\n\n${context}\n\n`
        : '';

    if (category === 'files') {
        const format =
            engine === 'gemini-cli'
                ? 'Reply with exactly one fenced ```json code block containing {"summary": "...", "actions": [{"op": "move", "from": "/abs/path", "to": "/abs/path"}]}, and nothing that changes files.'
                : 'Your final answer must follow the JSON schema you were given.';
        return [
            `You are helping the user organise files on their computer. Their home folder is ${homeDir}.`,
            'Rules:',
            '- Do not create, move, copy, rename or delete any file yourself, and do not run commands. The app applies your plan after the user confirms it.',
            '- Answer with a plan: a short summary and a list of actions. Each action has "op" (move, copy, rename, mkdir or trash), an absolute "from" path (not for mkdir) and an absolute "to" path (not for trash).',
            `- Use only absolute paths inside ${homeDir}, never inside hidden folders. Use "trash" instead of deleting. Never overwrite: choose a destination that does not exist yet. Create folders with "mkdir" before moving files into them.`,
            '- If the request is unclear or nothing should change, return no actions and explain why in the summary.',
            `- ${format}`,
            '',
            `${contextBlock}User request:\n${prompt}`,
        ].join('\n');
    }

    if (!context) {
        // An argument that starts with '-' would be read as an option.
        return prompt.startsWith('-') ? ` ${prompt}` : prompt;
    }

    return (
        "Note from the Gemini Desktop app: you run in a scratch workspace, cannot read the user's files directly, " +
        'and must not change files outside the workspace.\n\n' +
        `${contextBlock}User request:\n${prompt}`
    );
}
