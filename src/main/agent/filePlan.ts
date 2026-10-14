/**
 * File plans: the structured answer the agent gives for file tasks, and the code that
 * applies (and undoes) a plan after the user confirmed it.
 *
 * The agent never changes the user's files itself. The app applies each action here,
 * with Node's `fs`, only inside the home folder, never overwriting, and moving to the
 * trash instead of deleting.
 *
 * @module agent/filePlan
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FileAction, FileActionPlan, FileActionResult } from '../../shared/types/agent';

export const FILE_ACTION_OPS: readonly FileAction['op'][] = ['move', 'copy', 'rename', 'mkdir', 'trash'];
export const MAX_PLAN_ACTIONS = 500;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_PATH_LENGTH = 4096;

/** JSON schema for `--json-schema`, matching {@link FileActionPlan} (ids are added by the app). */
export const FILE_PLAN_JSON_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string', description: 'One or two sentences describing the plan.' },
        actions: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    op: { type: 'string', enum: [...FILE_ACTION_OPS] },
                    from: { type: 'string', description: 'Absolute source path (not used by mkdir).' },
                    to: { type: 'string', description: 'Absolute destination path (not used by trash).' },
                },
                required: ['op'],
            },
        },
    },
    required: ['summary', 'actions'],
} as const;

/** Paths the plan may touch. */
export interface PathPolicy {
    homeDir: string;
    /** The app's own data folder, always refused. */
    userDataDir: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Find the plan in a fenced ```json block (or the whole text) of a plain-text answer. */
export function extractPlanFromText(text: string): unknown {
    const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
    const candidates = [...fenced.map((match) => match[1] ?? '').reverse(), text];
    for (const candidate of candidates) {
        try {
            const value: unknown = JSON.parse(candidate.trim());
            if (isObject(value)) {
                return value;
            }
        } catch {
            // Not JSON; try the next candidate.
        }
    }
    return undefined;
}

/**
 * Check a plan's shape and give every action a unique id. Paths are not checked here;
 * see {@link checkPathStatic}. Returns null when the value is not a plan.
 */
export function normalizePlan(value: unknown): FileActionPlan | null {
    let candidate = value;
    if (typeof candidate === 'string') {
        candidate = extractPlanFromText(candidate);
    }
    if (!isObject(candidate) || !Array.isArray(candidate.actions)) {
        return null;
    }
    if (candidate.actions.length > MAX_PLAN_ACTIONS) {
        return null;
    }
    const summary = typeof candidate.summary === 'string' ? candidate.summary.trim().slice(0, MAX_SUMMARY_LENGTH) : '';

    const ids = new Set<string>();
    const actions: FileAction[] = [];
    for (const raw of candidate.actions) {
        if (!isObject(raw) || !FILE_ACTION_OPS.includes(raw.op as FileAction['op'])) {
            return null;
        }
        const op = raw.op as FileAction['op'];
        const from = typeof raw.from === 'string' ? raw.from : undefined;
        const to = typeof raw.to === 'string' ? raw.to : undefined;
        if (op !== 'mkdir' && !from) {
            return null;
        }
        if (op !== 'trash' && !to) {
            return null;
        }
        let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : '';
        if (!id || ids.has(id)) {
            id = randomUUID();
        }
        ids.add(id);
        actions.push({
            id,
            op,
            ...(op !== 'mkdir' && from ? { from } : {}),
            ...(op !== 'trash' && to ? { to } : {}),
        });
    }
    return { summary, actions };
}

/** True when `child` is `parent` itself or inside it. */
function isInsideOrEqual(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Check a path without touching the disk: absolute, normalized, strictly inside the
 * home folder, not in a dot-folder at the top of home, and not in the app's data folder.
 * Returns an error message, or null when the path is acceptable.
 */
export function checkPathStatic(candidate: unknown, policy: PathPolicy): string | null {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_PATH_LENGTH) {
        return 'Missing or invalid path.';
    }
    if (candidate.includes('\0')) {
        return 'Invalid path.';
    }
    if (!path.isAbsolute(candidate)) {
        return `Not an absolute path: ${candidate}`;
    }
    const resolved = path.resolve(candidate);
    const withoutTrailing = candidate.length > 1 ? candidate.replace(/[\\/]+$/, '') : candidate;
    if (resolved !== withoutTrailing) {
        return `Path is not normalized: ${candidate}`;
    }
    return checkResolvedPath(resolved, path.resolve(policy.homeDir), path.resolve(policy.userDataDir));
}

function checkResolvedPath(resolved: string, homeDir: string, userDataDir: string): string | null {
    const relative = path.relative(homeDir, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return `Outside your home folder: ${resolved}`;
    }
    const topSegment = relative.split(/[\\/]/)[0] ?? '';
    if (topSegment.startsWith('.')) {
        return `Inside a hidden folder of your home folder: ${resolved}`;
    }
    if (isInsideOrEqual(userDataDir, resolved)) {
        return `Inside the app's own data folder: ${resolved}`;
    }
    return null;
}

