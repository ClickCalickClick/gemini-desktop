/**
 * Unit tests for the agent workspace and the Antigravity settings check.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    describeRiskySettings,
    findRiskyAntigravitySettings,
    prepareWorkspace,
} from '../../../../src/main/agent/workspace';
import { createTempLayout, type TempLayout } from './fakeCli';

describe('workspace', () => {
    let layout: TempLayout;

    beforeEach(() => {
        layout = createTempLayout();
    });

    afterEach(() => {
        layout.cleanup();
    });

    describe('prepareWorkspace', () => {
        it('creates the workspace as a Git root of its own', async () => {
            const workspace = path.join(layout.userData, 'agent-workspace');
            await prepareWorkspace(workspace);
            expect(fs.readFileSync(path.join(workspace, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
            expect(fs.statSync(path.join(workspace, '.git', 'objects')).isDirectory()).toBe(true);
            // A second call keeps the existing repository.
            fs.writeFileSync(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/other\n');
            await prepareWorkspace(workspace);
            expect(fs.readFileSync(path.join(workspace, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/other\n');
        });

        it('removes per-workspace settings files and old input copies', async () => {
            const workspace = path.join(layout.root, 'ws');
            const settings = [
                path.join(workspace, '.gemini', 'settings.json'),
                path.join(workspace, '.gemini', 'antigravity-cli', 'settings.json'),
                path.join(workspace, '.antigravity', 'settings.json'),
            ];
            for (const file of settings) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, '{}');
            }
            const oldInput = path.join(workspace, 'inputs', 'old-run');
            const newInput = path.join(workspace, 'inputs', 'new-run');
            fs.mkdirSync(oldInput, { recursive: true });
            fs.mkdirSync(newInput, { recursive: true });
            const now = Date.now();
            const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
            fs.utimesSync(oldInput, twoDaysAgo, twoDaysAgo);
            fs.writeFileSync(path.join(workspace, 'notes.md'), 'keep');

            await prepareWorkspace(workspace, now);

            for (const file of settings) {
                expect(fs.existsSync(file)).toBe(false);
            }
            expect(fs.existsSync(oldInput)).toBe(false);
            expect(fs.existsSync(newInput)).toBe(true);
            expect(fs.existsSync(path.join(workspace, 'notes.md'))).toBe(true);
        });
    });

    describe('findRiskyAntigravitySettings', () => {
        const writeSettings = (content: string) => {
            const file = path.join(layout.home, '.gemini', 'antigravity-cli', 'settings.json');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content);
        };

        it('finds nothing without a settings file or with safe settings', async () => {
            expect(await findRiskyAntigravitySettings(layout.home)).toEqual([]);
            writeSettings(
                JSON.stringify({
                    toolPermission: 'request-review',
                    permissions: { allow: ['command(git)', 'write_file(src/)', 'read_file(/var/log)', 42, 'junk'] },
                })
            );
            expect(await findRiskyAntigravitySettings(layout.home)).toEqual([]);
        });

        it('finds settings that allow changes outside the workspace', async () => {
            writeSettings(`{
                // comment lines are allowed
                "toolPermission": "always-proceed",
                "allowNonWorkspaceAccess": true,
                "permissions": {
                    "allow": [
                        "write_file(*)",
                        "write_file(/home/user/Documents)",
                        "write_file(~/x)",
                        "write_file(../up)",
                        "command(*)",
                        "command(regex:.*)",
                        "unsandboxed(git)",
                        "command(ls)"
                    ]
                }
            }`);
            expect(await findRiskyAntigravitySettings(layout.home)).toEqual([
                '"toolPermission": "always-proceed"',
                '"allowNonWorkspaceAccess": true',
                'write_file(*)',
                'write_file(/home/user/Documents)',
                'write_file(~/x)',
                'write_file(../up)',
                'command(*)',
                'command(regex:.*)',
                'unsandboxed(git)',
            ]);
        });

        it('ignores a settings file it cannot parse', async () => {
            writeSettings('{ not json');
            expect(await findRiskyAntigravitySettings(layout.home)).toEqual([]);
            writeSettings('[1]');
            expect(await findRiskyAntigravitySettings(layout.home)).toEqual([]);
        });

        it('describes the findings for the user', () => {
            const message = describeRiskySettings(['command(*)']);
            expect(message).toContain('command(*)');
            expect(message).toContain('~/.gemini/antigravity-cli/settings.json');
        });
    });
});
