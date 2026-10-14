/**
 * Unit tests for the Options "Quick Chat" section (H5).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

import { QuickChatSettings } from './QuickChatSettings';
import { createMockElectronAPI } from '../../../../tests/helpers/mocks/renderer/electronAPI';
import type { AgentEngineStatus, AgentSettings } from '../../../shared/types/agent';
import type { ElectronAPI } from '../../../shared/types/ipc';

const SETTINGS: AgentSettings = { quickChatRoutingMode: 'auto', agentEngine: 'auto', agentModel: '' };

describe('QuickChatSettings', () => {
    let api: ElectronAPI;
    let emitSettings: (settings: AgentSettings) => void;

    const setup = (overrides: Partial<ElectronAPI> = {}) => {
        api = createMockElectronAPI({
            getAgentSettings: vi.fn().mockResolvedValue(SETTINGS),
            onAgentSettingsChanged: vi.fn((callback: (settings: AgentSettings) => void) => {
                emitSettings = callback;
                return () => {};
            }),
            ...overrides,
        });
        window.electronAPI = api;
    };

    const renderSettings = async () => {
        await act(async () => {
            render(<QuickChatSettings />);
        });
        await screen.findByTestId('quick-chat-settings');
    };

    beforeEach(() => {
        vi.clearAllMocks();
        setup();
    });

    afterEach(() => {
        window.electronAPI = undefined;
    });

    it('loads and shows the settings', async () => {
        setup({
            getAgentSettings: vi.fn().mockResolvedValue({
                quickChatRoutingMode: 'web',
                agentEngine: 'gemini-cli',
                agentModel: 'gemini-3-pro',
            }),
        });
        await renderSettings();
        expect(screen.getByTestId('quick-chat-settings-routing')).toHaveValue('web');
        expect(screen.getByTestId('quick-chat-settings-engine')).toHaveValue('gemini-cli');
        expect(screen.getByTestId('quick-chat-settings-model')).toHaveValue('gemini-3-pro');
    });

    it('labels every control', async () => {
        await renderSettings();
        expect(screen.getByLabelText('Where prompts go')).toBe(screen.getByTestId('quick-chat-settings-routing'));
        expect(screen.getByLabelText('Agent engine')).toBe(screen.getByTestId('quick-chat-settings-engine'));
        expect(screen.getByLabelText('Model')).toBe(screen.getByTestId('quick-chat-settings-model'));
    });

    it('offers the routing modes and engines', async () => {
        await renderSettings();
        const routing = screen.getByTestId('quick-chat-settings-routing') as HTMLSelectElement;
        expect(Array.from(routing.options).map((o) => o.textContent)).toEqual([
            'Auto',
            'Always Gemini tab',
            'Always agent',
        ]);
        const engine = screen.getByTestId('quick-chat-settings-engine') as HTMLSelectElement;
        expect(Array.from(engine.options).map((o) => o.textContent)).toEqual(['Auto', 'Antigravity CLI', 'Gemini CLI']);
    });

    it('saves the routing mode', async () => {
        await renderSettings();
        await act(async () => {
            fireEvent.change(screen.getByTestId('quick-chat-settings-routing'), { target: { value: 'agent' } });
        });
        expect(api.setAgentSettings).toHaveBeenCalledWith({ quickChatRoutingMode: 'agent' });
        expect(screen.getByTestId('quick-chat-settings-routing')).toHaveValue('agent');
    });

    it('saves the engine and checks its status again', async () => {
        await renderSettings();
        expect(api.getAgentStatus).toHaveBeenCalledTimes(1);
        await act(async () => {
            fireEvent.change(screen.getByTestId('quick-chat-settings-engine'), { target: { value: 'antigravity' } });
        });
        expect(api.setAgentSettings).toHaveBeenCalledWith({ agentEngine: 'antigravity' });
        await waitFor(() => expect(api.getAgentStatus).toHaveBeenCalledTimes(2));
    });

    it('saves the model on blur, trimmed', async () => {
        await renderSettings();
        const model = screen.getByTestId('quick-chat-settings-model');
        await act(async () => {
            fireEvent.change(model, { target: { value: '  gemini-3-flash ' } });
        });
        expect(api.setAgentSettings).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.blur(model);
        });
        expect(api.setAgentSettings).toHaveBeenCalledWith({ agentModel: 'gemini-3-flash' });
        expect(model).toHaveValue('gemini-3-flash');
    });

    it('saves the model on Enter and not again on blur', async () => {
        await renderSettings();
        const model = screen.getByTestId('quick-chat-settings-model');
        await act(async () => {
            fireEvent.change(model, { target: { value: 'x' } });
        });
        await act(async () => {
            fireEvent.keyDown(model, { key: 'Enter' });
        });
        await act(async () => {
            fireEvent.blur(model);
        });
        expect(api.setAgentSettings).toHaveBeenCalledTimes(1);
        expect(api.setAgentSettings).toHaveBeenCalledWith({ agentModel: 'x' });
    });

    it('does not save an unchanged model', async () => {
        await renderSettings();
        await act(async () => {
            fireEvent.blur(screen.getByTestId('quick-chat-settings-model'));
        });
        expect(api.setAgentSettings).not.toHaveBeenCalled();
    });

    it('reverts when saving fails', async () => {
        setup({ setAgentSettings: vi.fn().mockRejectedValue(new Error('disk full')) });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await renderSettings();
        await act(async () => {
            fireEvent.change(screen.getByTestId('quick-chat-settings-routing'), { target: { value: 'web' } });
        });
        await waitFor(() => expect(screen.getByTestId('quick-chat-settings-routing')).toHaveValue('auto'));
    });

    it('follows settings changed elsewhere', async () => {
        await renderSettings();
        await act(async () => {
            emitSettings({ quickChatRoutingMode: 'agent', agentEngine: 'antigravity', agentModel: 'm' });
        });
        expect(screen.getByTestId('quick-chat-settings-routing')).toHaveValue('agent');
        expect(screen.getByTestId('quick-chat-settings-model')).toHaveValue('m');
    });

    it('shows the engine, version and path when an agent is installed', async () => {
        const status: AgentEngineStatus = {
            engine: 'antigravity',
            available: true,
            version: '1.4.2',
            path: '/usr/bin/agy',
        };
        setup({ getAgentStatus: vi.fn().mockResolvedValue(status) });
        await renderSettings();
        const line = await screen.findByTestId('quick-chat-settings-status');
        await waitFor(() => expect(line).toHaveTextContent('Antigravity CLI 1.4.2'));
        expect(line).toHaveTextContent('/usr/bin/agy');
        expect(line).not.toHaveTextContent('antigravity.google/download');
    });

    it('shows the error with install and sign-in hints when no agent is installed', async () => {
        await renderSettings();
        const line = screen.getByTestId('quick-chat-settings-status');
        await waitFor(() => expect(line).toHaveTextContent('No agent CLI found'));
        expect(line).toHaveTextContent('https://antigravity.google/download');
        expect(line).toHaveTextContent('run agy once');
        expect(line).toHaveTextContent('GEMINI_API_KEY');
    });

    it('only shows the hint for the chosen engine', async () => {
        setup({
            getAgentSettings: vi.fn().mockResolvedValue({ ...SETTINGS, agentEngine: 'gemini-cli' }),
            getAgentStatus: vi
                .fn()
                .mockResolvedValue({ engine: null, available: false, error: 'GEMINI_API_KEY is not set' }),
        });
        await renderSettings();
        const line = screen.getByTestId('quick-chat-settings-status');
        await waitFor(() => expect(line).toHaveTextContent('GEMINI_API_KEY is not set'));
        expect(line).not.toHaveTextContent('antigravity.google/download');
    });

    it('checks the status again on request', async () => {
        const getAgentStatus = vi
            .fn()
            .mockResolvedValueOnce({ engine: null, available: false, error: 'No agent CLI found' })
            .mockResolvedValue({ engine: 'antigravity', available: true, version: '1.0.0' });
        setup({ getAgentStatus });
        await renderSettings();
        await act(async () => {
            fireEvent.click(screen.getByTestId('quick-chat-settings-recheck'));
        });
        await waitFor(() =>
            expect(screen.getByTestId('quick-chat-settings-status')).toHaveTextContent('Antigravity CLI 1.0.0')
        );
    });

    it('renders without the agent API', async () => {
        window.electronAPI = undefined;
        await act(async () => {
            render(<QuickChatSettings />);
        });
        expect(await screen.findByTestId('quick-chat-settings')).toBeInTheDocument();
    });
});
