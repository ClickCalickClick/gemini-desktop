import { ipcRenderer } from 'electron';

import { IPC_CHANNELS } from '../../shared/constants/ipc-channels';
import type { ElectronAPI } from '../../shared/types';
import type { AgentRunEvent, AgentSettings } from '../../shared/types/agent';
import { createSubscription } from '../createSubscription';

export const agentAPI: Pick<
    ElectronAPI,
    | 'getAgentStatus'
    | 'getAgentSettings'
    | 'setAgentSettings'
    | 'onAgentSettingsChanged'
    | 'runAgent'
    | 'cancelAgent'
    | 'onAgentEvent'
    | 'applyFilePlan'
    | 'undoLastFilePlan'
    | 'approveAgentCommands'
    | 'getAgentPermissions'
    | 'setReadOnlyAgentCommands'
    | 'removeAllowedAgentRule'
    | 'listAgentModels'
> = {
    getAgentStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STATUS_GET),
    getAgentSettings: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SETTINGS_GET),
    setAgentSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SETTINGS_SET, settings),
    onAgentSettingsChanged: createSubscription<AgentSettings>(IPC_CHANNELS.AGENT_SETTINGS_CHANGED),
    runAgent: (request) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_RUN, request),
    cancelAgent: (runId) => ipcRenderer.send(IPC_CHANNELS.AGENT_CANCEL, runId),
    onAgentEvent: createSubscription<AgentRunEvent>(IPC_CHANNELS.AGENT_EVENT),
    applyFilePlan: (runId) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_APPLY_PLAN, runId),
    undoLastFilePlan: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_UNDO_LAST),
    approveAgentCommands: (request) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_APPROVE_COMMANDS, request),
    getAgentPermissions: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_PERMISSIONS_GET),
    setReadOnlyAgentCommands: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_READ_ONLY_COMMANDS_SET, enabled),
    removeAllowedAgentRule: (rule) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ALLOWED_RULE_REMOVE, rule),
    listAgentModels: (refresh) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_MODELS_LIST, refresh === true),
};
