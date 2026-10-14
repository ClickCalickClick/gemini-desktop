/**
 * Unit tests for file plans: shape checks, path safety, apply and undo against a
 * temporary home folder.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    applyPlan,
    checkPathReal,
    checkPathStatic,
    extractPlanFromText,
    filterUnsafeActions,
    FILE_PLAN_JSON_SCHEMA,
    isUndoable,
    MAX_PLAN_ACTIONS,
    normalizePlan,
    undoPlan,
    type PathPolicy,
} from '../../../../src/main/agent/filePlan';
import type { FileActionPlan } from '../../../../src/shared/types/agent';
import { createTempLayout, type TempLayout } from './fakeCli';

describe('filePlan', () => {
    let layout: TempLayout;
    let policy: PathPolicy;
    let trashed: string[];
    let trashItem: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        layout = createTempLayout();
        policy = { homeDir: layout.home, userDataDir: layout.userData };
        trashed = [];
        // A fake trash: move the item into <root>/trash.
        trashItem = vi.fn(async (target: string) => {
            const trashDir = path.join(layout.root, 'trash');
            fs.mkdirSync(trashDir, { recursive: true });
            fs.renameSync(target, path.join(trashDir, `${trashed.length}-${path.basename(target)}`));
            trashed.push(target);
        });
    });

    afterEach(() => {
        layout.cleanup();
    });

    const home = (...segments: string[]) => path.join(layout.home, ...segments);
    const write = (target: string, content = 'x') => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };

    describe('FILE_PLAN_JSON_SCHEMA', () => {
        it('describes summary and actions with the five operations', () => {
            expect(FILE_PLAN_JSON_SCHEMA.required).toEqual(['summary', 'actions']);
            expect(FILE_PLAN_JSON_SCHEMA.properties.actions.items.properties.op.enum).toEqual([
                'move',
                'copy',
                'rename',
                'mkdir',
                'trash',
            ]);
        });
    });

    describe('normalizePlan', () => {
        it('accepts a plan and adds unique ids', () => {
            const plan = normalizePlan({
                summary: '  Tidy up  ',
                actions: [
                    { op: 'mkdir', to: '/h/A', from: '/ignored' },
                    { id: 'keep-me', op: 'move', from: '/h/a', to: '/h/A/a' },
                    { id: 'keep-me', op: 'trash', from: '/h/b', to: '/ignored' },
                    { id: 'bad id!', op: 'copy', from: '/h/c', to: '/h/d' },
                ],
            });
            expect(plan?.summary).toBe('Tidy up');
            expect(plan?.actions).toHaveLength(4);
            expect(plan?.actions[0]).toEqual({ id: expect.any(String), op: 'mkdir', to: '/h/A' });
            expect(plan?.actions[1]?.id).toBe('keep-me');
            expect(plan?.actions[2]?.id).not.toBe('keep-me');
            expect(plan?.actions[2]).not.toHaveProperty('to');
            expect(new Set(plan?.actions.map((action) => action.id)).size).toBe(4);
        });

        it('accepts JSON text, also inside a fenced block', () => {
            const text = 'Plan:\n```json\n{"summary":"s","actions":[{"op":"mkdir","to":"/h/x"}]}\n```\nDone.';
            expect(normalizePlan(text)?.actions[0]?.op).toBe('mkdir');
            expect(normalizePlan('{"summary":"s","actions":[]}')).toEqual({ summary: 's', actions: [] });
        });

        it('rejects values that are not plans', () => {
            expect(normalizePlan(null)).toBeNull();
            expect(normalizePlan('no json here')).toBeNull();
            expect(normalizePlan({ summary: 's' })).toBeNull();
            expect(normalizePlan({ actions: [{ op: 'delete', from: '/h/a' }] })).toBeNull();
            expect(normalizePlan({ actions: [{ op: 'move', from: '/h/a' }] })).toBeNull();
            expect(normalizePlan({ actions: [{ op: 'trash' }] })).toBeNull();
            expect(normalizePlan({ actions: ['x'] })).toBeNull();
            expect(
                normalizePlan({
                    actions: Array.from({ length: MAX_PLAN_ACTIONS + 1 }, () => ({ op: 'mkdir', to: '/a' })),
                })
            ).toBeNull();
        });

        it('defaults a missing summary to an empty string', () => {
            expect(normalizePlan({ actions: [] })).toEqual({ summary: '', actions: [] });
        });
    });

    describe('extractPlanFromText', () => {
        it('uses the last fenced JSON block', () => {
            const text = '```json\n{"a":1}\n```\nthen\n```\n{"b":2}\n```';
            expect(extractPlanFromText(text)).toEqual({ b: 2 });
            expect(extractPlanFromText('```json\nnot json\n```')).toBeUndefined();
        });
    });

    describe('checkPathStatic', () => {
        it('accepts normalized absolute paths inside home', () => {
            expect(checkPathStatic(home('Documents', 'a.txt'), policy)).toBeNull();
            expect(checkPathStatic(`${home('Documents')}/`, policy)).toBeNull();
        });

        it('refuses relative, unnormalized and invalid paths', () => {
            expect(checkPathStatic('Documents/a.txt', policy)).toContain('Not an absolute path');
            expect(checkPathStatic(`${layout.home}/Documents/../Documents/a`, policy)).toContain('not normalized');
            expect(checkPathStatic(`${layout.home}//Documents`, policy)).toContain('not normalized');
            expect(checkPathStatic('', policy)).toBe('Missing or invalid path.');
            expect(checkPathStatic(42, policy)).toBe('Missing or invalid path.');
            expect(checkPathStatic(`${layout.home}/a\0b`, policy)).toBe('Invalid path.');
        });

        it('refuses home itself, paths outside home, hidden top-level folders and userData', () => {
            expect(checkPathStatic(layout.home, policy)).toContain('Outside your home folder');
            expect(checkPathStatic('/etc/passwd', policy)).toContain('Outside your home folder');
            expect(checkPathStatic(`${layout.home}-other/x`, policy)).toContain('Outside your home folder');
            expect(checkPathStatic(home('.ssh', 'id_rsa'), policy)).toContain('hidden folder');
            expect(checkPathStatic(home('.bashrc'), policy)).toContain('hidden folder');
            expect(checkPathStatic(home('Documents', '.notes'), policy)).toBeNull();
            const userDataPolicy = { ...policy, userDataDir: home('AppData') };
            expect(checkPathStatic(home('AppData', 'x'), userDataPolicy)).toContain("app's own data folder");
            expect(checkPathStatic(home('AppData'), userDataPolicy)).toContain("app's own data folder");
        });
    });

    describe('checkPathReal', () => {
        it('accepts paths whose parents do not exist yet', async () => {
            expect(await checkPathReal(home('New', 'Deep', 'file.txt'), policy)).toBeNull();
        });

        it('refuses a path that leads outside home through a symlinked folder', async () => {
            const outside = path.join(layout.root, 'outside');
            fs.mkdirSync(outside);
            fs.symlinkSync(outside, home('escape'));
            const error = await checkPathReal(home('escape', 'file.txt'), policy);
            expect(error).toContain('Outside your home folder');
            expect(error).toContain('symbolic link');
            expect(await checkPathReal(home('escape', 'new', 'file.txt'), policy)).toContain('symbolic link');
        });

        it('refuses a path that leads into a hidden folder through a symlink', async () => {
            fs.mkdirSync(home('.secret'));
            fs.symlinkSync(home('.secret'), home('visible'));
            expect(await checkPathReal(home('visible', 'x'), policy)).toContain('hidden folder');
        });

        it('allows moving a symlink itself when its parent is inside home', async () => {
            fs.symlinkSync('/etc', home('link-to-etc'));
            expect(await checkPathReal(home('link-to-etc'), policy)).toBeNull();
        });

        it('passes on static errors', async () => {
            expect(await checkPathReal('/etc/passwd', policy)).toContain('Outside your home folder');
        });
    });

    describe('filterUnsafeActions', () => {
        it('removes actions with unsafe paths', () => {
            const plan: FileActionPlan = {
                summary: 's',
                actions: [
                    { id: '1', op: 'mkdir', to: home('A') },
                    { id: '2', op: 'trash', from: '/etc/passwd' },
                    { id: '3', op: 'move', from: home('a'), to: home('.ssh', 'a') },
                ],
            };
            const { plan: safe, removed } = filterUnsafeActions(plan, policy);
            expect(removed).toBe(2);
            expect(safe.actions.map((action) => action.id)).toEqual(['1']);
        });
    });

    describe('applyPlan and undoPlan', () => {
        it('applies mkdir, move, rename, copy and trash, then undoes them', async () => {
            write(home('Downloads', 'a.pdf'), 'A');
            write(home('Downloads', 'b.jpg'), 'B');
            write(home('Downloads', 'c.txt'), 'C');
            write(home('Downloads', 'old.zip'), 'Z');
            write(home('Downloads', 'Folder', 'inner.txt'), 'I');

            const plan: FileActionPlan = {
                summary: 'sort',
                actions: [
                    { id: 'm1', op: 'mkdir', to: home('Downloads', 'PDFs') },
                    { id: 'm2', op: 'move', from: home('Downloads', 'a.pdf'), to: home('Downloads', 'PDFs', 'a.pdf') },
                    { id: 'm3', op: 'move', from: home('Downloads', 'b.jpg'), to: home('Pictures', 'New', 'b.jpg') },
                    { id: 'r1', op: 'rename', from: home('Downloads', 'c.txt'), to: home('Downloads', 'notes.txt') },
                    { id: 'c1', op: 'copy', from: home('Downloads', 'Folder'), to: home('Backup', 'Folder') },
                    { id: 't1', op: 'trash', from: home('Downloads', 'old.zip') },
                ],
            };

            const { result, undoLog } = await applyPlan(plan, policy, { trashItem });
            expect(result).toEqual({ applied: 6, failed: [], undoAvailable: true });
            expect(fs.readFileSync(home('Downloads', 'PDFs', 'a.pdf'), 'utf8')).toBe('A');
            expect(fs.readFileSync(home('Pictures', 'New', 'b.jpg'), 'utf8')).toBe('B');
            expect(fs.existsSync(home('Downloads', 'c.txt'))).toBe(false);
            expect(fs.readFileSync(home('Downloads', 'notes.txt'), 'utf8')).toBe('C');
            expect(fs.readFileSync(home('Backup', 'Folder', 'inner.txt'), 'utf8')).toBe('I');
            expect(fs.existsSync(home('Downloads', 'Folder', 'inner.txt'))).toBe(true);
            expect(trashed).toEqual([home('Downloads', 'old.zip')]);

            const undo = await undoPlan(undoLog, policy, { trashItem });
            expect(undo.applied).toBe(5);
            expect(undo.undoAvailable).toBe(false);
            expect(undo.failed).toEqual([{ id: 't1', error: expect.stringContaining('restore it from the Trash') }]);
            expect(fs.readFileSync(home('Downloads', 'a.pdf'), 'utf8')).toBe('A');
            expect(fs.readFileSync(home('Downloads', 'b.jpg'), 'utf8')).toBe('B');
            expect(fs.readFileSync(home('Downloads', 'c.txt'), 'utf8')).toBe('C');
            expect(fs.existsSync(home('Downloads', 'PDFs'))).toBe(false);
            expect(fs.existsSync(home('Pictures'))).toBe(false);
            expect(fs.existsSync(home('Backup', 'Folder'))).toBe(false);
            expect(fs.existsSync(home('Backup'))).toBe(false);
            expect(trashed).toContain(home('Backup', 'Folder'));
        });

        it('never overwrites, reports each failure and keeps going', async () => {
            write(home('a.txt'), 'new');
            write(home('Docs', 'a.txt'), 'old');
            write(home('b.txt'), 'b');
            write(home('file-not-dir'), 'f');

            const plan: FileActionPlan = {
                summary: 's',
                actions: [
                    { id: 'exists', op: 'move', from: home('a.txt'), to: home('Docs', 'a.txt') },
                    { id: 'copy-exists', op: 'copy', from: home('a.txt'), to: home('Docs', 'a.txt') },
                    { id: 'missing', op: 'move', from: home('nope.txt'), to: home('x.txt') },
                    { id: 'outside', op: 'move', from: home('b.txt'), to: '/tmp/b.txt' },
                    { id: 'dot', op: 'trash', from: home('.bashrc') },
                    { id: 'into-self', op: 'move', from: home('Docs'), to: home('Docs', 'Inner') },
                    { id: 'mkdir-file', op: 'mkdir', to: home('file-not-dir') },
                    { id: 'mkdir-existing', op: 'mkdir', to: home('Docs') },
                    { id: 'trash-missing', op: 'trash', from: home('gone.txt') },
                    { id: 'ok', op: 'rename', from: home('b.txt'), to: home('c.txt') },
                ],
            };
            const { result, undoLog } = await applyPlan(plan, policy, { trashItem });
            expect(result.applied).toBe(2);
            expect(result.failed.map((failure) => failure.id)).toEqual([
                'exists',
                'copy-exists',
                'missing',
                'outside',
                'dot',
                'into-self',
                'mkdir-file',
                'trash-missing',
            ]);
            expect(result.failed[0]?.error).toContain('Already exists');
            expect(result.failed[3]?.error).toContain('Outside your home folder');
            expect(result.failed[4]?.error).toContain('hidden folder');
            expect(fs.readFileSync(home('Docs', 'a.txt'), 'utf8')).toBe('old');
            expect(fs.readFileSync(home('c.txt'), 'utf8')).toBe('b');
            expect(trashItem).not.toHaveBeenCalled();
            expect(isUndoable(undoLog)).toBe(true);
        });

        it('refuses to act through a symlinked folder that leads outside home', async () => {
            const outside = path.join(layout.root, 'outside');
            fs.mkdirSync(outside);
            fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
            fs.symlinkSync(outside, home('link'));

            const plan: FileActionPlan = {
                summary: 's',
                actions: [
                    { id: 't', op: 'trash', from: home('link', 'secret.txt') },
                    { id: 'm', op: 'mkdir', to: home('link', 'new') },
                ],
            };
            const { result } = await applyPlan(plan, policy, { trashItem });
            expect(result.applied).toBe(0);
            expect(result.failed).toHaveLength(2);
            expect(result.undoAvailable).toBe(false);
            expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true);
            expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
        });

        it('reports a trash-only plan as not undoable', async () => {
            write(home('t.txt'));
            const { result, undoLog } = await applyPlan(
                { summary: 's', actions: [{ id: 't', op: 'trash', from: home('t.txt') }] },
                policy,
                { trashItem }
            );
            expect(result).toEqual({ applied: 1, failed: [], undoAvailable: false });
            expect(isUndoable(undoLog)).toBe(false);
        });

        it('keeps a created folder that is no longer empty when undoing', async () => {
            const { undoLog } = await applyPlan(
                { summary: 's', actions: [{ id: 'm', op: 'mkdir', to: home('Made') }] },
                policy,
                { trashItem }
            );
            write(home('Made', 'user-file.txt'));
            const undo = await undoPlan(undoLog, policy, { trashItem });
            expect(undo.applied).toBe(0);
            expect(undo.failed[0]?.error).toContain('not empty');
            expect(fs.existsSync(home('Made', 'user-file.txt'))).toBe(true);
        });

        it('does not overwrite when the original place was taken before undo', async () => {
            write(home('a.txt'), 'A');
            const { undoLog } = await applyPlan(
                { summary: 's', actions: [{ id: 'm', op: 'move', from: home('a.txt'), to: home('b.txt') }] },
                policy,
                { trashItem }
            );
            write(home('a.txt'), 'someone else');
            const undo = await undoPlan(undoLog, policy, { trashItem });
            expect(undo.failed[0]?.error).toContain('Already exists');
            expect(fs.readFileSync(home('a.txt'), 'utf8')).toBe('someone else');
            expect(fs.readFileSync(home('b.txt'), 'utf8')).toBe('A');
        });

        it('reports a moved item that disappeared before undo', async () => {
            write(home('a.txt'), 'A');
            const { undoLog } = await applyPlan(
                { summary: 's', actions: [{ id: 'm', op: 'move', from: home('a.txt'), to: home('b.txt') }] },
                policy,
                { trashItem }
            );
            fs.rmSync(home('b.txt'));
            const undo = await undoPlan(undoLog, policy, { trashItem });
            expect(undo.failed[0]?.error).toContain('Not found');
        });
    });
});
