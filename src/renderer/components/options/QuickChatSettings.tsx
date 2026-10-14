/**
 * QuickChatSettings Component
 *
 * Options for the hybrid Quick Chat (H5):
 * - Routing: Auto, always the Gemini tab, or always the agent
 * - Agent engine: Auto, Antigravity CLI or Gemini CLI
 * - Model passed to the CLI: a list from `agy models` for Antigravity CLI, else a text box
 * - The engine's status, with install and sign-in hints when it is not usable
 * - Antigravity CLI only (not on Windows): the system lookup commands toggle (with the full list) and
 *   the commands the user allowed for good from Quick Chat's approval card
 *
 * @module QuickChatSettings
 */

import React, { memo, useCallback, useEffect, useId, useRef, useState } from 'react';

import { CapsuleToggle } from '../common/CapsuleToggle';
import { createRendererLogger } from '../../utils';
import { QUICK_CHAT_SETTINGS_TEST_IDS } from '../../utils/testIds';
import { LOOKUP_COMMAND_GROUPS, LOOKUP_COMMAND_PREFIXES } from '../../../shared/constants/agentLookupCommands';
import type {
    AgentEngineId,
    AgentEnginePreference,
    AgentEngineStatus,
    AgentModelList,
    AgentPermissionsInfo,
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

/** The command target of a `command(...)` rule, for display. */
function ruleTarget(rule: string): string {
    return rule.replace(/^command\((.*)\)$/s, '$1');
}

interface CommandPermissionsProps {
    permissions: AgentPermissionsInfo;
    busy: boolean;
    onToggleLookup: (enabled: boolean) => void;
    onRemoveRule: (rule: string) => void;
}

/** Antigravity CLI only (not on Windows): the lookup command list and the commands the user allowed for good. */
function CommandPermissions({
    permissions,
    busy,
    onToggleLookup,
    onRemoveRule,
}: CommandPermissionsProps): React.ReactElement {
    return (
        <div className="quick-chat-settings__permissions">
            <CapsuleToggle
                checked={permissions.lookupCommandsEnabled}
                onChange={onToggleLookup}
                disabled={busy || Boolean(permissions.error)}
                label="System lookup commands"
                description="Let the agent run commands that only look at this computer (like df, free, lsblk) to answer questions about it. They run inside the agent's sandbox: no network, limited file access, and your home folders are not visible there."
                testId={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_LOOKUP}
            />
            <details
                className="quick-chat-settings__disclosure"
                data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_LOOKUP_LIST}
            >
                <summary>Show the {LOOKUP_COMMAND_PREFIXES.length} commands</summary>
                <p className="quick-chat-settings__description">
                    Each one is added to {permissions.settingsFile} as an allow rule such as command(df), which also
                    allows the same command with more words after it (df -h), also behind wrappers such as env or nice,
                    so the agent can run code of its own inside the sandbox with it. Turning this off removes these
                    rules again, except ones you also allowed from Quick Chat or had before.
                </p>
                {LOOKUP_COMMAND_GROUPS.map((group) => (
                    <div key={group.name} className="quick-chat-settings__group">
                        <span className="quick-chat-settings__group-name">{group.name}</span>
                        <ul className="quick-chat-settings__rules">
                            {group.prefixes.map((prefix) => (
                                <li key={prefix}>
                                    <code>{prefix}</code>
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </details>

            <div
                className="quick-chat-settings__allowed"
                data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_ALLOWED}
            >
                <span className="quick-chat-settings__label">Commands you allowed</span>
                {permissions.allowedRules.length === 0 ? (
                    <span className="quick-chat-settings__description">
                        None. Choose “Always allow” when Quick Chat asks to run a command to add one here.
                    </span>
                ) : (
                    <ul className="quick-chat-settings__allowed-list">
                        {permissions.allowedRules.map((rule) => (
                            <li key={rule}>
                                <code title={rule}>{ruleTarget(rule)}</code>
                                <button
                                    type="button"
                                    className="quick-chat-settings__recheck"
                                    onClick={() => onRemoveRule(rule)}
                                    disabled={busy}
                                    aria-label={`Remove ${rule}`}
                                    data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_ALLOWED_REMOVE}
                                >
                                    Remove
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {permissions.error && (
                <p
                    className="quick-chat-settings__permissions-error"
                    role="alert"
                    data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_PERMISSIONS_ERROR}
                >
                    {permissions.error}
                </p>
            )}
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
    const [models, setModels] = useState<AgentModelList | null>(null);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [permissions, setPermissions] = useState<AgentPermissionsInfo | null>(null);
    const [permissionsBusy, setPermissionsBusy] = useState(false);
    /** The model last loaded or saved; the draft only follows it when it really changes. */
    const knownModelRef = useRef('');
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

    const loadModels = useCallback((refresh = false): Promise<void> => {
        const listModels = window.electronAPI?.listAgentModels;
        if (typeof listModels !== 'function') {
            return Promise.resolve();
        }
        setModelsLoading(true);
        return listModels(refresh)
            .then((list) => setModels(list))
            .catch((error: unknown) => {
                logger.error('Failed to list agent models:', error);
                setModels({ models: [], error: 'Could not list the models.' });
            })
            .finally(() => setModelsLoading(false));
    }, []);

    // The model list and the command rules depend on the engine in use.
    const engineInUse = status?.engine ?? null;
    useEffect(() => {
        if (engineInUse !== 'antigravity') {
            return;
        }
        const controller = new AbortController();
        const api = window.electronAPI;
        if (typeof api?.listAgentModels === 'function') {
            api.listAgentModels(false)
                .then((list) => {
                    if (!controller.signal.aborted) {
                        setModels(list);
                    }
                })
                .catch((error: unknown) => logger.error('Failed to list agent models:', error));
        }
        if (typeof api?.getAgentPermissions === 'function') {
            api.getAgentPermissions()
                .then((info) => {
                    if (!controller.signal.aborted) {
                        setPermissions(info);
                    }
                })
                .catch((error: unknown) => logger.error('Failed to load agent permissions:', error));
        }
        return () => controller.abort();
    }, [engineInUse]);

    const changePermissions = useCallback(
        async (change: () => Promise<AgentPermissionsInfo> | undefined) => {
            setPermissionsBusy(true);
            try {
                const info = await change();
                if (info) {
                    setPermissions(info);
                }
                // The settings check may give a different answer now.
                await refreshStatus();
            } catch (error) {
                logger.error('Failed to change agent permissions:', error);
                setPermissions((current) =>
                    current ? { ...current, error: 'Could not change the command rules.' } : current
                );
            } finally {
                setPermissionsBusy(false);
            }
        },
        [refreshStatus]
    );

    useEffect(() => {
        const controller = new AbortController();
        const api = window.electronAPI;

        const load = async () => {
            try {
                if (typeof api?.getAgentSettings === 'function') {
                    const loaded = await api.getAgentSettings();
                    if (!controller.signal.aborted && loaded) {
                        setSettings(loaded);
                        knownModelRef.current = loaded.agentModel;
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
                      if (changed.agentModel !== knownModelRef.current) {
                          // Only replace what the user is typing when the model itself changed.
                          knownModelRef.current = changed.agentModel;
                          setModelDraft(changed.agentModel);
                      }
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
                    knownModelRef.current = saved.agentModel;
                }
                if (change.agentEngine !== undefined) {
                    await refreshStatus();
                }
            } catch (error) {
                logger.error('Failed to save agent settings:', error);
                setSettings(previous);
                if (change.agentModel !== undefined) {
                    knownModelRef.current = previous.agentModel;
                    setModelDraft(previous.agentModel);
                }
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

    // A list only for Antigravity CLI and when listing worked; otherwise the text box.
    const modelList =
        engineInUse === 'antigravity' && models && models.models.length > 0 && !models.error ? models : null;

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

            {modelList ? (
                <SettingRow
                    label="Model"
                    description="The models Antigravity CLI offers. CLI default follows the CLI's own choice."
                    controlId={modelId}
                >
                    <div className="quick-chat-settings__model">
                        <select
                            id={modelId}
                            className="quick-chat-settings__select"
                            value={settings.agentModel}
                            onChange={(event) => {
                                setModelDraft(event.target.value);
                                void save({ agentModel: event.target.value });
                            }}
                            aria-describedby={`${modelId}-description`}
                            data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_MODEL}
                        >
                            <option value="">
                                {modelList.defaultModel
                                    ? `CLI default (${modelList.defaultModel.name})`
                                    : 'CLI default'}
                            </option>
                            {modelList.models.map((model) => (
                                <option key={model.id} value={model.id}>
                                    {model.name}
                                </option>
                            ))}
                            {settings.agentModel &&
                                !modelList.models.some((model) => model.id === settings.agentModel) && (
                                    <option value={settings.agentModel}>{settings.agentModel} (not offered now)</option>
                                )}
                        </select>
                        <button
                            type="button"
                            className="quick-chat-settings__recheck"
                            onClick={() => void loadModels(true)}
                            disabled={modelsLoading}
                            aria-label="Refresh the model list"
                            data-testid={QUICK_CHAT_SETTINGS_TEST_IDS.QUICK_CHAT_SETTINGS_MODEL_REFRESH}
                        >
                            {modelsLoading ? 'Refreshing…' : 'Refresh'}
                        </button>
                    </div>
                </SettingRow>
            ) : (
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
            )}

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

            {engineInUse === 'antigravity' && permissions?.supported && (
                <CommandPermissions
                    permissions={permissions}
                    busy={permissionsBusy}
                    onToggleLookup={(enabled) =>
                        void changePermissions(() => window.electronAPI?.setLookupAgentCommands(enabled))
                    }
                    onRemoveRule={(rule) =>
                        void changePermissions(() => window.electronAPI?.removeAllowedAgentRule(rule))
                    }
                />
            )}
        </div>
    );
});

export default QuickChatSettings;