async function exists(target: string): Promise<boolean> {
    try {
        await fs.lstat(target);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check a path on disk: the real path of its closest existing parent folder must still be
 * inside the home folder, so a symlinked folder cannot lead the action elsewhere.
 */
export async function checkPathReal(candidate: string, policy: PathPolicy): Promise<string | null> {
    const staticError = checkPathStatic(candidate, policy);
    if (staticError) {
        return staticError;
    }
    const resolved = path.resolve(candidate);
    let realHome: string;
    try {
        realHome = await fs.realpath(policy.homeDir);
    } catch {
        return 'Your home folder could not be read.';
    }
    let realUserData = path.resolve(policy.userDataDir);
    try {
        realUserData = await fs.realpath(policy.userDataDir);
    } catch {
        // The app's data folder may not exist in tests; keep the configured path.
    }

    // The item itself may be a symlink (moving or trashing it acts on the link); its
    // parent folders must not lead outside home.
    let existingParent = path.dirname(resolved);
    const remainder: string[] = [path.basename(resolved)];
    while (!(await exists(existingParent))) {
        const next = path.dirname(existingParent);
        if (next === existingParent) {
            return `No existing parent folder: ${resolved}`;
        }
        remainder.unshift(path.basename(existingParent));
        existingParent = next;
    }
    let realParent: string;
    try {
        realParent = await fs.realpath(existingParent);
    } catch {
        return `Could not resolve: ${resolved}`;
    }
    const realTarget = path.join(realParent, ...remainder);
    const error = checkResolvedPath(realTarget, realHome, realUserData);
    return error ? `${error} (through a symbolic link)` : null;
}

/** Remove from a plan the actions whose paths fail {@link checkPathStatic}. */
export function filterUnsafeActions(
    plan: FileActionPlan,
    policy: PathPolicy
): { plan: FileActionPlan; removed: number } {
    const actions = plan.actions.filter((action) => {
        const paths = [action.op !== 'mkdir' ? action.from : undefined, action.op !== 'trash' ? action.to : undefined];
        return paths.every((p) => p === undefined || checkPathStatic(p, policy) === null);
    });
    return { plan: { ...plan, actions }, removed: plan.actions.length - actions.length };
}

/** What the undo log remembers about one applied action. */
export interface UndoEntry {
    actionId: string;
    op: FileAction['op'];
    from?: string;
    to?: string;
    /** Folders this action created, outermost first. */
    createdDirs: string[];
}

export interface FileOperations {
    /** Move an item to the desktop's trash (Electron `shell.trashItem`). */
    trashItem: (target: string) => Promise<void>;
}

/** Create a folder and its missing parents; returns the folders created, outermost first. */
async function mkdirTracked(target: string): Promise<string[]> {
    const missing: string[] = [];
    let current = target;
    while (!(await exists(current))) {
        missing.unshift(current);
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    if (missing.length > 0) {
        await fs.mkdir(target, { recursive: true });
    }
    return missing;
}

async function moveItem(from: string, to: string): Promise<void> {
    try {
        await fs.rename(from, to);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
            throw error;
        }
        // Different file systems: copy, then remove the original.
        await fs.cp(from, to, {
            recursive: true,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
            verbatimSymlinks: true,
        });
        await fs.rm(from, { recursive: true });
    }
}

function describeError(error: unknown): string {
    const err = error as NodeJS.ErrnoException;
    switch (err?.code) {
        case 'ENOENT':
            return 'Not found.';
        case 'EEXIST':
            return 'Something with that name already exists.';
        case 'EACCES':
        case 'EPERM':
            return 'Permission denied.';
        case 'ENOTEMPTY':
            return 'The folder is not empty.';
        default:
            return error instanceof Error ? error.message : String(error);
    }
}

async function applyAction(action: FileAction, policy: PathPolicy, ops: FileOperations): Promise<UndoEntry> {
    const checks = [action.op !== 'mkdir' ? action.from : undefined, action.op !== 'trash' ? action.to : undefined];
    for (const candidate of checks) {
        if (candidate === undefined) {
            continue;
        }
        const error = await checkPathReal(candidate, policy);
        if (error) {
            throw new Error(error);
        }
    }

    switch (action.op) {
        case 'mkdir': {
            const to = path.resolve(action.to as string);
            if (await exists(to)) {
                const stat = await fs.lstat(to);
                if (!stat.isDirectory()) {
                    throw new Error('A file with that name already exists.');
                }
                return { actionId: action.id, op: 'mkdir', to, createdDirs: [] };
            }
            const createdDirs = await mkdirTracked(to);
            return { actionId: action.id, op: 'mkdir', to, createdDirs };
        }
        case 'move':
        case 'rename':
        case 'copy': {
            const from = path.resolve(action.from as string);
            const to = path.resolve(action.to as string);
            if (from === to || isInsideOrEqual(from, to)) {
                throw new Error('Cannot move or copy a folder into itself.');
            }
            if (!(await exists(from))) {
                throw new Error(`Not found: ${from}`);
            }
            if (await exists(to)) {
                throw new Error(`Already exists, not overwritten: ${to}`);
            }
            const createdDirs = await mkdirTracked(path.dirname(to));
            if (action.op === 'copy') {
                await fs.cp(from, to, {
                    recursive: true,
                    errorOnExist: true,
                    force: false,
                    preserveTimestamps: true,
                    verbatimSymlinks: true,
                });
            } else {
                await moveItem(from, to);
            }
            return { actionId: action.id, op: action.op, from, to, createdDirs };
        }
        case 'trash': {
            const from = path.resolve(action.from as string);
            if (!(await exists(from))) {
                throw new Error(`Not found: ${from}`);
            }
            await ops.trashItem(from);
            return { actionId: action.id, op: 'trash', from, createdDirs: [] };
        }
    }
}

/** True when an undo log has something that can be undone. */
export function isUndoable(entries: UndoEntry[]): boolean {
    return entries.some(
        (entry) =>
            entry.op === 'move' ||
            entry.op === 'rename' ||
            entry.op === 'copy' ||
            (entry.op === 'mkdir' && entry.createdDirs.length > 0)
    );
}

/** Apply a plan in order. A failed action is reported and the rest still run. */
export async function applyPlan(
    plan: FileActionPlan,
    policy: PathPolicy,
    ops: FileOperations
): Promise<{ result: FileActionResult; undoLog: UndoEntry[] }> {
    const undoLog: UndoEntry[] = [];
    const failed: FileActionResult['failed'] = [];
    let applied = 0;

    for (const action of plan.actions) {
        try {
            undoLog.push(await applyAction(action, policy, ops));
            applied++;
        } catch (error) {
            failed.push({ id: action.id, error: describeError(error) });
        }
    }

    return { result: { applied, failed, undoAvailable: isUndoable(undoLog) }, undoLog };
}

/** Remove folders the plan created, deepest first, when they are empty. False when one was kept. */
async function removeCreatedDirs(createdDirs: string[]): Promise<boolean> {
    for (const dir of [...createdDirs].reverse()) {
        try {
            await fs.rmdir(dir);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                continue;
            }
            if (code === 'ENOTEMPTY' || code === 'EEXIST') {
                // Something else is in it now; keep it and its parents.
                return false;
            }
            throw error;
        }
    }
    return true;
}

/**
 * Undo an applied plan, last action first: moves and renames go back, copies go to the
 * trash, created folders are removed when empty. Trashed items cannot be undone here.
 */
export async function undoPlan(
    undoLog: UndoEntry[],
    policy: PathPolicy,
    ops: FileOperations
): Promise<FileActionResult> {
    const failed: FileActionResult['failed'] = [];
    let applied = 0;

    for (const entry of [...undoLog].reverse()) {
        try {
            switch (entry.op) {
                case 'trash':
                    failed.push({
                        id: entry.actionId,
                        error: `${entry.from} was moved to the Trash; restore it from the Trash.`,
                    });
                    continue;
                case 'move':
                case 'rename': {
                    const from = entry.from as string;
                    const to = entry.to as string;
                    for (const candidate of [from, to]) {
                        const error = await checkPathReal(candidate, policy);
                        if (error) {
                            throw new Error(error);
                        }
                    }
                    if (!(await exists(to))) {
                        throw new Error(`Not found: ${to}`);
                    }
                    if (await exists(from)) {
                        throw new Error(`Already exists, not overwritten: ${from}`);
                    }
                    await mkdirTracked(path.dirname(from));
                    await moveItem(to, from);
                    await removeCreatedDirs(entry.createdDirs);
                    break;
                }
                case 'copy': {
                    const to = entry.to as string;
                    const error = await checkPathReal(to, policy);
                    if (error) {
                        throw new Error(error);
                    }
                    if (await exists(to)) {
                        await ops.trashItem(to);
                    }
                    await removeCreatedDirs(entry.createdDirs);
                    break;
                }
                case 'mkdir':
                    if (entry.createdDirs.length === 0) {
                        continue;
                    }
                    if (!(await removeCreatedDirs(entry.createdDirs))) {
                        throw new Error(`${entry.to} is not empty, so it was kept.`);
                    }
                    break;
            }
            applied++;
        } catch (error) {
            failed.push({ id: entry.actionId, error: describeError(error) });
        }
    }

    return { applied, failed, undoAvailable: false };
}
