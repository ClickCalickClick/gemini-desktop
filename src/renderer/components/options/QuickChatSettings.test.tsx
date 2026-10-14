/**
 * Unit tests for the Options "Quick Chat" section (H5).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';

import { QuickChatSettings } from './QuickChatSettings';
import { createMockElectronAPI } from '../../../../tests/helpers/mocks/renderer/electronAPI';
import { LOOKUP_COMMAND_PREFIXES } from '../../../shared/constants/agentLookupCommands';
import type {
    AgentEngineStatus,
    AgentModelList,
    AgentPermissionsInfo,
    AgentSettings,
} from '../../../shared/types/agent';
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

    it('keeps the model being typed when another setting changes', async () => {
        await renderSettings();
        const model = screen.getByTestId('quick-chat-settings-model');
        await act(async () => {
            fireEvent.change(model, { target: { value: 'half-typed' } });
        });
        await act(async () => {
            emitSettings({ ...SETTINGS, quickChatRoutingMode: 'web' });
        });
        expect(model).toHaveValue('half-typed');
        expect(screen.getByTestId('quick-chat-settings-routing')).toHaveValue('web');
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

    describe('Antigravity CLI: model list and command rules', () => {
        const ANTIGRAVITY: AgentEngineStatus = { engine: 'antigravity', available: true, version: '1.3.5' };
        const MODELS: AgentModelList = {
            models: [
                { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
                { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
            ],
            defaultModel: { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
        };
        const PERMISSIONS: AgentPermissionsInfo = {
            supported: true,
            settingsFile: '/home/u/.gemini/antigravity-cli/settings.json',
            lookupCommandsEnabled: false,
            allowedRules: ['command(lsblk)'],
        };

        const setupAntigravity = (overrides: Partial<ElectronAPI> = {}) =>
            setup({
                getAgentStatus: vi.fn().mockResolvedValue(ANTIGRAVITY),
                listAgentModels: vi.fn().mockResolvedValue(MODELS),
                getAgentPermissions: vi.fn().mockResolvedValue(PERMISSIONS),
                ...overrides,
            });

        const modelSelect = async () => {
            await waitFor(() => expect(screen.getByTestId('quick-chat-settings-model').tagName).toBe('SELECT'));
            return screen.getByTestId('quick-chat-settings-model') as HTMLSelectElement;
        };

        it('offers the CLI default and the listed models', async () => {
            setupAntigravity();
            await renderSettings();
            const select = await modelSelect();
            expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
                ['', 'CLI default (Gemini 3.8 Flash (High))'],
                ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
                ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'],
            ]);
            expect(select).toHaveValue('');
            expect(screen.getByLabelText('Model')).toBe(select);
            expect(api.listAgentModels).toHaveBeenCalledWith(false);

            await act(async () => {
                fireEvent.change(select, { target: { value: 'claude-opus-4-6-thinking' } });
            });
            expect(api.setAgentSettings).toHaveBeenCalledWith({ agentModel: 'claude-opus-4-6-thinking' });
        });

        it('keeps a stored model the CLI does not offer now', async () => {
            setupAntigravity({
                getAgentSettings: vi.fn().mockResolvedValue({ ...SETTINGS, agentModel: 'old-model' }),
                listAgentModels: vi.fn().mockResolvedValue({ models: MODELS.models }),
            });
            await renderSettings();
            const select = await modelSelect();
            expect(select).toHaveValue('old-model');
            expect(select.options[0]).toHaveTextContent(/^CLI default$/);
            expect(select.options[select.options.length - 1]).toHaveTextContent('old-model (not offered now)');
        });

        it('refreshes the list on request', async () => {
            setupAntigravity();
            await renderSettings();
            await modelSelect();
            await act(async () => {
                fireEvent.click(screen.getByTestId('quick-chat-settings-model-refresh'));
            });
            expect(api.listAgentModels).toHaveBeenLastCalledWith(true);
        });

        it('falls back to the text box when listing fails, and for Gemini CLI', async () => {
            setupAntigravity({ listAgentModels: vi.fn().mockResolvedValue({ models: [], error: 'timeout' }) });
            await renderSettings();
            await waitFor(() => expect(api.listAgentModels).toHaveBeenCalled());
            expect(screen.getByTestId('quick-chat-settings-model').tagName).toBe('INPUT');

            cleanup();
            setup({
                getAgentStatus: vi.fn().mockResolvedValue({ engine: 'gemini-cli', available: true }),
            });
            await renderSettings();
            await waitFor(() =>
                expect(screen.getByTestId('quick-chat-settings-status')).toHaveTextContent('Gemini CLI')
            );
            expect(screen.getByTestId('quick-chat-settings-model').tagName).toBe('INPUT');
            expect(api.listAgentModels).not.toHaveBeenCalled();
            expect(api.getAgentPermissions).not.toHaveBeenCalled();
            expect(screen.queryByTestId('quick-chat-settings-lookup')).not.toBeInTheDocument();
        });

        it('turns the lookup commands on and lists every rule, grouped', async () => {
            setupAntigravity();
            await renderSettings();
            const toggle = await screen.findByTestId('quick-chat-settings-lookup');
            expect(toggle).toHaveTextContent('System lookup commands');
            expect(toggle).toHaveTextContent('commands that only look at this computer');
            expect(toggle).toHaveTextContent("inside the agent's sandbox: no network, limited file access");
            expect(toggle).not.toHaveTextContent(/read-only/i);

            const list = screen.getByTestId('quick-chat-settings-lookup-list');
            expect(list).toHaveTextContent(`Show the ${LOOKUP_COMMAND_PREFIXES.length} commands`);
            const shown = Array.from(list.querySelectorAll('li code')).map((code) => code.textContent);
            expect(shown).toEqual([...LOOKUP_COMMAND_PREFIXES]);
            expect(list).toHaveTextContent('Disks and file systems');
            expect(list).toHaveTextContent('wrappers such as env');

            const button = screen.getByRole('switch');
            expect(button).toHaveAttribute('aria-checked', 'false');
            await act(async () => {
                fireEvent.click(button);
            });
            expect(api.setLookupAgentCommands).toHaveBeenCalledWith(true);
            await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
            // The engine check runs again after the rules changed.
            expect(api.getAgentStatus).toHaveBeenCalledTimes(2);
        });

        it('lists the commands the user allowed and removes one', async () => {
            setupAntigravity();
            await renderSettings();
            const allowed = await screen.findByTestId('quick-chat-settings-allowed');
            expect(allowed).toHaveTextContent('Commands you allowed');
            expect(allowed).toHaveTextContent('lsblk');
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Remove command(lsblk)' }));
            });
            expect(api.removeAllowedAgentRule).toHaveBeenCalledWith('command(lsblk)');
            await waitFor(() => expect(allowed).toHaveTextContent('None.'));
        });

        it('hides the command rules when the main process does not support them (Windows)', async () => {
            setupAntigravity({
                getAgentPermissions: vi.fn().mockResolvedValue({ ...PERMISSIONS, supported: false, allowedRules: [] }),
            });
            await renderSettings();
            await waitFor(() => expect(api.getAgentPermissions).toHaveBeenCalled());
            await modelSelect();
            expect(screen.queryByTestId('quick-chat-settings-lookup')).not.toBeInTheDocument();
            expect(screen.queryByTestId('quick-chat-settings-allowed')).not.toBeInTheDocument();
        });

        it('shows an invalid settings file and disables the toggle', async () => {
            setupAntigravity({
                getAgentPermissions: vi.fn().mockResolvedValue({
                    ...PERMISSIONS,
                    error: '/home/u/.gemini/antigravity-cli/settings.json is not valid JSON',
                }),
            });
            await renderSettings();
            expect(await screen.findByTestId('quick-chat-settings-permissions-error')).toHaveTextContent(
                'not valid JSON'
            );
            expect(screen.getByRole('switch')).toHaveAttribute('aria-disabled', 'true');
        });
    });
});
