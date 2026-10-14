/**
 * Unit tests for AgentManager, driving a fake agent CLI (a Node script in a temporary
 * bin folder) through real child processes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AgentManager, { describeFailure, validateRunRequest } from '../../../../src/main/managers/agentManager';
import { LOOKUP_COMMAND_RULES } from '../../../../src/shared/constants/agentLookupCommands';
import type { AgentEnginePreference, AgentRunEvent } from '../../../../src/shared/types/agent';
import { createMockLogger } from '../../../helpers/mocks';
import { createTempLayout, fakePath, installFakeCli, type TempLayout } from '../agent/fakeCli';

type DoneEvent = Extract<AgentRunEvent, { type: 'done' }>;

describe('AgentManager', () => {
    let layout: TempLayout;
    let argsFile: string;
    let trashItem: ReturnType<typeof vi.fn>;
    let managers: AgentManager[];

    beforeEach(() => {
        layout = createTempLayout();
        argsFile = path.join(layout.root, 'args.json');
        trashItem = vi.fn(async (target: string) => {
            fs.rmSync(target, { recursive: true });
        });
        managers = [];
    });

    afterEach(() => {
        for (const manager of managers) {
            manager.dispose();
        }
        layout.cleanup();
    });

    const createManager = (overrides: ConstructorParameters<typeof AgentManager>[0] = {}) => {
        const manager = new AgentManager({
            logger: createMockLogger(),
            homeDir: () => layout.home,
            userDataDir: () => layout.userData,
            getFolder: (name) => (name === 'downloads' ? path.join(layout.home, 'Downloads') : null),
            env: { PATH: fakePath(layout.bin), FAKE_HOME: layout.home, FAKE_ARGS_FILE: argsFile },
            platform: 'linux',
            extraSearchDirectories: [],
            readVersion: async () => '1.0.0',
            // Only the temporary home's settings files, never the machine's system-wide ones.
            settingsFiles: (engine) =>
                engine === 'antigravity'
                    ? [agySettingsFile(), path.join(layout.home, '.gemini', 'config', 'config.json')]
                    : [geminiSettingsFile()],
            trashItem,
            ...overrides,
        });
        managers.push(manager);
        return manager;
    };

    const startRun = async (
        manager: AgentManager,
        prompt: string,
        category: 'files' | 'general' | 'documents' = 'general',
        extra: { conversationId?: string; enginePreference?: AgentEnginePreference; model?: string } = {}
    ) => {
        const events: AgentRunEvent[] = [];
        const { runId } = await manager.run(
            { prompt, category, ...(extra.conversationId ? { conversationId: extra.conversationId } : {}) },
            {
                enginePreference: extra.enginePreference ?? 'auto',
                model: extra.model ?? '',
                emit: (event) => events.push(event),
            }
        );
        return { runId, events };
    };

    const waitForDone = async (events: AgentRunEvent[], timeout = 4000): Promise<DoneEvent> => {
        await vi.waitFor(
            () => {
                if (!events.some((event) => event.type === 'done')) {
                    throw new Error('not done yet');
                }
            },
            { timeout, interval: 10 }
        );
        return events.find((event): event is DoneEvent => event.type === 'done') as DoneEvent;
    };

    const readArgs = (): { args: string[]; cwd: string; files: string[]; inputs: string[]; allow: string[] | null } =>
        JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    const agySettingsFile = () => path.join(layout.home, '.gemini', 'antigravity-cli', 'settings.json');
    const geminiSettingsFile = () => path.join(layout.home, '.gemini', 'settings.json');
    const writeJson = (file: string, value: unknown) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value));
    };

    describe('validateRunRequest', () => {
        it('accepts valid requests', () => {
            expect(validateRunRequest({ prompt: 'hi', category: 'general' })).toEqual({
                prompt: 'hi',
                category: 'general',
            });
            expect(validateRunRequest({ prompt: 'hi', category: 'files', conversationId: 'abc-1.2:3_x' })).toEqual({
                prompt: 'hi',
                category: 'files',
                conversationId: 'abc-1.2:3_x',
            });
            expect(validateRunRequest({ prompt: 'hi', category: 'code', conversationId: '' })).toEqual({
                prompt: 'hi',
                category: 'code',
            });
        });

        it('rejects invalid requests', () => {
            expect(() => validateRunRequest(null)).toThrow('Invalid agent request.');
            expect(() => validateRunRequest({ prompt: '   ', category: 'general' })).toThrow('empty');
            expect(() => validateRunRequest({ prompt: 'x'.repeat(20_001), category: 'general' })).toThrow('longer');
            expect(() => validateRunRequest({ prompt: 'hi', category: 'shell' })).toThrow('category');
            expect(() => validateRunRequest({ prompt: 'hi', category: 'general', conversationId: 'a b' })).toThrow(
                'conversation id'
            );
            expect(() => validateRunRequest({ prompt: 'hi', category: 'general', conversationId: 5 })).toThrow(
                'conversation id'
            );
        });

        it('accepts a screenshot id and ignores an empty one', () => {
            const screenshotId = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
            expect(validateRunRequest({ prompt: 'hi', category: 'general', screenshotId })).toEqual({
                prompt: 'hi',
                category: 'general',
                screenshotId,
            });
            expect(validateRunRequest({ prompt: 'hi', category: 'general', screenshotId: '' })).toEqual({
                prompt: 'hi',
                category: 'general',
            });
            expect(validateRunRequest({ prompt: 'hi', category: 'files', conversationId: 'c1', screenshotId })).toEqual(
                { prompt: 'hi', category: 'files', conversationId: 'c1', screenshotId }
            );
        });

        it('rejects a malformed screenshot id', () => {
            for (const screenshotId of ['../../etc/passwd', 'not-a-uuid', 7]) {
                expect(() => validateRunRequest({ prompt: 'hi', category: 'general', screenshotId })).toThrow(
                    'Invalid screenshot id.'
                );
            }
        });
    });

    describe('describeFailure', () => {
        it('maps sign-in and API key errors to instructions', () => {
            expect(describeFailure('antigravity', 'Error: authentication required', undefined, 1)).toContain(
                'run `agy` once'
            );
            expect(describeFailure('gemini-cli', 'GEMINI_API_KEY is not set', undefined, 41)).toContain(
                'GEMINI_API_KEY'
            );
            expect(describeFailure('antigravity', '', 'Model not found', 1)).toBe('Model not found');
            expect(describeFailure('antigravity', 'a\nb\n', undefined, 1)).toBe('a b');
            expect(describeFailure('antigravity', '', undefined, 4)).toContain('exited with code 4');
            expect(describeFailure('gemini-cli', '', undefined, null)).toContain('stopped unexpectedly');
        });
    });

    describe('getStatus', () => {
        it('reports a missing engine and caches the result for 30 seconds', async () => {
            let now = 1000;
            const manager = createManager({ now: () => now });
            const missing = await manager.getStatus('auto');
            expect(missing).toMatchObject({ engine: null, available: false });

            const agy = installFakeCli(layout.bin, 'agy');
            expect(await manager.getStatus('auto')).toBe(missing);
            now += 31_000;
            expect(await manager.getStatus('auto')).toEqual({
                engine: 'antigravity',
                available: true,
                path: agy,
                version: '1.0.0',
            });
            expect((await manager.getStatus('gemini-cli')).available).toBe(false);
        });

        it('blocks Antigravity when its settings allow changes outside the workspace', async () => {
            installFakeCli(layout.bin, 'agy');
            const settings = path.join(layout.home, '.gemini', 'antigravity-cli', 'settings.json');
            fs.mkdirSync(path.dirname(settings), { recursive: true });
            fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['write_file(*)'] } }));
            const manager = createManager();

            const status = await manager.getStatus('antigravity');
            expect(status).toMatchObject({ engine: 'antigravity', available: false });
            expect(status.error).toContain('write_file(*)');

            // Auto falls back to Gemini CLI when it is installed.
            installFakeCli(layout.bin, 'gemini');
            expect(await manager.getStatus('auto', true)).toMatchObject({ engine: 'gemini-cli', available: true });
            manager.invalidateStatus();
            fs.rmSync(path.join(layout.bin, 'gemini'));
            expect(await manager.getStatus('auto')).toMatchObject({ engine: 'antigravity', available: false });
        });
    });

    describe('run with Antigravity CLI', () => {
        beforeEach(() => {
            installFakeCli(layout.bin, 'agy');
        });

        it('streams text and tool steps, skips unknown events and finishes with the conversation id', async () => {
            const manager = createManager();
            const { runId, events } = await startRun(manager, 'hello', 'general', { model: 'gemini-x' });
            expect(events).toEqual([]);
            const done = await waitForDone(events);

            expect(events[0]).toEqual({ type: 'started', runId, engine: 'antigravity' });
            expect(events.filter((event) => event.type === 'tool')).toEqual([
                { type: 'tool', runId, name: 'run_command', summary: 'ls -la', state: 'ACTIVE', command: 'ls -la' },
                {
                    type: 'tool',
                    runId,
                    name: 'run_command',
                    summary: 'ls -la',
                    state: 'DONE',
                    error: 'Command needs approval',
                    command: 'ls -la',
                },
            ]);
            expect(events.filter((event) => event.type === 'text').map((event) => event.delta)).toEqual([
                'Hello ',
                'world',
            ]);
            expect(done).toEqual({
                type: 'done',
                runId,
                status: 'SUCCESS',
                response: 'Hello world',
                conversationId: 'c1',
            });

            const { args, cwd } = readArgs();
            expect(cwd).toBe(path.join(layout.userData, 'agent-workspace'));
            expect(args).toEqual([
                '-p',
                'hello',
                '--output-format',
                'stream-json',
                '--print-timeout',
                '5m',
                '--sandbox',
                '--model',
                'gemini-x',
            ]);
            expect(args).not.toContain('--dangerously-skip-permissions');
            expect(manager.isRunning()).toBe(false);
        });

        it('handles partial lines and invalid JSON lines', async () => {
            const manager = createManager();
            const { events } = await startRun(manager, 'MODE:partial');
            const done = await waitForDone(events);
            expect(events.filter((event) => event.type === 'text').map((event) => event.delta)).toEqual(['Hel', 'lo']);
            expect(done.status).toBe('SUCCESS');
            expect(done.response).toBe('Hello');
        });

        it('continues a conversation', async () => {
            const manager = createManager();
            const { events } = await startRun(manager, 'more', 'general', { conversationId: 'c1' });
            await waitForDone(events);
            expect(readArgs().args).toEqual(expect.arrayContaining(['--conversation', 'c1']));
        });

        it('adds read-only context about named folders to the prompt', async () => {
            fs.mkdirSync(path.join(layout.home, 'Downloads'));
            fs.writeFileSync(path.join(layout.home, 'Downloads', 'report.pdf'), 'pdf');
            const manager = createManager();
            const { events } = await startRun(manager, 'what is in my downloads', 'documents');
            await waitForDone(events);
            const prompt = readArgs().args[1];
            expect(prompt).toContain('scratch workspace');
            expect(prompt).toContain(path.join(layout.home, 'Downloads', 'report.pdf'));
        });

        it('turns a structured answer into a stored plan and leaves out unsafe actions', async () => {
            const manager = createManager();
            const { runId, events } = await startRun(manager, 'MODE:plan sort my files', 'files');
            const done = await waitForDone(events);

            const planEvent = events.find((event) => event.type === 'plan');
            expect(planEvent).toBeDefined();
            const plan = planEvent?.type === 'plan' ? planEvent.plan : null;
            expect(plan?.actions.map((action) => action.op)).toEqual(['mkdir', 'move']);
            expect(plan?.actions.every((action) => typeof action.id === 'string' && action.id.length > 0)).toBe(true);
            expect(plan?.summary).toContain('1 proposed change outside your home folder');
            expect(done).toMatchObject({ status: 'SUCCESS', response: plan?.summary });
            expect(events.some((event) => event.type === 'text')).toBe(false);
            expect(manager.getPlan(runId)).toEqual(plan);

            const args = readArgs().args;
            const schema = JSON.parse(args[args.indexOf('--json-schema') + 1] ?? '{}');
            expect(schema.required).toEqual(['summary', 'actions']);
            expect(args[1]).toContain('Do not create, move, copy, rename or delete any file yourself');

            // Apply once, then undo.
            fs.writeFileSync(path.join(layout.home, 'a.txt'), 'A');
            const applied = await manager.applyPlan(runId);
            expect(applied).toEqual({ applied: 2, failed: [], undoAvailable: true });
            expect(fs.readFileSync(path.join(layout.home, 'Sorted', 'a.txt'), 'utf8')).toBe('A');

            const again = await manager.applyPlan(runId);
            expect(again.applied).toBe(0);
            expect(again.failed[0]?.error).toContain('already been applied');
            expect(again.undoAvailable).toBe(true);

            const undone = await manager.undoLastPlan();
            expect(undone).toEqual({ applied: 2, failed: [], undoAvailable: false });
            expect(fs.readFileSync(path.join(layout.home, 'a.txt'), 'utf8')).toBe('A');
            expect(fs.existsSync(path.join(layout.home, 'Sorted'))).toBe(false);

            const nothing = await manager.undoLastPlan();
            expect(nothing.failed[0]?.error).toContain('nothing to undo');
        });

        it('reports a file run without a valid plan as an error', async () => {
            const manager = createManager();
            const { runId, events } = await startRun(manager, 'MODE:badplan', 'files');
            const done = await waitForDone(events);
            expect(done.status).toBe('ERROR');
            expect(done.error).toContain('did not return a file plan');
            expect(manager.getPlan(runId)).toBeNull();
            expect((await manager.applyPlan(runId)).failed[0]?.error).toContain('no file plan');
            expect((await manager.applyPlan(42)).failed[0]?.error).toContain('Invalid run id');
        });

        it('tells the user to sign in when the CLI needs authentication', async () => {
            const manager = createManager();
            const { events } = await startRun(manager, 'MODE:auth');
            const done = await waitForDone(events);
            expect(done.status).toBe('ERROR');
            expect(done.error).toContain('run `agy` once');
        });

        it('reports other failures from stderr', async () => {
            const manager = createManager();
            const { events } = await startRun(manager, 'MODE:fail');
            const done = await waitForDone(events);
            expect(done).toMatchObject({ status: 'ERROR', error: 'line one something broke' });
        });

        it('accepts text without a result event when the CLI exits cleanly', async () => {
            const manager = createManager();
            const { events } = await startRun(manager, 'MODE:noresult');
            const done = await waitForDone(events);
            expect(done).toMatchObject({ status: 'SUCCESS', response: 'only text', conversationId: 'c1' });
        });

        it('cancels a run with SIGINT and reports CANCELED', async () => {
            const manager = createManager();
            const { runId, events } = await startRun(manager, 'MODE:hang');
            await vi.waitFor(() => expect(events.some((event) => event.type === 'started')).toBe(true));
            expect(manager.isRunning()).toBe(true);
            expect(manager.cancel('other-run')).toBe(false);
            expect(manager.cancel(runId)).toBe(true);
            const done = await waitForDone(events);
            expect(done).toMatchObject({ status: 'CANCELED', runId });
            expect(manager.cancel(runId)).toBe(false);
            expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
        });

        it('falls back to SIGTERM when the CLI ignores SIGINT', async () => {
            const manager = createManager({
                cancelGraceMs: 100,
                env: {
                    PATH: fakePath(layout.bin),
                    FAKE_HOME: layout.home,
                    FAKE_ARGS_FILE: argsFile,
                    FAKE_IGNORE_SIGINT: '1',
                },
            });
            const { runId, events } = await startRun(manager, 'MODE:hang');
            await vi.waitFor(() => expect(events.some((event) => event.type === 'started')).toBe(true));
            const pid = findChildPid(manager);
            manager.cancel(runId);
            await waitForDone(events);
            await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 3000 });
        });

        it('stops a run that takes too long with TIMEOUT', async () => {
            const manager = createManager({ runTimeoutMs: 300, cancelGraceMs: 100 });
            const { events } = await startRun(manager, 'MODE:hang');
            const done = await waitForDone(events);
            expect(done.status).toBe('TIMEOUT');
            expect(done.error).toContain('too long');
        });

        it('cancels the previous run when a new one starts', async () => {
            const manager = createManager();
            const first = await startRun(manager, 'MODE:hang');
            await vi.waitFor(() => expect(first.events.some((event) => event.type === 'started')).toBe(true));
            const second = await startRun(manager, 'hello');
            const firstDone = await waitForDone(first.events);
            expect(firstDone.status).toBe('CANCELED');
            const secondDone = await waitForDone(second.events);
            expect(secondDone.status).toBe('SUCCESS');
        });

        it('kills the CLI on dispose and refuses new runs', async () => {
            const manager = createManager();
            const { events } = await startRun(manager, 'MODE:hang');
            await vi.waitFor(() => expect(events.some((event) => event.type === 'started')).toBe(true));
            const pid = findChildPid(manager);
            manager.dispose();
            await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 3000 });
            await expect(startRun(manager, 'hello')).rejects.toThrow('quitting');
        });

        it('rejects invalid requests before starting anything', async () => {
            const manager = createManager();
            await expect(startRun(manager, '')).rejects.toThrow('empty');
        });

        it('stops a run whose init event reports a permission mode that does not ask', async () => {
            const manager = createManager();
            const { events } = await startRun(manager, 'MODE:turbo');
            const done = await waitForDone(events);
            expect(done.status).toBe('ERROR');
            expect(done.error).toBe(
                'Antigravity CLI is set to run tools without asking; Quick Chat will not use it like that.'
            );
            const pid = (manager as unknown as { activeRun: { child: { pid: number } | null } }).activeRun.child?.pid;
            if (pid) {
                await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 3000 });
            }
            expect(events.filter((event) => event.type === 'text')).toEqual([]);
        });

        it('forwards no events after done when a cancelled CLI keeps talking', async () => {
            const manager = createManager({
                cancelGraceMs: 300,
                env: {
                    PATH: fakePath(layout.bin),
                    FAKE_HOME: layout.home,
                    FAKE_ARGS_FILE: argsFile,
                    FAKE_IGNORE_SIGINT: '1',
                    FAKE_CHATTY: '1',
                },
            });
            const { runId, events } = await startRun(manager, 'MODE:hang');
            await vi.waitFor(() => expect(events.some((event) => event.type === 'text')).toBe(true));
            manager.cancel(runId);
            await waitForDone(events);
            const count = events.length;
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(events).toHaveLength(count);
            expect(events.at(-1)?.type).toBe('done');
        });

        it('empties the workspace before every run', async () => {
            const workspace = path.join(layout.userData, 'agent-workspace');
            for (const file of [
                'GEMINI.md',
                '.env',
                path.join('.gemini', '.env'),
                path.join('.agents', 'rules', 'r.md'),
            ]) {
                fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
                fs.writeFileSync(path.join(workspace, file), 'planted');
            }
            const manager = createManager();
            const { events } = await startRun(manager, 'hello');
            await waitForDone(events);
            expect(readArgs().files).toEqual(['.git']);
        });

        it("shows a run's input copies to the CLI and removes them when the run ends", async () => {
            fs.writeFileSync(path.join(layout.home, 'doc.txt'), 'quarterly numbers');
            const manager = createManager();
            const { runId, events } = await startRun(manager, 'summarise ~/doc.txt', 'documents');
            await waitForDone(events);
            expect(readArgs().inputs).toEqual([`${runId}/1-doc.txt`]);
            const inputs = path.join(layout.userData, 'agent-workspace', 'inputs', runId);
            await vi.waitFor(() => expect(fs.existsSync(inputs)).toBe(false));
        });

        it('writes an attached screenshot into the run inputs and names it in the prompt', async () => {
            const png = Buffer.from('fake screenshot png');
            let seenOnSpawn: Buffer | null = null;
            const { spawn } = await import('node:child_process');
            const manager = createManager({
                spawnProcess: ((command: string, args: string[], options: object) => {
                    const cwd = (options as { cwd: string }).cwd;
                    const inputs = fs.readdirSync(path.join(cwd, 'inputs'));
                    seenOnSpawn = fs.readFileSync(path.join(cwd, 'inputs', inputs[0], 'screenshot.png'));
                    return spawn(command, args, options);
                }) as unknown as typeof import('node:child_process').spawn,
            });
            const events: AgentRunEvent[] = [];
            const { runId } = await manager.run(
                { prompt: 'what is on my screen?', category: 'general' },
                { enginePreference: 'auto', model: '', screenshot: png, emit: (event) => events.push(event) }
            );
            const done = await waitForDone(events);
            expect(done.status).toBe('SUCCESS');
            expect(seenOnSpawn).toEqual(png);

            const { args, inputs } = readArgs();
            expect(inputs).toEqual([`${runId}/screenshot.png`]);
            const prompt = args[args.indexOf('-p') + 1];
            expect(prompt).toContain(`inputs/${runId}/screenshot.png`);
            expect(prompt.endsWith('User request:\nwhat is on my screen?')).toBe(true);

            const inputsDir = path.join(layout.userData, 'agent-workspace', 'inputs', runId);
            await vi.waitFor(() => expect(fs.existsSync(inputsDir)).toBe(false));
        });

        it('passes a question without a screenshot as it is', async () => {
            const manager = createManager();
            const { events } = await startRun(manager, 'hello');
            await waitForDone(events);
            const { args, inputs } = readArgs();
            expect(inputs).toEqual([]);
            expect(args[args.indexOf('-p') + 1]).toBe('hello');
        });

        it('checks the settings again before running even when the status is cached', async () => {
            const manager = createManager();
            expect((await manager.getStatus('antigravity')).available).toBe(true);
            writeJson(agySettingsFile(), { toolPermission: 'proceed-in-sandbox' });
            const { events } = await startRun(manager, 'hello', 'general', { enginePreference: 'antigravity' });
            const done = await waitForDone(events);
            expect(done.status).toBe('ERROR');
            expect(done.error).toContain('proceed-in-sandbox');
            expect(events.some((event) => event.type === 'started')).toBe(false);
        });

        it('lets a plan whose actions all failed be applied again', async () => {
            const manager = createManager();
            const { runId, events } = await startRun(manager, 'MODE:plan', 'files');
            await waitForDone(events);
            fs.writeFileSync(path.join(layout.home, 'Sorted'), 'a file in the way');

            const first = await manager.applyPlan(runId);
            expect(first.applied).toBe(0);
            expect(first.failed).toHaveLength(2);
            expect(first.undoAvailable).toBe(false);

            fs.rmSync(path.join(layout.home, 'Sorted'));
            fs.writeFileSync(path.join(layout.home, 'a.txt'), 'A');
            const second = await manager.applyPlan(runId);
            expect(second).toEqual({ applied: 2, failed: [], undoAvailable: true });
        });
    });

    describe('settings checks', () => {
        it('refuses Gemini CLI when its settings auto-approve tools', async () => {
            installFakeCli(layout.bin, 'gemini');
            writeJson(geminiSettingsFile(), { tools: { allowed: ['run_shell_command'] } });
            const manager = createManager();
            const status = await manager.getStatus('auto');
            expect(status).toMatchObject({ engine: 'gemini-cli', available: false });
            expect(status.error).toContain('run_shell_command');

            // Antigravity is used when it is installed and its settings are safe.
            installFakeCli(layout.bin, 'agy');
            expect(await manager.getStatus('auto', true)).toMatchObject({ engine: 'antigravity', available: true });
        });

        it('refuses Antigravity for mcp() allow rules in the desktop config', async () => {
            installFakeCli(layout.bin, 'agy');
            writeJson(path.join(layout.home, '.gemini', 'config', 'config.json'), {
                permissions: { allow: ['mcp(*)'] },
            });
            const status = await createManager().getStatus('antigravity');
            expect(status.available).toBe(false);
            expect(status.error).toContain('mcp(*)');
        });
    });

    describe('run without an engine or with Gemini CLI', () => {
        it('finishes with an error when no engine is installed', async () => {
            const manager = createManager();
            const { events } = await startRun(manager, 'hello');
            const done = await waitForDone(events);
            expect(done.status).toBe('ERROR');
            expect(done.error).toContain('No agent CLI was found');
            expect(events.some((event) => event.type === 'started')).toBe(false);
        });

        it('reports a spawn failure', async () => {
            installFakeCli(layout.bin, 'agy');
            const manager = createManager({
                spawnProcess: (() => {
                    throw new Error('spawn EACCES');
                }) as unknown as typeof import('node:child_process').spawn,
            });
            const { events } = await startRun(manager, 'hello');
            const done = await waitForDone(events);
            expect(done.error).toContain('spawn EACCES');
        });

        it('drives Gemini CLI with its own flags and event shapes', async () => {
            installFakeCli(layout.bin, 'gemini');
            const manager = createManager();
            const { runId, events } = await startRun(manager, 'hello', 'general', {
                conversationId: 's0',
                model: 'flash',
            });
            const done = await waitForDone(events);
            expect(events[0]).toEqual({ type: 'started', runId, engine: 'gemini-cli' });
            expect(events.filter((event) => event.type === 'tool')).toHaveLength(2);
            expect(done).toMatchObject({ status: 'SUCCESS', response: 'Hello from Gemini', conversationId: 's1' });
            expect(readArgs().args).toEqual([
                '-p',
                'hello',
                '--output-format',
                'stream-json',
                '--approval-mode',
                'default',
                '--model',
                'flash',
                '--resume',
                's0',
            ]);
        });

        it('reads a Gemini CLI plan from a fenced JSON block', async () => {
            installFakeCli(layout.bin, 'gemini');
            const manager = createManager();
            const { events } = await startRun(manager, 'MODE:plan', 'files', { enginePreference: 'gemini-cli' });
            const done = await waitForDone(events);
            expect(done.status).toBe('SUCCESS');
            const planEvent = events.find((event) => event.type === 'plan');
            expect(planEvent?.type === 'plan' && planEvent.plan.actions).toHaveLength(2);
            expect(readArgs().args).not.toContain('--json-schema');
        });

        it('explains a missing Gemini API key', async () => {
            installFakeCli(layout.bin, 'gemini');
            const manager = createManager();
            const { events } = await startRun(manager, 'MODE:apikey');
            const done = await waitForDone(events);
            expect(done.error).toContain('GEMINI_API_KEY');
        });
    });

    describe('blocked commands and allow rules (Antigravity CLI)', () => {
        const recordFile = () => path.join(layout.userData, 'agent-permissions.json');
        const readRecord = () => JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
        const readAllow = (): string[] =>
            JSON.parse(fs.readFileSync(agySettingsFile(), 'utf8')).permissions?.allow ?? [];
        const env = (extra: Record<string, string> = {}) => ({
            PATH: fakePath(layout.bin),
            FAKE_HOME: layout.home,
            FAKE_ARGS_FILE: argsFile,
            ...extra,
        });

        const startBlocked = async (manager: AgentManager, category: 'general' | 'files' = 'general') => {
            const first = await startRun(manager, 'MODE:blocked how much disk space is left', category);
            const done = await waitForDone(first.events);
            return { ...first, done };
        };

        const decide = async (manager: AgentManager, runId: string, decision: 'once' | 'always' | 'without') => {
            const events: AgentRunEvent[] = [];
            const result = await manager.approveBlockedCommands(
                { runId, decision },
                { enginePreference: 'auto', model: '', emit: (event) => events.push(event) }
            );
            return { result, events };
        };

        beforeEach(() => {
            installFakeCli(layout.bin, 'agy');
        });

        it('reports the refused command instead of an empty answer', async () => {
            const manager = createManager();
            const { runId, events, done } = await startBlocked(manager);
            expect(
                events.filter((event) => event.type === 'tool').map((event) => event.type === 'tool' && event.stepIndex)
            ).toEqual([3, 3]);
            expect(done).toEqual({
                type: 'done',
                runId,
                status: 'SUCCESS',
                response: '',
                conversationId: 'c1',
                blocked: [
                    {
                        tool: 'run_command',
                        command: 'df -h',
                        summary: 'df -h',
                        stepIndex: 3,
                        lastingRule: 'command(df)',
                    },
                ],
                deniedActions: ['command'],
                canResume: true,
            });
        });

        it('counts only the last output-less commands as refused, not a silent command that ran', async () => {
            const manager = createManager({ env: env({ FAKE_SILENT_FIRST: '1' }) });
            const { done } = await startBlocked(manager);
            expect(done.blocked?.map((entry) => entry.command)).toEqual(['df -h']);

            // Without denied_actions a silent command is just a command that ran.
            const silent = await startRun(manager, 'MODE:silent');
            const silentDone = await waitForDone(silent.events);
            expect(silentDone).toMatchObject({ status: 'SUCCESS', response: 'done\n' });
            expect(silentDone.blocked).toBeUndefined();
            expect(silentDone.canResume).toBeUndefined();
        });

        it('finds a refused command that agy reported only as ACTIVE, never DONE', async () => {
            const manager = createManager({
                env: env({ FAKE_ACTIVE_ONLY: '1', FAKE_RAN_FIRST: '1', FAKE_BLOCKED_COMMAND: 'cat /etc/fstab' }),
            });
            const { done } = await startBlocked(manager);
            expect(done.blocked?.map((entry) => entry.command)).toEqual(['cat /etc/fstab']);
            expect(done.canResume).toBe(true);
        });

        it('passes on what a command printed, without carriage returns', async () => {
            const manager = createManager({ env: env({ FAKE_RAN_FIRST: '1' }) });
            const { events, done } = await startBlocked(manager);
            const ran = events.find(
                (event) => event.type === 'tool' && event.state === 'DONE' && event.stepIndex === 1
            );
            expect(ran?.type === 'tool' && ran.output).toBe(
                'Filesystem Size Used Avail Use% Mounted on\n/dev/nvme0n1p6 400G 120G 280G 30% /'
            );
            // The command that printed is not the refused one.
            expect(done.blocked?.map((entry) => entry.command)).toEqual(['df -h']);
        });

        it('offers only Allow for this answer, with a caution, for a state-changing command', async () => {
            const manager = createManager({ env: env({ FAKE_BLOCKED_COMMAND: 'rm -rf ~/old' }) });
            const { runId, done } = await startBlocked(manager);
            expect(done.blocked).toEqual([
                { tool: 'run_command', command: 'rm -rf ~/old', summary: 'rm -rf ~/old', stepIndex: 3, caution: true },
            ]);
            expect(done.canResume).toBe(true);
            expect((await decide(manager, runId, 'always')).result.error).toContain('only be allowed for this answer');

            const files = await startBlocked(manager, 'files');
            expect(files.done.canResume).toBeUndefined();
            expect((await decide(manager, files.runId, 'once')).result.error).toContain('no longer be approved');
        });

        it('Allow for this answer adds a full-line rule for the resumed run only and removes it afterwards', async () => {
            fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
            fs.writeFileSync(
                agySettingsFile(),
                JSON.stringify({ model: 'x', permissions: { allow: ['command(ls)'], deny: ['command(rm)'] } })
            );
            const manager = createManager();
            const { runId } = await startBlocked(manager);

            const { result, events } = await decide(manager, runId, 'once');
            expect(result.runId).toEqual(expect.any(String));
            expect(result.runId).not.toBe(runId);
            const done = await waitForDone(events);
            expect(done).toMatchObject({ runId: result.runId, status: 'SUCCESS', response: 'Hello world' });

            // While the resumed run ran, the CLI saw the full-line rule next to the user's own.
            const seen = readArgs();
            expect(seen.allow).toEqual(['command(ls)', 'command(df -h)']);
            expect(seen.args).toEqual(expect.arrayContaining(['--conversation', 'c1', '--sandbox']));
            expect(seen.args[1]).toBe(
                "The user approved this command: `df -h`. Run it now and answer the original question from the output. Other commands still need the user's approval, so only run another one if the question cannot be answered without it."
            );
            expect(seen.args).not.toContain('--dangerously-skip-permissions');

            // Afterwards only the user's settings are left, and nothing is pending.
            expect(JSON.parse(fs.readFileSync(agySettingsFile(), 'utf8'))).toEqual({
                model: 'x',
                permissions: { allow: ['command(ls)'], deny: ['command(rm)'] },
            });
            expect(readRecord().pending).toEqual([]);

            // A run's commands are decided about once.
            expect((await decide(manager, runId, 'once')).result.error).toContain('no longer be approved');
        });

        it('gathers no context and copies no files for a resumed run', async () => {
            fs.mkdirSync(path.join(layout.home, 'Documents'));
            fs.writeFileSync(path.join(layout.home, 'Documents', 'taxes.csv'), 'secret,1\n');
            for (const decision of ['once', 'without'] as const) {
                const manager = createManager({
                    env: env({ FAKE_BLOCKED_COMMAND: 'wc -l ~/Documents/taxes.csv' }),
                });
                const { runId } = await startBlocked(manager);
                const { events } = await decide(manager, runId, decision);
                await waitForDone(events);
                const seen = readArgs();
                expect(seen.inputs).toEqual([]);
                expect(seen.files).toEqual(['.git']);
                expect(seen.args[1]).not.toContain('gathered');
                expect(seen.args[1]).not.toContain('secret');
                expect(seen.args[1]).toMatch(
                    /^The user (approved this command|did not allow): `wc -l ~\/Documents\/taxes.csv`/
                );
            }
        });

        it('Answer without it resumes without rules and asks for an answer from what the agent has', async () => {
            const manager = createManager();
            const { runId } = await startBlocked(manager);
            const { result, events } = await decide(manager, runId, 'without');
            expect(result.runId).toEqual(expect.any(String));
            expect((await waitForDone(events)).status).toBe('SUCCESS');
            const seen = readArgs();
            expect(seen.args[1]).toBe(
                'The user did not allow: `df -h`. Do not run any more commands. Answer the original question from the command output you already have, and say briefly what you could not check.'
            );
            expect(seen.args).toEqual(expect.arrayContaining(['--conversation', 'c1']));
            expect(seen.allow).toBeNull();
            expect(fs.existsSync(agySettingsFile())).toBe(false);
        });

        it('does not offer another decision when the run that answers without the commands is blocked again', async () => {
            // The resumed prompt names the command, so this one makes the fake CLI block again.
            const manager = createManager({ env: env({ FAKE_BLOCKED_COMMAND: 'df MODE:blocked' }) });
            const { runId } = await startBlocked(manager);
            const { result, events } = await decide(manager, runId, 'without');
            const done = await waitForDone(events);
            expect(done.blocked).toHaveLength(1);
            expect(done.canResume).toBeUndefined();
            expect((await decide(manager, result.runId ?? '', 'without')).result.error).toContain(
                'no longer be approved'
            );
        });

        it('refuses to allow a command with control or invisible characters, but can answer without it', async () => {
            const manager = createManager({ env: env({ FAKE_BLOCKED_COMMAND: 'ls ‮txt.exe' }) });
            const { runId, done } = await startBlocked(manager);
            expect(done.canResume).toBe(true);
            expect(done.approvalUnavailable).toContain('invisible characters');
            for (const decision of ['once', 'always'] as const) {
                expect((await decide(manager, runId, decision)).result.error).toContain('invisible characters');
            }
            expect(fs.existsSync(agySettingsFile())).toBe(false);
            const { result } = await decide(manager, runId, 'without');
            expect(result.runId).toEqual(expect.any(String));
        });

        for (const [name, command, extra, expected] of [
            ['is cancelled', 'du -sh MODE:hang', {}, 'CANCELED'],
            ['times out', 'du -sh MODE:hang', { runTimeoutMs: 600 }, 'TIMEOUT'],
            ['fails', 'du -sh MODE:fail', {}, 'ERROR'],
        ] as const) {
            it(`removes the rule for this answer when the resumed run ${name}`, async () => {
                const manager = createManager({ env: env({ FAKE_BLOCKED_COMMAND: command }), ...extra });
                const { runId } = await startBlocked(manager);
                const { result, events } = await decide(manager, runId, 'once');
                await vi.waitFor(() => expect(events.some((event) => event.type === 'started')).toBe(true));
                if (expected === 'CANCELED') {
                    expect(readAllow()).toEqual([`command(${command})`]);
                    expect(readRecord().pending).toEqual([`command(${command})`]);
                    manager.cancel(result.runId);
                }
                expect((await waitForDone(events)).status).toBe(expected);
                expect(readAllow()).toEqual([]);
                expect(readRecord().pending).toEqual([]);
            });
        }

        it('removes leftover rules for an answer at startup, but none the app or the user still wants', () => {
            fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
            fs.writeFileSync(
                agySettingsFile(),
                JSON.stringify({ permissions: { allow: ['command(ls)', 'command(df -h)', 'command(free)'] } })
            );
            fs.writeFileSync(
                recordFile(),
                JSON.stringify({
                    lasting: ['command(free)'],
                    pending: ['command(df -h)', 'command(free)', 'command(ls)'],
                    userOwned: ['command(ls)'],
                })
            );
            createManager().initialize();
            expect(readAllow()).toEqual(['command(ls)', 'command(free)']);
            expect(readRecord()).toMatchObject({ pending: [], lasting: ['command(free)'], userOwned: [] });
        });

        it('keeps pending rules when the settings file is not valid JSON at startup', () => {
            fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
            fs.writeFileSync(agySettingsFile(), '{ broken');
            fs.writeFileSync(recordFile(), JSON.stringify({ pending: ['command(df -h)'] }));
            createManager().initialize();
            expect(fs.readFileSync(agySettingsFile(), 'utf8')).toBe('{ broken');
            expect(readRecord().pending).toEqual(['command(df -h)']);
        });

        it('Always allow adds the lasting lookup rule, which Options lists and can remove', async () => {
            const manager = createManager();
            const { runId } = await startBlocked(manager);
            const { result, events } = await decide(manager, runId, 'always');
            expect(result.runId).toEqual(expect.any(String));
            await waitForDone(events);
            expect(readArgs().allow).toEqual(['command(df)']);
            expect(readAllow()).toEqual(['command(df)']);
            expect(readRecord()).toMatchObject({ lasting: ['command(df)'], pending: [] });
            // The engine stays usable with the rule.
            expect(await manager.getStatus('antigravity', true)).toMatchObject({ available: true });

            expect(await manager.getPermissions('antigravity')).toEqual({
                supported: true,
                settingsFile: agySettingsFile(),
                lookupCommandsEnabled: false,
                allowedRules: ['command(df)'],
            });
            const removed = await manager.removeAllowedRule('command(df)', 'antigravity');
            expect(removed.allowedRules).toEqual([]);
            expect(readAllow()).toEqual([]);
        });

        it('refuses Always allow for a command not in the lookup list', async () => {
            const manager = createManager({ env: env({ FAKE_BLOCKED_COMMAND: 'df -h | sort' }) });
            const { runId, done } = await startBlocked(manager);
            expect(done.blocked?.[0]?.lastingRule).toBeUndefined();
            expect((await decide(manager, runId, 'always')).result.error).toContain('only be allowed for this answer');
            expect(fs.existsSync(agySettingsFile())).toBe(false);
            const once = await decide(manager, runId, 'once');
            await waitForDone(once.events);
            expect(readArgs().allow).toEqual(['command(df -h | sort)']);
        });

        it("records the user's choice even when the rule is already there, and never removes the user's own rule", async () => {
            fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
            fs.writeFileSync(agySettingsFile(), JSON.stringify({ permissions: { allow: ['command(df)'] } }));
            const manager = createManager();
            const { runId } = await startBlocked(manager);
            const { events } = await decide(manager, runId, 'always');
            await waitForDone(events);
            expect(readRecord()).toMatchObject({ lasting: ['command(df)'], userOwned: ['command(df)'] });
            expect((await manager.getPermissions('antigravity')).allowedRules).toEqual(['command(df)']);
            // Taking the choice back leaves the rule the user had before.
            await manager.removeAllowedRule('command(df)', 'antigravity');
            expect(readAllow()).toEqual(['command(df)']);
            expect(readRecord()).toMatchObject({ lasting: [], userOwned: [] });
            expect((await manager.removeAllowedRule('command(df)', 'antigravity')).error).toContain('did not add');
            expect((await manager.removeAllowedRule(42, 'antigravity')).error).toContain('did not add');
        });

        it('keeps a rule that one source still wants when another lets go of it', async () => {
            const manager = createManager({ env: env({ FAKE_BLOCKED_COMMAND: 'df' }) });
            await manager.setLookupCommands(true, 'antigravity');
            const first = await startBlocked(manager);
            const always = await decide(manager, first.runId, 'always');
            await waitForDone(always.events);
            expect(readRecord().lasting).toEqual(['command(df)']);
            expect(readRecord().userOwned).toEqual([]);

            // The lookup list goes off; "Always allow df" still wants command(df).
            await manager.setLookupCommands(false, 'antigravity');
            expect(readAllow()).toEqual(['command(df)']);

            // A rule for this answer equal to a lasting rule stays when the answer ends.
            const second = await startBlocked(manager);
            const once = await decide(manager, second.runId, 'once');
            await waitForDone(once.events);
            expect(readAllow()).toEqual(['command(df)']);
            expect(readRecord().pending).toEqual([]);

            // Taking the choice back finally removes it.
            await manager.removeAllowedRule('command(df)', 'antigravity');
            expect(readAllow()).toEqual([]);
        });

        it('refuses to decide when the settings file is not valid JSON, and keeps the card open', async () => {
            const manager = createManager();
            const { runId } = await startBlocked(manager);
            fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
            fs.writeFileSync(agySettingsFile(), '{ "permissions": // no\n }');
            for (const decision of ['once', 'always'] as const) {
                const { result } = await decide(manager, runId, decision);
                expect(result.error).toContain('not valid JSON');
            }
            expect(fs.readFileSync(agySettingsFile(), 'utf8')).toBe('{ "permissions": // no\n }');

            fs.writeFileSync(agySettingsFile(), '{}');
            const { result, events } = await decide(manager, runId, 'once');
            expect(result.runId).toEqual(expect.any(String));
            await waitForDone(events);
        });

        it('rejects invalid decisions', async () => {
            const manager = createManager();
            const options = { enginePreference: 'auto' as const, model: '', emit: () => undefined };
            expect((await manager.approveBlockedCommands(null, options)).error).toBe('Invalid approval.');
            expect((await manager.approveBlockedCommands({ runId: 'x', decision: 'never' }, options)).error).toBe(
                'Invalid approval.'
            );
            expect((await manager.approveBlockedCommands({ runId: 'x', decision: 'once' }, options)).error).toContain(
                'no longer be approved'
            );
        });

        it("turns the lookup command list on and off, keeping the user's own rules", async () => {
            fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
            fs.writeFileSync(
                agySettingsFile(),
                JSON.stringify({ theme: 'x', permissions: { allow: ['command(df)', 'command(npm)'] } })
            );
            const manager = createManager();

            const on = await manager.setLookupCommands(true, 'antigravity');
            expect(on).toMatchObject({ supported: true, lookupCommandsEnabled: true });
            expect(on.error).toBeUndefined();
            const allow = readAllow();
            for (const rule of LOOKUP_COMMAND_RULES) {
                expect(allow).toContain(rule);
            }
            expect(allow.filter((rule) => rule === 'command(df)')).toHaveLength(1);
            expect(readRecord().lookup).toEqual([...LOOKUP_COMMAND_RULES]);
            expect(readRecord().userOwned).toEqual(['command(df)']);
            expect(await manager.getStatus('antigravity', true)).toMatchObject({ available: true });

            const off = await manager.setLookupCommands(false, 'antigravity');
            expect(off.lookupCommandsEnabled).toBe(false);
            expect(JSON.parse(fs.readFileSync(agySettingsFile(), 'utf8'))).toEqual({
                theme: 'x',
                permissions: { allow: ['command(df)', 'command(npm)'] },
            });
            await expect(manager.setLookupCommands('yes', 'antigravity')).rejects.toThrow('Invalid value');
        });

        it('reports an invalid settings file in Options and changes nothing', async () => {
            fs.mkdirSync(path.dirname(agySettingsFile()), { recursive: true });
            fs.writeFileSync(agySettingsFile(), 'nope');
            const manager = createManager();
            expect((await manager.getPermissions('antigravity')).error).toContain('not valid JSON');
            const result = await manager.setLookupCommands(true, 'antigravity');
            expect(result.error).toContain('not valid JSON');
            expect(result.lookupCommandsEnabled).toBe(false);
            expect(fs.readFileSync(agySettingsFile(), 'utf8')).toBe('nope');
        });

        it('says command rules are not supported for Gemini CLI or on Windows', async () => {
            installFakeCli(layout.bin, 'gemini');
            const manager = createManager();
            expect(await manager.getPermissions('gemini-cli')).toMatchObject({ supported: false, allowedRules: [] });
            expect((await manager.setLookupCommands(true, 'gemini-cli')).supported).toBe(false);

            fs.copyFileSync(path.join(layout.bin, 'agy'), path.join(layout.bin, 'agy.exe'));
            const windows = createManager({ platform: 'win32', env: { PATH: layout.bin } });
            expect(await windows.getStatus('antigravity')).toMatchObject({ engine: 'antigravity' });
            expect(await windows.getPermissions('antigravity')).toMatchObject({ supported: false });
            expect((await windows.setLookupCommands(true, 'antigravity')).supported).toBe(false);
            expect(fs.existsSync(agySettingsFile())).toBe(false);
        });

        it('removes the rules for an answer when the app quits during the resumed run', async () => {
            const manager = createManager({ env: env({ FAKE_BLOCKED_COMMAND: 'du -sh MODE:hang' }) });
            const { runId } = await startBlocked(manager);
            const { events } = await decide(manager, runId, 'once');
            await vi.waitFor(() => expect(events.some((event) => event.type === 'started')).toBe(true));
            expect(readAllow()).toHaveLength(1);
            manager.dispose();
            expect(readAllow()).toEqual([]);
            expect(readRecord().pending).toEqual([]);
        });
    });

    describe('listModels', () => {
        const callsFile = () => path.join(layout.root, 'calls.txt');
        const readCalls = (): string[][] =>
            fs.existsSync(callsFile())
                ? fs
                      .readFileSync(callsFile(), 'utf8')
                      .trim()
                      .split('\n')
                      .map((line) => JSON.parse(line))
                : [];
        const modelEnv = (extra: Record<string, string> = {}) => ({
            PATH: fakePath(layout.bin),
            FAKE_HOME: layout.home,
            FAKE_ARGS_FILE: argsFile,
            FAKE_CALLS_FILE: callsFile(),
            ...extra,
        });

        beforeEach(() => {
            installFakeCli(layout.bin, 'agy');
        });

        it('lists the models, then reads the default, and caches them for 5 minutes', async () => {
            let now = 0;
            // A leftover in the CLI's folder is cleaned away.
            fs.mkdirSync(path.join(layout.userData, 'agent-cli'), { recursive: true });
            fs.writeFileSync(path.join(layout.userData, 'agent-cli', 'GEMINI.md'), 'planted');
            const manager = createManager({ now: () => now, env: modelEnv() });
            const list = await manager.listModels('auto');
            expect(list).toEqual({
                models: [
                    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
                    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
                ],
                defaultModel: { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
            });
            expect(readCalls()).toEqual([['models'], ['-p', '/model', '--print-timeout', '20s']]);
            expect(readArgs().cwd).toBe(path.join(layout.userData, 'agent-cli'));
            expect(readArgs().files).toEqual([]);

            expect(await manager.listModels('auto')).toBe(list);
            expect(readCalls()).toHaveLength(2);
            await manager.listModels('auto', true);
            expect(readCalls()).toHaveLength(4);
            now += 5 * 60 * 1000 + 1;
            await manager.listModels('auto');
            expect(readCalls()).toHaveLength(6);
        });

        it('ignores a default that is not one of the listed models', async () => {
            const manager = createManager({
                env: modelEnv({ FAKE_DEFAULT_MODEL: 'made-up\tSomething the model said' }),
            });
            const list = await manager.listModels('auto');
            expect(list.models).toHaveLength(2);
            expect(list.defaultModel).toBeUndefined();
        });

        it('does not ask for the default when listing fails, and keeps the failure for a minute', async () => {
            let now = 0;
            const manager = createManager({ now: () => now, env: modelEnv({ FAKE_MODELS_FAIL: '1' }) });
            expect(await manager.listModels('auto')).toEqual({
                models: [],
                error: 'Could not list the models of Antigravity CLI.',
            });
            expect(readCalls()).toEqual([['models']]);
            await manager.listModels('auto');
            expect(readCalls()).toHaveLength(1);
            now += 61 * 1000;
            await manager.listModels('auto');
            expect(readCalls()).toHaveLength(2);
        });

        it('gives up after the timeout and reports Gemini CLI and a missing engine', async () => {
            const manager = createManager({
                modelListTimeoutMs: 300,
                env: { PATH: fakePath(layout.bin), FAKE_HOME: layout.home, FAKE_MODELS_HANG: '1' },
            });
            expect(await manager.listModels('antigravity')).toEqual({
                models: [],
                error: 'Could not list the models of Antigravity CLI.',
            });

            installFakeCli(layout.bin, 'gemini');
            expect((await manager.listModels('gemini-cli')).error).toContain('does not list');
            fs.rmSync(path.join(layout.bin, 'agy'));
            manager.invalidateStatus();
            expect((await manager.listModels('antigravity')).models).toEqual([]);
        });
    });
});

/** The pid of the manager's running CLI (read from its private state for the test). */
function findChildPid(manager: AgentManager): number {
    const run = (manager as unknown as { activeRun: { child: { pid: number } | null } | null }).activeRun;
    const pid = run?.child?.pid;
    if (!pid) {
        throw new Error('no running child');
    }
    return pid;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
