/**
 * Unit tests for AgentIpcHandler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentIpcHandler, validateAgentSettingsUpdate } from '../../../../src/main/managers/ipc/AgentIpcHandler';
import type { IpcHandlerDependencies } from '../../../../src/main/managers/ipc/types';
import type { AgentRunEvent } from '../../../../src/shared/types/agent';
import { IPC_CHANNELS } from '../../../../src/shared/constants/ipc-channels';
import { createMockLogger, createMockStore, createMockWindowManager } from '../../../helpers/mocks';

type Listener = (...args: unknown[]) => unknown;

const { mockIpcMain, mockBrowserWindow } = vi.hoisted(() => {
    const mockIpcMain = {
        on: vi.fn((channel: string, listener: Listener) => {
            mockIpcMain._listeners.set(channel, listener);
        }),
        handle: vi.fn((channel: string, handler: Listener) => {
            mockIpcMain._handlers.set(channel, handler);
        }),
        removeHandler: vi.fn(),
        removeAllListeners: vi.fn(),
        _listeners: new Map<string, Listener>(),
        _handlers: new Map<string, Listener>(),
        _reset: () => {
            mockIpcMain._listeners.clear();
            mockIpcMain._handlers.clear();
        },
    };
    const mockWindow = { isDestroyed: vi.fn(() => false), id: 1, webContents: { send: vi.fn() } };
    const mockBrowserWindow = {
        getAllWindows: vi.fn(() => [mockWindow]),
        fromWebContents: vi.fn(() => mockWindow),
        _mockWindow: mockWindow,
    };
    return { mockIpcMain, mockBrowserWindow };
});

vi.mock('electron', () => ({
    ipcMain: mockIpcMain,
    BrowserWindow: mockBrowserWindow,
}));

const PERMISSIONS = {
    supported: true,
    settingsFile: '/home/u/.gemini/antigravity-cli/settings.json',
    readOnlyCommandsEnabled: false,
    allowedRules: ['command(df)'],
};

function createMockAgentManager() {
    return {
        getStatus: vi.fn().mockResolvedValue({ engine: 'antigravity', available: true, path: '/bin/agy' }),
        invalidateStatus: vi.fn(),
        run: vi.fn().mockResolvedValue({ runId: 'run-1' }),
        cancel: vi.fn(),
        applyPlan: vi.fn().mockResolvedValue({ applied: 1, failed: [], undoAvailable: true }),
        undoLastPlan: vi.fn().mockResolvedValue({ applied: 1, failed: [], undoAvailable: false }),
        approveBlockedCommands: vi.fn().mockResolvedValue({ runId: 'run-2' }),
        getPermissions: vi.fn().mockResolvedValue(PERMISSIONS),
        setReadOnlyCommands: vi.fn().mockResolvedValue({ ...PERMISSIONS, readOnlyCommandsEnabled: true }),
        removeAllowedRule: vi.fn().mockResolvedValue(PERMISSIONS),
        listModels: vi.fn().mockResolvedValue({ models: [{ id: 'm', name: 'M' }] }),
    };
}

describe('AgentIpcHandler', () => {
    let handler: AgentIpcHandler;
    let store: ReturnType<typeof createMockStore>;
    let windowManager: ReturnType<typeof createMockWindowManager>;
    let agentManager: ReturnType<typeof createMockAgentManager>;
    let logger: ReturnType<typeof createMockLogger>;

    const invoke = (channel: string, ...args: unknown[]) => {
        const fn = mockIpcMain._handlers.get(channel);
        if (!fn) {
            throw new Error(`no handler for ${channel}`);
        }
        return fn(...args);
    };

    const createHandler = (withManager = true) => {
        handler = new AgentIpcHandler({
            store,
            logger,
            windowManager,
            agentManager: withManager ? agentManager : null,
        } as unknown as IpcHandlerDependencies);
        handler.register();
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockIpcMain._reset();
        store = createMockStore({ quickChatRoutingMode: 'auto', agentEngine: 'auto', agentModel: '' });
        windowManager = createMockWindowManager();
        agentManager = createMockAgentManager();
        logger = createMockLogger();
        createHandler();
    });

    it('registers every agent channel and removes them on unregister', () => {
        for (const channel of [
            IPC_CHANNELS.AGENT_STATUS_GET,
            IPC_CHANNELS.AGENT_SETTINGS_GET,
            IPC_CHANNELS.AGENT_SETTINGS_SET,
            IPC_CHANNELS.AGENT_RUN,
            IPC_CHANNELS.AGENT_APPLY_PLAN,
            IPC_CHANNELS.AGENT_UNDO_LAST,
            IPC_CHANNELS.AGENT_APPROVE_COMMANDS,
            IPC_CHANNELS.AGENT_PERMISSIONS_GET,
            IPC_CHANNELS.AGENT_READ_ONLY_COMMANDS_SET,
            IPC_CHANNELS.AGENT_ALLOWED_RULE_REMOVE,
            IPC_CHANNELS.AGENT_MODELS_LIST,
        ]) {
            expect(mockIpcMain._handlers.has(channel)).toBe(true);
        }
        expect(mockIpcMain._listeners.has(IPC_CHANNELS.AGENT_CANCEL)).toBe(true);

        handler.unregister();
        expect(mockIpcMain.removeHandler).toHaveBeenCalledTimes(11);
        expect(mockIpcMain.removeAllListeners).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_CANCEL);
    });

    describe('settings', () => {
        it('returns stored settings and falls back to defaults for invalid values', async () => {
            expect(await invoke(IPC_CHANNELS.AGENT_SETTINGS_GET)).toEqual({
                quickChatRoutingMode: 'auto',
                agentEngine: 'auto',
                agentModel: '',
            });
            store._defaults = { quickChatRoutingMode: 'bogus', agentEngine: 7, agentModel: 'bad model!' };
            expect(await invoke(IPC_CHANNELS.AGENT_SETTINGS_GET)).toEqual({
                quickChatRoutingMode: 'auto',
                agentEngine: 'auto',
                agentModel: '',
            });
        });

        it('saves valid changes, trims the model, broadcasts and resets the status cache', async () => {
            const result = await invoke(
                IPC_CHANNELS.AGENT_SETTINGS_SET,
                {},
                {
                    quickChatRoutingMode: 'agent',
                    agentEngine: 'gemini-cli',
                    agentModel: '  gemini-3.0-pro:latest  ',
                    unknown: 'ignored',
                }
            );
            const expected = {
                quickChatRoutingMode: 'agent',
                agentEngine: 'gemini-cli',
                agentModel: 'gemini-3.0-pro:latest',
            };
            expect(result).toEqual(expected);
            expect(store.set).toHaveBeenCalledWith('agentModel', 'gemini-3.0-pro:latest');
            expect(store.set).not.toHaveBeenCalledWith('unknown', expect.anything());
            expect(agentManager.invalidateStatus).toHaveBeenCalled();
            expect(mockBrowserWindow._mockWindow.webContents.send).toHaveBeenCalledWith(
                IPC_CHANNELS.AGENT_SETTINGS_CHANGED,
                expected
            );
        });

        it('does not reset the status cache when the engine is unchanged', async () => {
            await invoke(IPC_CHANNELS.AGENT_SETTINGS_SET, {}, { quickChatRoutingMode: 'web' });
            expect(agentManager.invalidateStatus).not.toHaveBeenCalled();
        });

        it('rejects invalid values without saving anything', () => {
            expect(() => invoke(IPC_CHANNELS.AGENT_SETTINGS_SET, {}, { agentModel: 'a b' })).toThrow('model name');
            expect(() => invoke(IPC_CHANNELS.AGENT_SETTINGS_SET, {}, { quickChatRoutingMode: 'x' })).toThrow(
                'routing mode'
            );
            expect(store.set).not.toHaveBeenCalled();
        });
    });

    describe('validateAgentSettingsUpdate', () => {
        it('checks each field', () => {
            expect(validateAgentSettingsUpdate({})).toEqual({});
            expect(validateAgentSettingsUpdate({ agentModel: '' })).toEqual({ agentModel: '' });
            expect(() => validateAgentSettingsUpdate(null)).toThrow('Invalid agent settings');
            expect(() => validateAgentSettingsUpdate([])).toThrow('Invalid agent settings');
            expect(() => validateAgentSettingsUpdate({ agentEngine: 'claude' })).toThrow('agent engine');
            expect(() => validateAgentSettingsUpdate({ agentModel: 5 })).toThrow('agent model');
            expect(() => validateAgentSettingsUpdate({ agentModel: 'm'.repeat(101) })).toThrow('model name');
            expect(() => validateAgentSettingsUpdate({ agentModel: 'models/x' })).toThrow('model name');
        });
    });

    describe('status', () => {
        it('asks the manager with the engine preference', async () => {
            store._defaults.agentEngine = 'antigravity';
            expect(await invoke(IPC_CHANNELS.AGENT_STATUS_GET)).toMatchObject({ available: true });
            expect(agentManager.getStatus).toHaveBeenCalledWith('antigravity');
        });

        it('reports failures and a missing manager as unavailable', async () => {
            agentManager.getStatus.mockRejectedValueOnce(new Error('boom'));
            expect(await invoke(IPC_CHANNELS.AGENT_STATUS_GET)).toMatchObject({ engine: null, available: false });
            expect(logger.error).toHaveBeenCalled();

            mockIpcMain._reset();
            createHandler(false);
            expect(await invoke(IPC_CHANNELS.AGENT_STATUS_GET)).toMatchObject({ available: false });
        });
    });

    describe('runs', () => {
        const sender = { send: vi.fn(), isDestroyed: vi.fn(() => false) };

        it('starts a run with the settings and sends events to Quick Chat', async () => {
            store._defaults.agentModel = 'flash';
            const quickChat = {
                isDestroyed: () => false,
                webContents: { send: vi.fn(), isDestroyed: () => false },
            };
            windowManager.getQuickChatWindow.mockReturnValue(quickChat);

            const request = { prompt: 'hi', category: 'general' };
            expect(await invoke(IPC_CHANNELS.AGENT_RUN, { sender }, request)).toEqual({ runId: 'run-1' });
            const [passedRequest, options] = agentManager.run.mock.calls[0] as [
                unknown,
                { enginePreference: string; model: string; emit: (event: AgentRunEvent) => void },
            ];
            expect(passedRequest).toBe(request);
            expect(options.enginePreference).toBe('auto');
            expect(options.model).toBe('flash');

            const event: AgentRunEvent = { type: 'text', runId: 'run-1', delta: 'x' };
            options.emit(event);
            expect(quickChat.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_EVENT, event);
            expect(sender.send).not.toHaveBeenCalled();
        });

        it('falls back to the sender when Quick Chat is closed, and logs send errors', async () => {
            await invoke(IPC_CHANNELS.AGENT_RUN, { sender }, { prompt: 'hi', category: 'general' });
            const options = agentManager.run.mock.calls[0]?.[1] as { emit: (event: AgentRunEvent) => void };
            const event: AgentRunEvent = { type: 'done', runId: 'run-1', status: 'SUCCESS', response: '' };
            options.emit(event);
            expect(sender.send).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_EVENT, event);

            sender.send.mockImplementationOnce(() => {
                throw new Error('gone');
            });
            options.emit(event);
            expect(logger.error).toHaveBeenCalledWith(
                'Error during sending agent event:',
                expect.objectContaining({ error: 'gone' })
            );

            sender.isDestroyed.mockReturnValue(true);
            sender.send.mockClear();
            options.emit(event);
            expect(sender.send).not.toHaveBeenCalled();
        });

        it('passes on validation errors from the manager', async () => {
            agentManager.run.mockRejectedValueOnce(new Error('The prompt is empty.'));
            await expect(invoke(IPC_CHANNELS.AGENT_RUN, { sender }, { prompt: '' })).rejects.toThrow('empty');
        });

        it('cancels through the manager and logs errors', () => {
            const cancel = mockIpcMain._listeners.get(IPC_CHANNELS.AGENT_CANCEL);
            cancel?.({}, 'run-1');
            expect(agentManager.cancel).toHaveBeenCalledWith('run-1');
            agentManager.cancel.mockImplementationOnce(() => {
                throw new Error('cancel failed');
            });
            cancel?.({}, 'run-1');
            expect(logger.error).toHaveBeenCalled();
        });

        it('refuses to run without a manager', async () => {
            mockIpcMain._reset();
            createHandler(false);
            await expect(invoke(IPC_CHANNELS.AGENT_RUN, { sender }, {})).rejects.toThrow('not available');
            expect(() => mockIpcMain._listeners.get(IPC_CHANNELS.AGENT_CANCEL)?.({}, 'x')).not.toThrow();
        });
    });

    describe('file plans', () => {
        it('applies and undoes through the manager', async () => {
            expect(await invoke(IPC_CHANNELS.AGENT_APPLY_PLAN, {}, 'run-1')).toMatchObject({ applied: 1 });
            expect(agentManager.applyPlan).toHaveBeenCalledWith('run-1');
            expect(await invoke(IPC_CHANNELS.AGENT_UNDO_LAST, {})).toMatchObject({ undoAvailable: false });
            expect(agentManager.undoLastPlan).toHaveBeenCalled();
        });

        it('reports a missing manager', async () => {
            mockIpcMain._reset();
            createHandler(false);
            expect(await invoke(IPC_CHANNELS.AGENT_APPLY_PLAN, {}, 'run-1')).toMatchObject({ applied: 0 });
            expect(await invoke(IPC_CHANNELS.AGENT_UNDO_LAST, {})).toMatchObject({ applied: 0 });
        });
    });

    describe('blocked commands', () => {
        const sender = { send: vi.fn(), isDestroyed: vi.fn(() => false) };

        it('approves through the manager with the run settings and streams the resumed run', async () => {
            store._defaults.agentModel = 'flash';
            const request = { runId: 'run-1', decision: 'once' };
            expect(await invoke(IPC_CHANNELS.AGENT_APPROVE_COMMANDS, { sender }, request)).toEqual({ runId: 'run-2' });
            const [passed, options] = agentManager.approveBlockedCommands.mock.calls[0] as [
                unknown,
                { model: string; emit: (event: AgentRunEvent) => void },
            ];
            expect(passed).toBe(request);
            expect(options.model).toBe('flash');
            const event: AgentRunEvent = { type: 'text', runId: 'run-2', delta: 'x' };
            options.emit(event);
            expect(sender.send).toHaveBeenCalledWith(IPC_CHANNELS.AGENT_EVENT, event);
        });

        it('turns failures and a missing manager into errors for the card', async () => {
            agentManager.approveBlockedCommands.mockRejectedValueOnce(new Error('secret detail'));
            expect(await invoke(IPC_CHANNELS.AGENT_APPROVE_COMMANDS, { sender }, {})).toEqual({
                error: 'Could not approve the commands.',
            });
            mockIpcMain._reset();
            createHandler(false);
            expect((await invoke(IPC_CHANNELS.AGENT_APPROVE_COMMANDS, { sender }, {})).error).toContain(
                'not available'
            );
        });
    });

    describe('command rules and models', () => {
        it('reads and changes the command rules with the engine preference', async () => {
            store._defaults.agentEngine = 'antigravity';
            expect(await invoke(IPC_CHANNELS.AGENT_PERMISSIONS_GET, {})).toEqual(PERMISSIONS);
            expect(agentManager.getPermissions).toHaveBeenCalledWith('antigravity');

            expect(await invoke(IPC_CHANNELS.AGENT_READ_ONLY_COMMANDS_SET, {}, true)).toMatchObject({
                readOnlyCommandsEnabled: true,
            });
            expect(agentManager.setReadOnlyCommands).toHaveBeenCalledWith(true, 'antigravity');
            await expect(invoke(IPC_CHANNELS.AGENT_READ_ONLY_COMMANDS_SET, {}, 'yes')).rejects.toThrow('Invalid');

            await invoke(IPC_CHANNELS.AGENT_ALLOWED_RULE_REMOVE, {}, 'command(df)');
            expect(agentManager.removeAllowedRule).toHaveBeenCalledWith('command(df)', 'antigravity');
        });

        it('reports read failures without throwing', async () => {
            agentManager.getPermissions.mockRejectedValueOnce(new Error('boom'));
            expect(await invoke(IPC_CHANNELS.AGENT_PERMISSIONS_GET, {})).toMatchObject({
                supported: false,
                error: 'Could not read the command rules.',
            });
        });

        it('lists models, passing refresh only when it is true', async () => {
            expect(await invoke(IPC_CHANNELS.AGENT_MODELS_LIST, {}, true)).toEqual({
                models: [{ id: 'm', name: 'M' }],
            });
            expect(agentManager.listModels).toHaveBeenLastCalledWith('auto', true);
            await invoke(IPC_CHANNELS.AGENT_MODELS_LIST, {}, 'yes');
            expect(agentManager.listModels).toHaveBeenLastCalledWith('auto', false);
            agentManager.listModels.mockRejectedValueOnce(new Error('boom'));
            expect(await invoke(IPC_CHANNELS.AGENT_MODELS_LIST, {})).toEqual({
                models: [],
                error: 'Could not list the models.',
            });
        });

        it('answers without a manager', async () => {
            mockIpcMain._reset();
            createHandler(false);
            expect(await invoke(IPC_CHANNELS.AGENT_PERMISSIONS_GET, {})).toMatchObject({ supported: false });
            expect(await invoke(IPC_CHANNELS.AGENT_READ_ONLY_COMMANDS_SET, {}, true)).toMatchObject({
                supported: false,
            });
            expect(await invoke(IPC_CHANNELS.AGENT_ALLOWED_RULE_REMOVE, {}, 'command(df)')).toMatchObject({
                supported: false,
            });
            expect((await invoke(IPC_CHANNELS.AGENT_MODELS_LIST, {})).error).toContain('not available');
        });
    });
});
