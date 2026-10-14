/**
 * QuickChatSettings Component
 *
 * Options for the hybrid Quick Chat (H5):
 * - Routing: Auto, always the Gemini tab, or always the agent
 * - Agent engine: Auto, Antigravity CLI or Gemini CLI
 * - Model passed to the CLI (optional)
 * - The engine's status, with install and sign-in hints when it is not usable
 *
 * @module QuickChatSettings
 */

import React, { memo, useCallback, useEffect, useId, useState } from 'react';

import { createRendererLogger } from '../../utils';
import { QUICK_CHAT_SETTINGS_TEST_IDS } from '../../utils/testIds';
import type {
    AgentEngineId,
    AgentEnginePreference,
    AgentEngineStatus,
    AgentSettings,
    QuickChatRoutingMode,
} from '../../../shared/types/agent';
import './QuickChatSettings.css';

const logger = createRendererLogger('[QuickChatSettings]');

const DEFAULT_SETTINGS: AgentSettings = {
    quickChatRoutingMode: 'auto',
    agentEngine: 'auto',
    agentModel: '',
};

const ROUTING_OPTIONS: { value: QuickChatRoutingMode; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'web', label: 'Always Gemini tab' },
    { value: 'agent', label: 'Always agent' },
];

const ENGINE_OPTIONS: { value: AgentEnginePreference; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'antigravity', label: 'Antigravity CLI' },
    { value: 'gemini-cli', label: 'Gemini CLI' },
];

const ENGINE_NAMES: Record<AgentEngineId, string> = {
    antigravity: 'Antigravity CLI',
    'gemini-cli': 'Gemini CLI',
};

export const ANTIGRAVITY_HINT =
    'Antigravity CLI: download it from https://antigravity.google/download, then run agy once in a terminal to sign in with your Google account.';
export const GEMINI_CLI_HINT =
    'Gemini CLI: needs a paid Gemini API key in the GEMINI_API_KEY environment variable; personal Google sign-in no longer works.';

interface SettingRowProps {
    label: string;
    description: string;
    controlId: string;
    children: React.ReactNode;
}

function SettingRow({ label, description, controlId, children }: SettingRowProps): React.ReactElement {
    return (
        <div className="quick-chat-settings__row">
            <div className="quick-chat-settings__text">
                <label className="quick-chat-settings__label" htmlFor={controlId}>
                    {label}
                </label>
                <span className="quick-chat-settings__description" id={`${controlId}-description`}>
                    {description}
                </span>
            </div>
            <div className="quick-chat-settings__control">{children}</div>
        </div>
    );
}

function EngineStatusLine({
    status,
    preference,
}: {
    status: AgentEngineStatus | null;
    preference: AgentEnginePreference;
}): React.ReactElement {
    if (!status) {
        return <span className="quick-chat-settings__status-text">Checking for an agent CLI…</span>;
    }
    if (status.available && status.engine) {
        return (
            <span className="quick-chat-settings__status-text quick-chat-settings__status-text--ok">
                <strong>{ENGINE_NAMES[status.engine]}</strong>
                {status.version && <span> {status.version}</span>}
                {status.path && <span className="quick-chat-settings__path"> · {status.path}</span>}
            </span>
        );
    }
    const showAntigravity = preference !== 'gemini-cli';
    const showGeminiCli = preference !== 'antigravity';
    return (
        <span className="quick-chat-settings__status-text quick-chat-settings__status-text--error">
            <span>{status.error ?? 'No agent CLI found.'} Quick Chat sends every prompt to a Gemini tab.</span>
            {showAntigravity && <span className="quick-chat-settings__hint">{ANTIGRAVITY_HINT}</span>}
            {showGeminiCli && <span className="quick-chat-settings__hint">{GEMINI_CLI_HINT}</span>}
        </span>
    );
}

