/**
 * Unit tests for the read-only context the app gathers and the prompt it builds.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildAgentPrompt,
    extractFolderMentions,
    extractPathCandidates,
    gatherContext,
    type ContextOptions,
} from '../../../../src/main/agent/promptContext';
import { createTempLayout, type TempLayout } from './fakeCli';

describe('promptContext', () => {
    let layout: TempLayout;

    beforeEach(() => {
        layout = createTempLayout();
    });

    afterEach(() => {
        layout.cleanup();
    });

    const home = (...segments: string[]) => path.join(layout.home, ...segments);
    const write = (target: string, content = 'x') => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };
    const options = (overrides: Partial<ContextOptions> = {}): ContextOptions => ({
        homeDir: layout.home,
        userDataDir: layout.userData,
        platform: 'linux',
        getFolder: (name) => (name === 'downloads' ? home('Downloads') : null),
        inputsDir: path.join(layout.root, 'ws', 'inputs', 'run1'),
        inputsRelativeDir: 'inputs/run1',
        category: 'documents',
        ...overrides,
    });

    describe('extractPathCandidates', () => {
        it('finds ~/ paths, absolute paths and quoted paths with spaces', () => {
            const found = extractPathCandidates(
                'Summarise ~/Documents/report.pdf, compare "/home/u/My Files/a b.txt" and /tmp/x.log.',
                '/home/u',
                'linux'
            );
            expect(found).toEqual(['/home/u/My Files/a b.txt', '/home/u/Documents/report.pdf', '/tmp/x.log']);
            expect(extractPathCandidates('what is in ~ ?', '/home/u', 'linux')).toEqual(['/home/u']);
            expect(extractPathCandidates('and/or a / b', '/home/u', 'linux')).toEqual([]);
        });

        it('finds drive paths on Windows', () => {
            expect(extractPathCandidates('look at C:\\Users\\u\\a.txt', 'C:\\Users\\u', 'win32')).toHaveLength(1);
        });
    });

    describe('extractFolderMentions', () => {
        it('maps folder names to well-known folders', () => {
            expect(extractFolderMentions('Sort my Downloads and Pictures')).toEqual(['downloads', 'pictures']);
            expect(extractFolderMentions('files on my desktop and in my home folder')).toEqual(['desktop', 'home']);
            expect(extractFolderMentions('what is the capital of France')).toEqual([]);
        });
    });

    describe('gatherContext', () => {
        it('lists a named folder without hidden entries', async () => {
            write(home('Downloads', 'b.pdf'), 'pdf');
            write(home('Downloads', 'a.txt'), 'hello');
            write(home('Downloads', '.hidden'), 'h');
            write(home('Downloads', 'Sub', 'inner.txt'), 'i');

            const context = await gatherContext('sort my downloads', options({ category: 'files' }));
            expect(context.locations).toBe(1);
            expect(context.copiedFiles).toBe(0);
            expect(context.text).toContain(`Folder ${home('Downloads')}/:`);
            expect(context.text).toContain(`- ${home('Downloads', 'a.txt')}  (5 B, modified `);
            expect(context.text).toContain(`- ${home('Downloads', 'Sub')}/  (folder`);
            // File tasks look two levels deep.
            expect(context.text).toContain(`  - ${home('Downloads', 'Sub', 'inner.txt')}`);
            expect(context.text).not.toContain('.hidden');
            expect(context.text.indexOf('a.txt')).toBeLessThan(context.text.indexOf('b.pdf'));
        });

        it('lists one level for questions and copies a named file into the workspace', async () => {
            write(home('Documents', 'report.txt'), 'quarterly numbers');
            write(home('Documents', 'Sub', 'inner.txt'), 'i');

            const context = await gatherContext('summarise ~/Documents/report.txt and list ~/Documents', options());
            expect(context.copiedFiles).toBe(1);
            expect(context.text).toContain('a read-only copy is in the workspace at inputs/run1/1-report.txt');
            expect(fs.readFileSync(path.join(layout.root, 'ws', 'inputs', 'run1', '1-report.txt'), 'utf8')).toBe(
                'quarterly numbers'
            );
            expect(context.text).not.toContain('inner.txt');
        });

        it('does not show paths outside home, in hidden folders or behind a symlink to outside', async () => {
            write(home('.ssh', 'id_rsa'), 'secret');
            const outside = path.join(layout.root, 'outside');
            write(path.join(outside, 'secret.txt'), 'secret');
            fs.symlinkSync(outside, home('link'));
            fs.symlinkSync(path.join(outside, 'secret.txt'), home('file-link.txt'));

            const context = await gatherContext(
                `read ~/.ssh/id_rsa and ${outside}/secret.txt and ~/link and ~/file-link.txt`,
                options()
            );
            expect(context.copiedFiles).toBe(0);
            expect(context.locations).toBe(0);
            expect(context.text).toContain('not shown');
            expect(context.text).not.toContain('secret.txt  (');
            expect(fs.existsSync(path.join(layout.root, 'ws', 'inputs'))).toBe(false);
        });

        it('lists the home folder itself and skips missing paths', async () => {
            write(home('visible.txt'));
            const context = await gatherContext('what is in my home folder and ~/missing.txt', options());
            expect(context.locations).toBe(1);
            expect(context.text).toContain(`Folder ${layout.home}/:`);
            expect(context.text).not.toContain('.config');
        });

        it('caps the context length', async () => {
            for (let i = 0; i < 50; i++) {
                write(home('Downloads', `file-${i}.txt`));
            }
            const context = await gatherContext('downloads', options({ maxContextChars: 200 }));
            expect(context.text.length).toBeLessThan(260);
            expect(context.text).toContain('(cut short)');
        });

        it('returns no text when the prompt names nothing', async () => {
            expect(await gatherContext('hello there', options())).toEqual({ text: '', locations: 0, copiedFiles: 0 });
        });
    });

    describe('buildAgentPrompt', () => {
        it('passes a plain question as it is, and protects a leading dash', () => {
            expect(
                buildAgentPrompt({
                    prompt: 'hi',
                    category: 'general',
                    engine: 'antigravity',
                    context: '',
                    homeDir: '/h',
                })
            ).toBe('hi');
            expect(
                buildAgentPrompt({
                    prompt: '--help me',
                    category: 'general',
                    engine: 'antigravity',
                    context: '',
                    homeDir: '/h',
                })
            ).toBe(' --help me');
        });

        it('adds the context to questions', () => {
            const prompt = buildAgentPrompt({
                prompt: 'summarise',
                category: 'documents',
                engine: 'antigravity',
                context: 'File /h/a.txt',
                homeDir: '/h',
            });
            expect(prompt).toContain('scratch workspace');
            expect(prompt).toContain('File /h/a.txt');
            expect(prompt.endsWith('User request:\nsummarise')).toBe(true);
        });

        it('keeps the prompt under the byte limit by cutting the context, also for multi-byte names', () => {
            const cjkName = '報告書'.repeat(30);
            const context = Array.from({ length: 2000 }, (_, i) => `- /h/${cjkName}-${i}.pdf  (1 KB)`).join('\n');
            expect(Buffer.byteLength(context, 'utf8')).toBeGreaterThan(100_000);
            expect(context.length).toBeLessThan(400_000);
            const prompt = buildAgentPrompt({
                prompt: 'sort these ' + '写真'.repeat(100),
                category: 'files',
                engine: 'antigravity',
                context,
                homeDir: '/h',
            });
            expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(100_000);
            expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(90_000);
            expect(prompt).toContain('(cut short)');
            expect(prompt.endsWith('写真'.repeat(100))).toBe(true);
            expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);

            const small = buildAgentPrompt({
                prompt: 'q',
                category: 'documents',
                engine: 'antigravity',
                context: '😀'.repeat(100),
                homeDir: '/h',
                maxBytes: 300,
            });
            expect(Buffer.byteLength(small, 'utf8')).toBeLessThanOrEqual(300);
            expect(small).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        });

        it('asks file tasks for a plan and forbids changing files', () => {
            const agy = buildAgentPrompt({
                prompt: 'sort',
                category: 'files',
                engine: 'antigravity',
                context: 'Folder /h/Downloads/:',
                homeDir: '/h',
            });
            expect(agy).toContain('Do not create, move, copy, rename or delete any file yourself');
            expect(agy).toContain('JSON schema');
            expect(agy).toContain('Folder /h/Downloads/:');
            const gemini = buildAgentPrompt({
                prompt: 'sort',
                category: 'files',
                engine: 'gemini-cli',
                context: '',
                homeDir: '/h',
            });
            expect(gemini).toContain('```json');
            expect(gemini).not.toContain('read-only information');
        });
    });
});
