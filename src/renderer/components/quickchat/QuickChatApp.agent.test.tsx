/**
 * Unit tests for the hybrid Quick Chat (H4): the route chip, routing keys,
 * agent runs streaming into the panel, file plans, Stop, Escape and follow-ups.
 *
 * @module QuickChatApp.agent.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import QuickChatApp, { QUICK_CHAT_COMPACT_HEIGHT, STOP_TIMEOUT_MS } from './QuickChatApp';
import { buildContinueInGeminiPrompt } from './agentRunState';
import { createMockElectronAPI } from '../../../../tests/helpers/mocks/renderer/electronAPI';
import type { AgentEngineStatus, AgentRunEvent, AgentSettings } from '../../../shared/types/agent';
import type { ElectronAPI } from '../../../shared/types/ipc';

const AVAILABLE: AgentEngineStatus = {
    engine: 'antigravity',
    available: true,
    path: '/usr/bin/agy',
    version: '1.0.0',
};

const UNAVAILABLE: AgentEngineStatus = { engine: null, available: false, error: 'No agent CLI found' };

describe('QuickChatApp hybrid routing and agent panel', () => {
    let api: ElectronAPI;
    let emit: (event: AgentRunEvent) => void;
    let emitSettings: (settings: AgentSettings) => void;

    const setup = (overrides: Partial<ElectronAPI> = {}) => {
        api = createMockElectronAPI({
            getAgentStatus: vi.fn().mockResolvedValue(AVAILABLE),
            onAgentEvent: vi.fn((callback: (event: AgentRunEvent) => void) => {
                emit = callback;
                return () => {};
            }),
            onAgentSettingsChanged: vi.fn((callback: (settings: AgentSettings) => void) => {
                emitSettings = callback;
                return () => {};
            }),
            ...overrides,
        });
        window.electronAPI = api;
    };

    const renderApp = async () => {
        render(<QuickChatApp />);
        await waitFor(() => expect(api.getAgentStatus).toHaveBeenCalled());
        await act(async () => {
            await Promise.resolve();
        });
    };

    const type = async (value: string) => {
        await act(async () => {
            fireEvent.change(screen.getByTestId('quick-chat-input'), { target: { value } });
        });
    };

    const press = async (key: string, init: Partial<KeyboardEventInit> = {}) => {
        await act(async () => {
            fireEvent.keyDown(screen.getByTestId('quick-chat-input'), { key, ...init });
        });
    };

    const chip = () => screen.getByTestId('quick-chat-route-chip');

    /** Send an agent prompt and wait until runAgent resolved its runId. */
    const startAgentRun = async (prompt = 'organise my Downloads folder') => {
        await type(prompt);
        await press('Enter');
        await waitFor(() => expect(api.runAgent).toHaveBeenCalled());
        await act(async () => {
            await Promise.resolve();
        });
    };

    const send = async (event: AgentRunEvent) => {
        await act(async () => {
            emit(event);
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
        setup();
    });

    afterEach(() => {
        window.electronAPI = undefined;
    });

    describe('route chip', () => {
        it('is hidden while the input is empty', async () => {
            await renderApp();
            expect(screen.queryByTestId('quick-chat-route-chip')).not.toBeInTheDocument();
        });

        it('shows Gemini for a general question', async () => {
            await renderApp();
            await type('write a haiku about autumn');
            expect(chip()).toHaveTextContent('Gemini');
            expect(chip()).toHaveAttribute('title', expect.stringContaining('general question'));
        });

        it('shows the agent category and reason for a file task', async () => {
            await renderApp();
            await type('organise my Downloads folder');
            expect(chip()).toHaveTextContent('Agent · Files');
            expect(chip()).toHaveAttribute('aria-label', expect.stringContaining('asks to change files'));
        });

        it('toggles the route for this prompt when clicked', async () => {
            await renderApp();
            await type('organise my Downloads folder');
            await act(async () => {
                fireEvent.click(chip());
            });
            expect(chip()).toHaveTextContent('Gemini');
            expect(chip()).toHaveAttribute('title', expect.stringContaining('you picked Gemini'));

            await press('Enter');
            expect(api.submitQuickChat).toHaveBeenCalledWith('organise my Downloads folder');
            expect(api.runAgent).not.toHaveBeenCalled();
        });

        it('toggles a web prompt to the agent', async () => {
            await renderApp();
            await type('tell me a joke');
            await act(async () => {
                fireEvent.click(chip());
            });
            expect(chip()).toHaveTextContent('Agent');
            await press('Enter');
            await waitFor(() =>
                expect(api.runAgent).toHaveBeenCalledWith({
                    prompt: 'tell me a joke',
                    category: 'general',
                    conversationId: undefined,
                })
            );
        });

        it('follows the routing mode from settings changes', async () => {
            await renderApp();
            await type('organise my Downloads folder');
            expect(chip()).toHaveTextContent('Agent · Files');
            await act(async () => {
                emitSettings({ quickChatRoutingMode: 'web', agentEngine: 'auto', agentModel: '' });
            });
            expect(chip()).toHaveTextContent('Gemini');
        });

        it('uses the routing mode from getAgentSettings', async () => {
            setup({
                getAgentSettings: vi
                    .fn()
                    .mockResolvedValue({ quickChatRoutingMode: 'agent', agentEngine: 'auto', agentModel: '' }),
            });
            await renderApp();
            await type('write a haiku');
            expect(chip()).toHaveTextContent('Agent');
        });
    });

    describe('Enter and Ctrl+Enter', () => {
        it('Enter sends a web prompt to Gemini unchanged and keeps the window compact', async () => {
            await renderApp();
            await type('  what is the capital of France  ');
            await press('Enter');
            expect(api.submitQuickChat).toHaveBeenCalledWith('what is the capital of France');
            expect(api.runAgent).not.toHaveBeenCalled();
            expect(screen.queryByTestId('quick-chat-agent-panel')).not.toBeInTheDocument();
        });

        it('Enter strips a routing prefix before sending to Gemini', async () => {
            await renderApp();
            await type('@web organise my Downloads folder');
            await press('Enter');
            expect(api.submitQuickChat).toHaveBeenCalledWith('organise my Downloads folder');
        });

        it('Enter sends an agent prompt to the agent', async () => {
            await renderApp();
            await startAgentRun('how much disk space is left');
            expect(api.runAgent).toHaveBeenCalledWith({
                prompt: 'how much disk space is left',
                category: 'system',
                conversationId: undefined,
            });
            expect(api.submitQuickChat).not.toHaveBeenCalled();
            expect(screen.getByTestId('quick-chat-agent-panel')).toBeInTheDocument();
            expect(screen.getByTestId('quick-chat-input')).toHaveValue('');
        });

        it('Ctrl+Enter sends a web prompt to the agent', async () => {
            await renderApp();
            await type('tell me a joke');
            await press('Enter', { ctrlKey: true });
            await waitFor(() => expect(api.runAgent).toHaveBeenCalled());
            expect(api.submitQuickChat).not.toHaveBeenCalled();
        });

        it('Ctrl+Enter sends an agent prompt to Gemini', async () => {
            await renderApp();
            await type('organise my Downloads folder');
            await press('Enter', { ctrlKey: true });
            expect(api.submitQuickChat).toHaveBeenCalledWith('organise my Downloads folder');
            expect(api.runAgent).not.toHaveBeenCalled();
        });

        it('uses Cmd+Enter on macOS', async () => {
            setup({ platform: 'darwin' });
            await renderApp();
            await type('organise my Downloads folder');
            await press('Enter', { ctrlKey: true });
            // Ctrl+Enter is not the swap key on macOS, so the shown route (agent) is used
            await waitFor(() => expect(api.runAgent).toHaveBeenCalled());
            expect(api.submitQuickChat).not.toHaveBeenCalled();
        });

        it('Cmd+Enter swaps the route on macOS', async () => {
            setup({ platform: 'darwin' });
            await renderApp();
            await type('organise my Downloads folder');
            await press('Enter', { metaKey: true });
            expect(api.submitQuickChat).toHaveBeenCalledWith('organise my Downloads folder');
        });
    });

    describe('no agent installed', () => {
        it('falls back to Gemini in auto mode', async () => {
            setup({ getAgentStatus: vi.fn().mockResolvedValue(UNAVAILABLE) });
            await renderApp();
            await type('organise my Downloads folder');
            expect(chip()).toHaveTextContent('Gemini');
            expect(chip()).toHaveAttribute('title', expect.stringContaining('no agent CLI installed'));
            await press('Enter');
            expect(api.submitQuickChat).toHaveBeenCalledWith('organise my Downloads folder');
            expect(api.runAgent).not.toHaveBeenCalled();
        });

        it('shows the setup hint for a prompt forced to the agent', async () => {
            setup({ getAgentStatus: vi.fn().mockResolvedValue(UNAVAILABLE) });
            await renderApp();
            await type('@agent organise my Downloads folder');
            expect(chip()).toHaveTextContent('Agent · Files');
            await press('Enter');
            expect(api.runAgent).not.toHaveBeenCalled();
            expect(screen.getByTestId('quick-chat-agent-error')).toHaveTextContent('No agent CLI found');
            expect(screen.getByTestId('quick-chat-agent-setup-hint')).toHaveTextContent(/run agy once/);
        });

        it('refreshes the agent status when the window gains focus', async () => {
            const getAgentStatus = vi.fn().mockResolvedValueOnce(UNAVAILABLE).mockResolvedValue(AVAILABLE);
            setup({ getAgentStatus });
            await renderApp();
            await type('organise my Downloads folder');
            expect(chip()).toHaveTextContent('Gemini');

            await act(async () => {
                window.dispatchEvent(new Event('focus'));
            });
            await waitFor(() => expect(chip()).toHaveTextContent('Agent · Files'));
            expect(getAgentStatus).toHaveBeenCalledTimes(2);
        });
    });

    describe('agent run', () => {
        it('streams text deltas into the panel as Markdown', async () => {
            await renderApp();
            await startAgentRun();
            expect(screen.getByTestId('quick-chat-agent-progress')).toBeInTheDocument();

            await send({ type: 'started', runId: 'run-1', engine: 'antigravity' });
            expect(screen.getByTestId('quick-chat-agent-progress')).toHaveTextContent('Antigravity CLI');

            await send({ type: 'text', runId: 'run-1', delta: 'You have **3** ' });
            await send({ type: 'text', runId: 'run-1', delta: 'PDFs.' });
            const output = screen.getByTestId('quick-chat-agent-output');
            expect(output).toHaveTextContent('You have 3 PDFs.');
            expect(output.querySelector('strong')).toHaveTextContent('3');
        });

        it('buffers events that arrive before runAgent resolves', async () => {
            let resolveRun: (value: { runId: string }) => void = () => {};
            setup({
                runAgent: vi.fn(
                    () =>
                        new Promise<{ runId: string }>((resolve) => {
                            resolveRun = resolve;
                        })
                ),
            });
            await renderApp();
            await type('organise my Downloads folder');
            await press('Enter');
            await send({ type: 'text', runId: 'run-9', delta: 'early ' });
            await send({ type: 'text', runId: 'other', delta: 'ignored' });
            await act(async () => {
                resolveRun({ runId: 'run-9' });
            });
            await send({ type: 'text', runId: 'run-9', delta: 'late' });
            expect(screen.getByTestId('quick-chat-agent-output')).toHaveTextContent('early late');
            expect(screen.getByTestId('quick-chat-agent-output')).not.toHaveTextContent('ignored');
        });

        it('ignores events from other runs', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'text', runId: 'run-old', delta: 'stale' });
            expect(screen.queryByTestId('quick-chat-agent-output')).not.toBeInTheDocument();
        });

        it('escapes raw HTML in the output', async () => {
            await renderApp();
            await startAgentRun();
            await send({
                type: 'text',
                runId: 'run-1',
                delta: 'Hi <img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n<div onclick="x">block</div>\n\n[link](javascript:alert(3))',
            });
            const output = screen.getByTestId('quick-chat-agent-output');
            expect(output.querySelector('img')).toBeNull();
            expect(output.querySelector('script')).toBeNull();
            expect(output.querySelector('div[onclick]')).toBeNull();
            expect(output.querySelector('a')).toBeNull();
            expect(output).toHaveTextContent('<img src=x onerror="alert(1)">');
            expect(output).toHaveTextContent('<script>alert(2)</script>');
            expect(output).toHaveTextContent('link (javascript:alert(3))');
        });

        it('shows tool steps with their state', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'tool', runId: 'run-1', name: 'list_dir', summary: '~/Downloads', state: 'ACTIVE' });
            let steps = screen.getAllByTestId('quick-chat-agent-tool-step');
            expect(steps).toHaveLength(1);
            expect(steps[0]).toHaveAttribute('data-state', 'running');
            expect(steps[0]).toHaveTextContent('list_dir');
            expect(steps[0]).toHaveTextContent('~/Downloads');

            await send({ type: 'tool', runId: 'run-1', name: 'list_dir', summary: '~/Downloads', state: 'DONE' });
            await send({
                type: 'tool',
                runId: 'run-1',
                name: 'read_file',
                summary: '~/Downloads/a.pdf',
                state: 'DONE',
                error: 'Permission denied',
            });
            steps = screen.getAllByTestId('quick-chat-agent-tool-step');
            expect(steps).toHaveLength(2);
            expect(steps[0]).toHaveAttribute('data-state', 'done');
            expect(steps[1]).toHaveAttribute('data-state', 'failed');
            expect(steps[1]).toHaveTextContent('Permission denied');
        });

        it('grows the window while the panel shows and shrinks it on Escape', async () => {
            await renderApp();
            await startAgentRun();
            expect(api.resizeQuickChat).toHaveBeenCalled();

            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: 'ok' });
            vi.mocked(api.resizeQuickChat).mockClear();
            await press('Escape');
            expect(api.cancelQuickChat).toHaveBeenCalled();
            expect(api.resizeQuickChat).toHaveBeenCalledWith(QUICK_CHAT_COMPACT_HEIGHT);
            expect(screen.queryByTestId('quick-chat-agent-panel')).not.toBeInTheDocument();
        });

        it('uses a ResizeObserver to follow the panel height', async () => {
            const observe = vi.fn();
            const disconnect = vi.fn();
            const original = globalThis.ResizeObserver;
            globalThis.ResizeObserver = vi.fn(function (this: ResizeObserver) {
                return { observe, disconnect, unobserve: vi.fn() };
            }) as unknown as typeof ResizeObserver;
            try {
                await renderApp();
                await startAgentRun();
                expect(observe).toHaveBeenCalledWith(screen.getByTestId('quick-chat-container'));
                await act(async () => {
                    fireEvent.click(screen.getByTestId('quick-chat-agent-stop'));
                });
                await send({ type: 'done', runId: 'run-1', status: 'CANCELED', response: '' });
                await act(async () => {
                    fireEvent.click(screen.getByTestId('quick-chat-agent-new'));
                });
                expect(disconnect).toHaveBeenCalled();
            } finally {
                globalThis.ResizeObserver = original;
            }
        });

        it('uses the final response when no text was streamed', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: 'All done.' });
            expect(screen.getByTestId('quick-chat-agent-output')).toHaveTextContent('All done.');
            expect(screen.queryByTestId('quick-chat-agent-progress')).not.toBeInTheDocument();
        });
    });

    describe('Stop and Escape', () => {
        it('Stop cancels the run', async () => {
            await renderApp();
            await startAgentRun();
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-stop'));
            });
            expect(api.cancelAgent).toHaveBeenCalledWith('run-1');
            expect(screen.getByTestId('quick-chat-agent-progress')).toHaveTextContent('Stopping');

            await send({ type: 'done', runId: 'run-1', status: 'CANCELED', response: '' });
            expect(screen.getByTestId('quick-chat-agent-error')).toHaveTextContent('Stopped.');
        });

        it('Escape stops a running agent instead of hiding Quick Chat', async () => {
            await renderApp();
            await startAgentRun();
            await press('Escape');
            expect(api.cancelAgent).toHaveBeenCalledWith('run-1');
            expect(api.cancelQuickChat).not.toHaveBeenCalled();
        });

        it('Escape after the run hides Quick Chat and resets the panel', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: 'x', conversationId: 'c1' });
            await press('Escape');
            expect(api.cancelQuickChat).toHaveBeenCalledTimes(1);
            expect(screen.queryByTestId('quick-chat-agent-panel')).not.toBeInTheDocument();
            expect(screen.getByTestId('quick-chat-input')).toHaveAttribute('placeholder', 'Ask Gemini...');
        });

        it('Escape from a panel button works too', async () => {
            await renderApp();
            await startAgentRun();
            await act(async () => {
                fireEvent.keyDown(screen.getByTestId('quick-chat-agent-stop'), { key: 'Escape' });
            });
            expect(api.cancelAgent).toHaveBeenCalledWith('run-1');
        });

        it('stops a run that is still starting once its runId arrives', async () => {
            let resolveRun: (value: { runId: string }) => void = () => {};
            setup({
                runAgent: vi.fn(
                    () =>
                        new Promise<{ runId: string }>((resolve) => {
                            resolveRun = resolve;
                        })
                ),
            });
            await renderApp();
            await type('organise my Downloads folder');
            await press('Enter');
            await press('Escape');
            expect(api.cancelAgent).not.toHaveBeenCalled();
            await act(async () => {
                resolveRun({ runId: 'run-5' });
            });
            expect(api.cancelAgent).toHaveBeenCalledWith('run-5');
        });
    });

    describe('file plans', () => {
        const plan = {
            summary: 'Move 2 PDFs into Documents/PDFs.',
            actions: [
                { id: 'a1', op: 'mkdir' as const, to: '/home/jared/Documents/PDFs' },
                {
                    id: 'a2',
                    op: 'move' as const,
                    from: '/home/jared/Downloads/a.pdf',
                    to: '/home/jared/Documents/PDFs/a.pdf',
                },
                { id: 'a3', op: 'trash' as const, from: '/home/jared/Downloads/old.zip' },
            ],
        };

        it('shows the plan and applies it after the run is done', async () => {
            vi.mocked(api.applyFilePlan).mockResolvedValue({ applied: 3, failed: [], undoAvailable: true });
            await renderApp();
            await startAgentRun();
            await send({ type: 'plan', runId: 'run-1', plan });

            expect(screen.getByTestId('quick-chat-agent-plan')).toHaveTextContent(plan.summary);
            const rows = screen.getAllByTestId('quick-chat-agent-plan-action');
            expect(rows).toHaveLength(3);
            expect(rows[1]).toHaveTextContent('~/Downloads/a.pdf');
            expect(rows[1]).toHaveTextContent('~/Documents/PDFs/a.pdf');
            expect(rows[1]).not.toHaveTextContent('/home/jared');
            expect(screen.getByTestId('quick-chat-agent-plan-apply')).toBeDisabled();

            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: '' });
            const apply = screen.getByTestId('quick-chat-agent-plan-apply');
            expect(apply).not.toBeDisabled();
            await act(async () => {
                fireEvent.click(apply);
            });
            expect(api.applyFilePlan).toHaveBeenCalledWith('run-1');
            await waitFor(() =>
                expect(screen.getByTestId('quick-chat-agent-plan-result')).toHaveTextContent('Applied 3 changes.')
            );
        });

        it('shows failures and undoes the plan', async () => {
            vi.mocked(api.applyFilePlan).mockResolvedValue({
                applied: 2,
                failed: [{ id: 'a3', error: 'old.zip is missing' }],
                undoAvailable: true,
            });
            vi.mocked(api.undoLastFilePlan).mockResolvedValue({ applied: 2, failed: [], undoAvailable: false });
            await renderApp();
            await startAgentRun();
            await send({ type: 'plan', runId: 'run-1', plan });
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: '' });
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-plan-apply'));
            });
            const result = await screen.findByTestId('quick-chat-agent-plan-result');
            expect(result).toHaveTextContent('Applied 2 changes, 1 failed.');
            expect(result).toHaveTextContent('old.zip is missing');

            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-plan-undo'));
            });
            expect(api.undoLastFilePlan).toHaveBeenCalled();
            await waitFor(() =>
                expect(screen.getByTestId('quick-chat-agent-plan-result')).toHaveTextContent('Undid 2 changes.')
            );
        });

        it('cancels a plan without calling the main process', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'plan', runId: 'run-1', plan });
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: '' });
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-plan-cancel'));
            });
            expect(api.applyFilePlan).not.toHaveBeenCalled();
            expect(screen.getByTestId('quick-chat-agent-plan-result')).toHaveTextContent('Nothing changed');
        });

        it('shows an error when applying fails', async () => {
            vi.mocked(api.applyFilePlan).mockRejectedValue(new Error('plan expired'));
            await renderApp();
            await startAgentRun();
            await send({ type: 'plan', runId: 'run-1', plan });
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: '' });
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-plan-apply'));
            });
            expect(await screen.findByRole('alert')).toHaveTextContent('plan expired');
            expect(screen.getByTestId('quick-chat-agent-plan-apply')).not.toBeDisabled();
        });
    });

    describe('after the run', () => {
        it('shows errors with the sign-in hint', async () => {
            await renderApp();
            await startAgentRun();
            await send({
                type: 'done',
                runId: 'run-1',
                status: 'ERROR',
                response: '',
                error: 'Not signed in. Run agy to sign in.',
            });
            expect(screen.getByTestId('quick-chat-agent-error')).toHaveTextContent('Not signed in');
            expect(screen.getByTestId('quick-chat-agent-setup-hint')).toBeInTheDocument();
        });

        it('shows other errors without the hint', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'done', runId: 'run-1', status: 'TIMEOUT', response: '' });
            expect(screen.getByTestId('quick-chat-agent-error')).toHaveTextContent('took too long');
            expect(screen.queryByTestId('quick-chat-agent-setup-hint')).not.toBeInTheDocument();
        });

        it('shows an error when runAgent rejects', async () => {
            setup({ runAgent: vi.fn().mockRejectedValue(new Error('IPC failed')) });
            await renderApp();
            await type('organise my Downloads folder');
            await press('Enter');
            expect(await screen.findByTestId('quick-chat-agent-error')).toHaveTextContent('IPC failed');
        });

        it('passes the conversationId with a follow-up question', async () => {
            vi.mocked(api.runAgent).mockResolvedValueOnce({ runId: 'run-1' }).mockResolvedValueOnce({ runId: 'run-2' });
            await renderApp();
            await startAgentRun();
            await send({ type: 'text', runId: 'run-1', delta: 'Done.' });
            await send({
                type: 'done',
                runId: 'run-1',
                status: 'SUCCESS',
                response: 'Done.',
                conversationId: 'conv-1',
            });
            expect(screen.getByTestId('quick-chat-input')).toHaveAttribute('placeholder', 'Ask a follow-up…');

            await type('@agent and the Documents folder?');
            await press('Enter');
            await waitFor(() => expect(api.runAgent).toHaveBeenCalledTimes(2));
            expect(api.runAgent).toHaveBeenLastCalledWith({
                prompt: 'and the Documents folder?',
                category: 'files',
                conversationId: 'conv-1',
            });
        });

        it('New starts a fresh conversation', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: 'x', conversationId: 'conv-1' });
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-new'));
            });
            expect(screen.queryByTestId('quick-chat-agent-panel')).not.toBeInTheDocument();
            expect(api.resizeQuickChat).toHaveBeenLastCalledWith(QUICK_CHAT_COMPACT_HEIGHT);

            await startAgentRun('@agent hello');
            expect(api.runAgent).toHaveBeenLastCalledWith({
                prompt: 'hello',
                category: 'general',
                conversationId: undefined,
            });
        });

        it('Continue in Gemini sends the prompt and the answer to the web tab', async () => {
            await renderApp();
            await startAgentRun('how much disk space is left');
            await send({ type: 'text', runId: 'run-1', delta: '42 GB free.' });
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: '42 GB free.' });
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-continue-web'));
            });
            expect(api.submitQuickChat).toHaveBeenCalledWith(
                buildContinueInGeminiPrompt('how much disk space is left', '42 GB free.')
            );
            expect(vi.mocked(api.submitQuickChat).mock.calls[0]?.[0]).toContain('42 GB free.');
            expect(screen.queryByTestId('quick-chat-agent-panel')).not.toBeInTheDocument();
        });

        it('a web prompt while the panel shows closes the panel', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: 'x' });
            await type('@web tell me a joke');
            await press('Enter');
            expect(api.submitQuickChat).toHaveBeenCalledWith('tell me a joke');
            expect(screen.queryByTestId('quick-chat-agent-panel')).not.toBeInTheDocument();
        });

        it('does not start a second agent run while one is active', async () => {
            await renderApp();
            await startAgentRun();
            await type('@agent another');
            expect(screen.getByTestId('quick-chat-submit')).toBeDisabled();
            await press('Enter');
            expect(api.runAgent).toHaveBeenCalledTimes(1);
        });
    });

    describe('prediction still works', () => {
        it('Tab accepts a prediction and Escape dismisses it before stopping a run', async () => {
            setup({
                getTextPredictionStatus: vi
                    .fn()
                    .mockResolvedValue({ enabled: true, gpuEnabled: false, status: 'ready' }),
                predictText: vi.fn().mockResolvedValue(' folder'),
            });
            vi.useFakeTimers({ shouldAdvanceTime: true });
            try {
                await renderApp();
                await type('organise my Downloads');
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(350);
                });
                expect(await screen.findByTestId('quick-chat-ghost-text')).toHaveTextContent('folder');
                await press('Tab');
                expect(screen.getByTestId('quick-chat-input')).toHaveValue('organise my Downloads folder');
            } finally {
                vi.useRealTimers();
            }
        });
    });
    describe('review fixes', () => {
        const smallPlan = {
            summary: 'Move a.pdf into Documents.',
            actions: [
                { id: 'a1', op: 'move' as const, from: '/home/me/Downloads/a.pdf', to: '/home/me/Documents/a.pdf' },
            ],
        };

        it('routes an unprefixed follow-up to the agent with the conversation id', async () => {
            vi.mocked(api.runAgent).mockResolvedValueOnce({ runId: 'run-1' }).mockResolvedValueOnce({ runId: 'run-2' });
            await renderApp();
            await startAgentRun('how much disk space do I have left');
            await send({
                type: 'done',
                runId: 'run-1',
                status: 'SUCCESS',
                response: '42 GB',
                conversationId: 'conv-1',
            });

            await type('and how much is used by videos?');
            expect(chip()).toHaveTextContent('Agent');
            expect(chip()).toHaveAttribute('title', expect.stringContaining('follow-up to the agent'));
            await press('Enter');
            await waitFor(() => expect(api.runAgent).toHaveBeenCalledTimes(2));
            expect(api.runAgent).toHaveBeenLastCalledWith({
                prompt: 'and how much is used by videos?',
                category: 'general',
                conversationId: 'conv-1',
            });
            expect(api.submitQuickChat).not.toHaveBeenCalled();
        });

        it('a follow-up with a web cue still goes to Gemini', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: 'x', conversationId: 'conv-1' });
            await type('draw that as a diagram');
            expect(chip()).toHaveTextContent('Gemini');
        });

        it('a second Escape while stopping hides Quick Chat and resets the panel', async () => {
            await renderApp();
            await startAgentRun();
            await press('Escape');
            expect(api.cancelAgent).toHaveBeenCalledWith('run-1');
            expect(api.cancelQuickChat).not.toHaveBeenCalled();
            await press('Escape');
            expect(api.cancelQuickChat).toHaveBeenCalledTimes(1);
            expect(screen.queryByTestId('quick-chat-agent-panel')).not.toBeInTheDocument();
            expect(api.resizeQuickChat).toHaveBeenLastCalledWith(QUICK_CHAT_COMPACT_HEIGHT);
        });

        it('treats the run as stopped when the CLI never confirms', async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            try {
                await renderApp();
                await startAgentRun();
                await act(async () => {
                    fireEvent.click(screen.getByTestId('quick-chat-agent-stop'));
                });
                expect(screen.getByTestId('quick-chat-agent-progress')).toHaveTextContent('Stopping');
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS + 10);
                });
                expect(screen.queryByTestId('quick-chat-agent-progress')).not.toBeInTheDocument();
                expect(screen.getByTestId('quick-chat-agent-error')).toHaveTextContent('Stopped.');
            } finally {
                vi.useRealTimers();
            }
        });

        it('ignores text that arrives after done', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'text', runId: 'run-1', delta: 'Answer.' });
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: 'Answer.' });
            await send({ type: 'text', runId: 'run-1', delta: ' late' });
            expect(screen.getByTestId('quick-chat-agent-output')).toHaveTextContent(/^Answer\.$/);
        });

        it('clears the chip choice when a routing prefix is typed', async () => {
            await renderApp();
            await type('organise my Downloads folder');
            await act(async () => {
                fireEvent.click(chip());
            });
            expect(chip()).toHaveTextContent('Gemini');
            await type('@agent organise my Downloads folder');
            expect(chip()).toHaveTextContent('Agent · Files');
            expect(chip()).toHaveAttribute('title', expect.stringContaining('you typed @agent'));
        });

        it('announces once in a status line instead of a live streaming region', async () => {
            await renderApp();
            await startAgentRun();
            const announcer = screen.getByTestId('quick-chat-agent-announcer');
            expect(announcer).toHaveAttribute('role', 'status');
            expect(announcer).toHaveTextContent('The agent is working');
            await send({ type: 'text', runId: 'run-1', delta: 'Streaming text' });
            expect(announcer).not.toHaveTextContent('Streaming');
            expect(screen.getByTestId('quick-chat-agent-panel').querySelector('[aria-live]')).toBeNull();
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: 'Streaming text' });
            expect(announcer).toHaveTextContent('Answer ready');
        });

        it('shows a refusal from applyFilePlan', async () => {
            vi.mocked(api.applyFilePlan).mockResolvedValue({
                applied: 0,
                failed: [{ id: '', error: 'Refused: /etc/passwd is outside your home folder' }],
                undoAvailable: false,
            });
            await renderApp();
            await startAgentRun();
            await send({ type: 'plan', runId: 'run-1', plan: smallPlan });
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: smallPlan.summary });
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-plan-apply'));
            });
            const result = await screen.findByTestId('quick-chat-agent-plan-result');
            expect(result).toHaveTextContent('Nothing changed.');
            expect(result).toHaveTextContent('outside your home folder');
            expect(screen.queryByTestId('quick-chat-agent-plan-undo')).not.toBeInTheDocument();
        });

        it('does not repeat the plan summary as the answer text', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'plan', runId: 'run-1', plan: smallPlan });
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: smallPlan.summary });
            expect(screen.queryByTestId('quick-chat-agent-output')).not.toBeInTheDocument();
            expect(screen.getByTestId('quick-chat-agent-announcer')).toHaveTextContent('File plan ready');
        });

        it('starts compact when shown again after a finished run', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: 'x' });
            await act(async () => {
                window.dispatchEvent(new Event('blur'));
            });
            vi.mocked(api.resizeQuickChat).mockClear();
            await act(async () => {
                window.dispatchEvent(new Event('focus'));
            });
            expect(screen.queryByTestId('quick-chat-agent-panel')).not.toBeInTheDocument();
            expect(api.resizeQuickChat).toHaveBeenCalledWith(QUICK_CHAT_COMPACT_HEIGHT);
        });

        it('keeps a plan that waits for Apply when shown again', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'plan', runId: 'run-1', plan: smallPlan });
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: smallPlan.summary });
            await act(async () => {
                window.dispatchEvent(new Event('blur'));
            });
            await act(async () => {
                window.dispatchEvent(new Event('focus'));
            });
            expect(screen.getByTestId('quick-chat-agent-plan')).toBeInTheDocument();
        });

        it('keeps a running answer when shown again', async () => {
            await renderApp();
            await startAgentRun();
            await act(async () => {
                window.dispatchEvent(new Event('blur'));
            });
            await act(async () => {
                window.dispatchEvent(new Event('focus'));
            });
            expect(screen.getByTestId('quick-chat-agent-progress')).toBeInTheDocument();
        });
    });

    describe('blocked commands', () => {
        const DISK_PROMPT = 'how much disk space is left on my laptop';

        /** A run whose `df -h` headless mode refused, as Antigravity CLI reports it. */
        const blockedRun = async (overrides: Partial<Extract<AgentRunEvent, { type: 'done' }>> = {}) => {
            await renderApp();
            await startAgentRun(`@agent ${DISK_PROMPT}`);
            await send({ type: 'started', runId: 'run-1', engine: 'antigravity' });
            await send({ type: 'tool', runId: 'run-1', name: 'run_command', summary: 'df -h', state: 'ACTIVE' });
            await send({ type: 'tool', runId: 'run-1', name: 'run_command', summary: 'df -h', state: 'DONE' });
            await send({
                type: 'done',
                runId: 'run-1',
                status: 'SUCCESS',
                response: '',
                conversationId: 'c1',
                blocked: [{ tool: 'run_command', command: 'df -h', summary: 'df -h', lastingRule: 'command(df)' }],
                deniedActions: ['command'],
                canApprove: true,
                ...overrides,
            });
        };

        it('marks the step as blocked and asks for approval instead of saying "Answer ready"', async () => {
            await blockedRun();
            const [step] = screen.getAllByTestId('quick-chat-agent-tool-step');
            expect(step).toHaveAttribute('data-state', 'blocked');
            expect(step).toHaveTextContent('Blocked');
            expect(step?.querySelector('.qc-tools__step--blocked, .qc-tools__icon')).not.toBeNull();
            expect(step).toHaveClass('qc-tools__step--blocked');

            const card = screen.getByTestId('quick-chat-agent-approval');
            expect(card).toHaveTextContent('The agent needs to run:');
            expect(card.querySelector('code')).toHaveTextContent('df -h');
            expect(screen.getByTestId('quick-chat-agent-announcer')).toHaveTextContent(
                'The agent needs your approval to run a command'
            );
            expect(screen.getByTestId('quick-chat-agent-announcer')).not.toHaveTextContent('Answer ready');
            expect(screen.queryByTestId('quick-chat-agent-output')).not.toBeInTheDocument();

            const always = screen.getByTestId('quick-chat-agent-approve-always');
            expect(always).toHaveTextContent('Always allow');
            expect(always).toHaveTextContent('df');
            expect(always).toHaveAttribute('title', expect.stringContaining('command(df)'));
            // Buttons are plain, focusable buttons; nothing is focused for the user.
            expect(screen.getByTestId('quick-chat-agent-approve-once').tagName).toBe('BUTTON');
            expect(document.activeElement).toBe(screen.getByTestId('quick-chat-input'));
        });

        it('Allow once resumes the conversation and streams the answer into the same panel', async () => {
            await blockedRun();
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-approve-once'));
            });
            expect(api.approveAgentCommands).toHaveBeenCalledWith({ runId: 'run-1', decision: 'once' });
            expect(screen.queryByTestId('quick-chat-agent-approval')).not.toBeInTheDocument();
            expect(screen.getByTestId('quick-chat-agent-progress')).toBeInTheDocument();

            await send({ type: 'text', runId: 'run-1', delta: 'ignored, the old run' });
            await send({ type: 'tool', runId: 'run-2', name: 'run_command', summary: 'df -h', state: 'ACTIVE' });
            await send({ type: 'text', runId: 'run-2', delta: 'You have 120 GB free.' });
            await send({ type: 'done', runId: 'run-2', status: 'SUCCESS', response: 'x', conversationId: 'c1' });
            expect(screen.getByTestId('quick-chat-agent-output')).toHaveTextContent('You have 120 GB free.');
            expect(screen.getByTestId('quick-chat-agent-output')).not.toHaveTextContent('ignored');
            expect(screen.getAllByTestId('quick-chat-agent-tool-step')[0]).toHaveAttribute('data-state', 'done');
            expect(screen.getByTestId('quick-chat-agent-announcer')).toHaveTextContent('Answer ready');
        });

        it('replays events of the resumed run that arrive before its id', async () => {
            let resolveApproval: (value: { runId: string }) => void = () => {};
            setup({
                approveAgentCommands: vi.fn(
                    () =>
                        new Promise<{ runId: string }>((resolve) => {
                            resolveApproval = resolve;
                        })
                ),
            });
            await blockedRun();
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-approve-always'));
            });
            expect(api.approveAgentCommands).toHaveBeenCalledWith({ runId: 'run-1', decision: 'always' });
            expect(screen.getByTestId('quick-chat-agent-approve-once')).toBeDisabled();
            await send({ type: 'text', runId: 'run-2', delta: 'Early text' });
            await act(async () => {
                resolveApproval({ runId: 'run-2' });
            });
            expect(screen.getByTestId('quick-chat-agent-output')).toHaveTextContent('Early text');
        });

        it('keeps the card and shows the error when the approval fails', async () => {
            setup({
                approveAgentCommands: vi.fn().mockResolvedValue({ error: 'settings.json is not valid JSON' }),
            });
            await blockedRun();
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-approve-once'));
            });
            expect(screen.getByTestId('quick-chat-agent-approval')).toHaveTextContent('not valid JSON');
            expect(screen.getByTestId('quick-chat-agent-approve-once')).not.toBeDisabled();
        });

        it("Don't allow closes the card and says the agent could not finish", async () => {
            await blockedRun();
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-agent-approve-deny'));
            });
            expect(screen.queryByTestId('quick-chat-agent-approval')).not.toBeInTheDocument();
            expect(screen.getByTestId('quick-chat-agent-empty')).toHaveTextContent(
                'could not finish without running these commands'
            );
            expect(api.approveAgentCommands).not.toHaveBeenCalled();
        });

        it('Escape declines the commands first, then hides Quick Chat', async () => {
            await blockedRun();
            await press('Escape');
            expect(screen.queryByTestId('quick-chat-agent-approval')).not.toBeInTheDocument();
            expect(api.cancelQuickChat).not.toHaveBeenCalled();
            await press('Escape');
            expect(api.cancelQuickChat).toHaveBeenCalled();
        });

        it('offers only Allow once for a command that is not safe to allow for good', async () => {
            await blockedRun({
                blocked: [{ tool: 'run_command', command: 'df -h | sort', summary: 'df -h | sort' }],
            });
            expect(screen.queryByTestId('quick-chat-agent-approve-always')).not.toBeInTheDocument();
            expect(screen.getByTestId('quick-chat-agent-approval')).toHaveTextContent("inside the agent's sandbox");
        });

        it('shows the blocked step without a card when the run cannot be resumed', async () => {
            await blockedRun({ canApprove: undefined });
            expect(screen.queryByTestId('quick-chat-agent-approval')).not.toBeInTheDocument();
            expect(screen.getAllByTestId('quick-chat-agent-tool-step')[0]).toHaveAttribute('data-state', 'blocked');
            expect(screen.getByTestId('quick-chat-agent-empty')).toHaveTextContent('commands it needed were blocked');
        });

        it('keeps a card that waits for a decision when shown again', async () => {
            await blockedRun();
            await act(async () => {
                window.dispatchEvent(new Event('blur'));
            });
            await act(async () => {
                window.dispatchEvent(new Event('focus'));
            });
            expect(screen.getByTestId('quick-chat-agent-approval')).toBeInTheDocument();
        });

        it('says the agent gave no answer instead of "Answer ready" for an empty answer', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: '' });
            expect(screen.getByTestId('quick-chat-agent-empty')).toHaveTextContent('The agent gave no answer.');
            expect(screen.getByTestId('quick-chat-agent-announcer')).toHaveTextContent('The agent gave no answer.');
            expect(screen.getByTestId('quick-chat-agent-announcer')).not.toHaveTextContent('Answer ready');
        });

        it('names the denied actions when nothing else explains an empty answer', async () => {
            await renderApp();
            await startAgentRun();
            await send({ type: 'done', runId: 'run-1', status: 'SUCCESS', response: '', deniedActions: ['read_file'] });
            expect(screen.getByTestId('quick-chat-agent-empty')).toHaveTextContent('read_file');
        });
    });
});
