/**
 * Unit tests for the agent workspace and the settings checks of both CLIs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    describeRiskySettings,
    findRiskySettings,
    prepareWorkspace,
    removeRunInputs,
    settingsFilesFor,
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

    const writeFile = (file: string, content: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    };

    describe('prepareWorkspace', () => {
        it('creates the workspace as a Git root of its own', async () => {
            const workspace = path.join(layout.userData, 'agent-workspace');
            await prepareWorkspace(workspace);
            expect(fs.readFileSync(path.join(workspace, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
            expect(fs.statSync(path.join(workspace, '.git', 'objects')).isDirectory()).toBe(true);
        });

        it('removes everything an earlier run left behind, .git included', async () => {
            const workspace = path.join(layout.root, 'ws');
            const leftovers = [
                'GEMINI.md',
                'AGENTS.md',
                '.env',
                '.gemini/.env',
                '.gemini/settings.json',
                '.gemini/antigravity-cli/settings.json',
                '.agents/rules/rule.md',
                '.agents/workflows/flow.md',
                'inputs/other-run/1-a.txt',
                '.git/config',
                'notes.md',
            ];
            for (const file of leftovers) {
                writeFile(path.join(workspace, file), 'planted');
            }

            await prepareWorkspace(workspace);

            expect(fs.readdirSync(workspace)).toEqual(['.git']);
            expect(fs.existsSync(path.join(workspace, '.git', 'config'))).toBe(false);
        });

        it('refuses a root folder', async () => {
            await expect(prepareWorkspace('/')).rejects.toThrow('Invalid agent workspace');
            await expect(prepareWorkspace('relative/ws')).rejects.toThrow('Invalid agent workspace');
        });
    });

    describe('removeRunInputs', () => {
        it("removes one run's inputs and ignores unsafe run ids", async () => {
            const workspace = path.join(layout.root, 'ws');
            writeFile(path.join(workspace, 'inputs', 'run-1', 'a.txt'), 'a');
            writeFile(path.join(workspace, 'inputs', 'run-2', 'b.txt'), 'b');
            await removeRunInputs(workspace, 'run-1');
            await removeRunInputs(workspace, '../run-2');
            expect(fs.existsSync(path.join(workspace, 'inputs', 'run-1'))).toBe(false);
            expect(fs.existsSync(path.join(workspace, 'inputs', 'run-2', 'b.txt'))).toBe(true);
        });
    });

    describe('settingsFilesFor', () => {
        it('lists the user and system files each engine reads', () => {
            expect(settingsFilesFor('antigravity', '/home/u', 'linux')).toEqual([
                '/home/u/.gemini/antigravity-cli/settings.json',
                '/home/u/.gemini/config/config.json',
            ]);
            expect(settingsFilesFor('gemini-cli', '/home/u', 'linux')).toEqual([
                '/home/u/.gemini/settings.json',
                '/etc/gemini-cli/settings.json',
            ]);
            expect(settingsFilesFor('gemini-cli', '/Users/u', 'darwin')[1]).toContain('GeminiCli');
            expect(settingsFilesFor('gemini-cli', 'C:\\Users\\u', 'win32')[1]).toContain('ProgramData');
        });
    });

    describe('findRiskySettings for Antigravity CLI', () => {
        const settingsFile = () => path.join(layout.home, '.gemini', 'antigravity-cli', 'settings.json');
        const configFile = () => path.join(layout.home, '.gemini', 'config', 'config.json');
        const check = () => findRiskySettings('antigravity', [settingsFile(), configFile()]);

        it('finds nothing without settings files or with safe settings', async () => {
            expect(await check()).toEqual([]);
            writeFile(
                settingsFile(),
                JSON.stringify({
                    toolPermission: 'request-review',
                    permissions: {
                        allow: ['command(git)', 'write_file(src/)', 'read_file(/var/log)', 42, 'junk'],
                        deny: ['write_file(*)', 'mcp(*)'],
                    },
                })
            );
            expect(await check()).toEqual([]);
        });

        it('finds settings that let tools run or write outside the workspace', async () => {
            writeFile(
                settingsFile(),
                `{
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
                        "mcp(notes/*)",
                        "command(ls)"
                    ]
                }
            }`
            );
            expect(await check()).toEqual([
                {
                    file: settingsFile(),
                    findings: [
                        '"toolPermission": "always-proceed"',
                        '"allowNonWorkspaceAccess": true',
                        'write_file(*)',
                        'write_file(/home/user/Documents)',
                        'write_file(~/x)',
                        'write_file(../up)',
                        'command(*)',
                        'command(regex:.*)',
                        'unsandboxed(git)',
                        'mcp(notes/*)',
                    ],
                },
            ]);
        });

        it('treats proceed-in-sandbox as running tools without asking', async () => {
            writeFile(settingsFile(), JSON.stringify({ toolPermission: 'proceed-in-sandbox' }));
            expect((await check())[0]?.findings).toEqual(['"toolPermission": "proceed-in-sandbox"']);
        });

        it("scans the desktop app's config.json at any depth", async () => {
            writeFile(
                configFile(),
                JSON.stringify({
                    general: { permissionPreset: 'Turbo' },
                    projects: [{ name: 'p', permissions: { allow: ['write_file(/home/x)'], ask: ['command(*)'] } }],
                })
            );
            expect(await check()).toEqual([
                { file: configFile(), findings: ['"permissionPreset": "Turbo"', 'write_file(/home/x)'] },
            ]);
        });

        it('ignores files it cannot parse', async () => {
            writeFile(settingsFile(), '{ not json');
            writeFile(configFile(), '[1]');
            expect(await check()).toEqual([]);
        });
    });

    describe('findRiskySettings for Gemini CLI', () => {
        const userFile = () => path.join(layout.home, '.gemini', 'settings.json');
        const systemFile = () => path.join(layout.root, 'etc', 'settings.json');
        const check = () => findRiskySettings('gemini-cli', [userFile(), systemFile()]);

        it('finds nothing with safe settings', async () => {
            writeFile(
                userFile(),
                JSON.stringify({
                    tools: { allowed: ['read_file', 'glob'], core: ['run_shell_command'] },
                    coreTools: ['ShellTool'],
                    general: { defaultApprovalMode: 'default' },
                    context: { includeDirectories: [] },
                    mcpServers: { notes: { command: 'notes', trust: false } },
                })
            );
            expect(await check()).toEqual([]);
        });

        it('finds auto-approved tools, extra folders, YOLO and trusted MCP servers', async () => {
            writeFile(
                userFile(),
                JSON.stringify({
                    tools: { allowed: ['run_shell_command(git)', 'write_file', 'read_file'], autoAccept: true },
                    context: { includeDirectories: ['/home/u/Documents'] },
                    general: { defaultApprovalMode: 'yolo' },
                    mcpServers: { notes: { command: 'notes', trust: true } },
                })
            );
            writeFile(systemFile(), JSON.stringify({ allowedTools: ['ShellTool'], yolo: true }));
            expect(await check()).toEqual([
                {
                    file: userFile(),
                    findings: [
                        '"allowed": "run_shell_command(git)"',
                        '"allowed": "write_file"',
                        '"autoAccept": true',
                        '"includeDirectories"',
                        '"defaultApprovalMode": "yolo"',
                        '"trust": true (MCP server)',
                    ],
                },
                { file: systemFile(), findings: ['"allowedTools": "ShellTool"', '"yolo": true'] },
            ]);
        });
    });

    describe('describeRiskySettings', () => {
        it('names the engine, the file and the findings', () => {
            const message = describeRiskySettings('gemini-cli', [
                { file: '/h/.gemini/settings.json', findings: ['x'] },
            ]);
            expect(message).toContain("Gemini CLI's settings");
            expect(message).toContain('/h/.gemini/settings.json: x');
        });
    });
});