export const QuickChatSettings = memo(function QuickChatSettings() {
    const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
    const [modelDraft, setModelDraft] = useState('');
    const [status, setStatus] = useState<AgentEngineStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const idPrefix = useId();
    const routingId = `${idPrefix}-routing`;
    const engineId = `${idPrefix}-engine`;
    const modelId = `${idPrefix}-model`;

    const refreshStatus = useCallback((): Promise<void> => {
        const getStatus = window.electronAPI?.getAgentStatus;
        if (typeof getStatus !== 'function') {
            return Promise.resolve();
        }
        return getStatus()
            .then((next) => setStatus(next))
            .catch((error: unknown) => {
                logger.error('Failed to load agent status:', error);
                setStatus({ engine: null, available: false, error: 'Could not check for an agent CLI.' });
            });
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        const api = window.electronAPI;

        const load = async () => {
            try {
                if (typeof api?.getAgentSettings === 'function') {
                    const loaded = await api.getAgentSettings();
                    if (!controller.signal.aborted && loaded) {
                        setSettings(loaded);
                        setModelDraft(loaded.agentModel);
                    }
                }
            } catch (error) {
                logger.error('Failed to load agent settings:', error);
            } finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                }
            }
        };
        void load();
        void refreshStatus();

        const unsubscribe =
            typeof api?.onAgentSettingsChanged === 'function'
                ? api.onAgentSettingsChanged((changed) => {
                      setSettings(changed);
                      setModelDraft(changed.agentModel);
                      void refreshStatus();
                  })
                : undefined;

        return () => {
            controller.abort();
            unsubscribe?.();
        };
    }, [refreshStatus]);

    const save = useCallback(
        async (change: Partial<AgentSettings>) => {
            const previous = settings;
            setSettings({ ...settings, ...change });
            const setAgentSettings = window.electronAPI?.setAgentSettings;
            if (typeof setAgentSettings !== 'function') {
                return;
            }
            try {
                const saved = await setAgentSettings(change);
                if (saved) {
                    setSettings(saved);
                }
                if (change.agentEngine !== undefined) {
                    await refreshStatus();
                }
            } catch (error) {
                logger.error('Failed to save agent settings:', error);
                setSettings(previous);
                setModelDraft(previous.agentModel);
            }
        },
        [refreshStatus, settings]
    );

    const saveModel = useCallback(() => {
        const model = modelDraft.trim();
        if (model !== settings.agentModel) {
            void save({ agentModel: model });
        }
        setModelDraft(model);
    }, [modelDraft, save, settings.agentModel]);

    if (loading) {
        return (
            <div className="quick-chat-settings loading" data-testid="quick-chat-settings-loading">
                Loading...
            </div>
        );
    }

    return (
        <div className="quick-chat-settings" data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS}>
            <SettingRow
                label="Where prompts go"
                description="Auto sends questions about files, folders, this computer and local code to the agent, and everything else to a Gemini tab. In Quick Chat, start a prompt with @web or @agent, or press Ctrl+Enter (Cmd+Enter on macOS), to pick the other side."
                controlId={routingId}
            >
                <select
                    id={routingId}
                    className="quick-chat-settings__select"
                    value={settings.quickChatRoutingMode}
                    onChange={(event) =>
                        void save({ quickChatRoutingMode: event.target.value as QuickChatRoutingMode })
                    }
                    aria-describedby={`${routingId}-description`}
                    data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_ROUTING}
                >
                    {ROUTING_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </SettingRow>

            <SettingRow
                label="Agent engine"
                description="The command-line agent that answers on this computer. Auto uses Antigravity CLI when it is installed, otherwise Gemini CLI."
                controlId={engineId}
            >
                <select
                    id={engineId}
                    className="quick-chat-settings__select"
                    value={settings.agentEngine}
                    onChange={(event) => void save({ agentEngine: event.target.value as AgentEnginePreference })}
                    aria-describedby={`${engineId}-description`}
                    data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_ENGINE}
                >
                    {ENGINE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </SettingRow>

            <SettingRow
                label="Model"
                description="Optional. Leave empty to use the CLI's default model."
                controlId={modelId}
            >
                <input
                    id={modelId}
                    type="text"
                    className="quick-chat-settings__input"
                    value={modelDraft}
                    placeholder="Default"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setModelDraft(event.target.value)}
                    onBlur={saveModel}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            saveModel();
                        }
                    }}
                    aria-describedby={`${modelId}-description`}
                    data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_MODEL}
                />
            </SettingRow>

            <div
                className="quick-chat-settings__status"
                role="status"
                aria-live="polite"
                data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_STATUS}
            >
                <EngineStatusLine status={status} preference={settings.agentEngine} />
                <button
                    type="button"
                    className="quick-chat-settings__recheck"
                    onClick={() => void refreshStatus()}
                    data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_RECHECK}
                >
                    Check again
                </button>
            </div>
        </div>
    );
});

export default QuickChatSettings;
