/**
 * IPC handler for the hybrid Quick Chat's agent engine.
 *
 * Channels: agent:status-get, agent:settings-get, agent:settings-set (broadcasts
 * agent:settings-changed), agent:run (streams agent:event), agent:cancel,
 * agent:apply-plan and agent:undo-last. The work is done by AgentManager.
 *
 * @module ipc/AgentIpcHandler
 */

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { BaseIpcHandler } from './BaseIpcHandler';
import { validateRunRequest } from '../agentManager';
import { IPC_CHANNELS } from '../../utils/constants';
import type {
    AgentEnginePreference,
    AgentEngineStatus,
    AgentRunEvent,
    AgentSettings,
    FileActionResult,
    QuickChatRoutingMode,
} from '../../../shared/types/agent';

const ROUTING_MODES: readonly QuickChatRoutingMode[] = ['auto', 'web', 'agent'];
const ENGINE_PREFERENCES: readonly AgentEnginePreference[] = ['auto', 'antigravity', 'gemini-cli'];
export const MAX_AGENT_MODEL_LENGTH = 100;
const AGENT_MODEL_PATTERN = /^[A-Za-z0-9._:-]*$/;

const DEFAULT_SETTINGS: AgentSettings = {
    quickChatRoutingMode: 'auto',
    agentEngine: 'auto',
    agentModel: '',
};

/**
 * Check a partial settings update. Unknown keys are ignored; an invalid value throws.
 */
export function validateAgentSettingsUpdate(update: unknown): Partial<AgentSettings> {
    if (typeof update !== 'object' || update === null || Array.isArray(update)) {
        throw new Error('Invalid agent settings.');
    }
    const candidate = update as Record<string, unknown>;
    const result: Partial<AgentSettings> = {};

    if (candidate.quickChatRoutingMode !== undefined) {
        if (!ROUTING_MODES.includes(candidate.quickChatRoutingMode as QuickChatRoutingMode)) {
            throw new Error('Invalid Quick Chat routing mode.');
        }
        result.quickChatRoutingMode = candidate.quickChatRoutingMode as QuickChatRoutingMode;
    }
    if (candidate.agentEngine !== undefined) {
        if (!ENGINE_PREFERENCES.includes(candidate.agentEngine as AgentEnginePreference)) {
            throw new Error('Invalid agent engine.');
        }
        result.agentEngine = candidate.agentEngine as AgentEnginePreference;
    }
    if (candidate.agentModel !== undefined) {
        if (typeof candidate.agentModel !== 'string') {
            throw new Error('Invalid agent model.');
        }
        const model = candidate.agentModel.trim();
        if (model.length > MAX_AGENT_MODEL_LENGTH || !AGENT_MODEL_PATTERN.test(model)) {
            throw new Error('The model name may only use letters, digits and . _ : - (up to 100 characters).');
        }
        result.agentModel = model;
    }
    return result;
}

export class AgentIpcHandler extends BaseIpcHandler {
    register(): void {
        ipcMain.handle(IPC_CHANNELS.AGENT_STATUS_GET, () => this.handleStatusGet());
        ipcMain.handle(IPC_CHANNELS.AGENT_SETTINGS_GET, () => this.getSettings());
        ipcMain.handle(IPC_CHANNELS.AGENT_SETTINGS_SET, (_event, update: unknown) => this.handleSettingsSet(update));
        ipcMain.handle(IPC_CHANNELS.AGENT_RUN, (event, request: unknown) => this.handleRun(event, request));
        ipcMain.on(IPC_CHANNELS.AGENT_CANCEL, (_event: IpcMainEvent, runId: unknown) => this.handleCancel(runId));
        ipcMain.handle(IPC_CHANNELS.AGENT_APPLY_PLAN, (_event, runId: unknown) => this.handleApplyPlan(runId));
        ipcMain.handle(IPC_CHANNELS.AGENT_UNDO_LAST, () => this.handleUndoLast());
    }

    /** Read the agent settings, falling back to defaults for missing or invalid values. */
    getSettings(): AgentSettings {
        const store = this.deps.store;
        const routing = store.get('quickChatRoutingMode');
        const engine = store.get('agentEngine');
        const model = store.get('agentModel');
        return {
            quickChatRoutingMode: ROUTING_MODES.includes(routing as QuickChatRoutingMode)
                ? (routing as QuickChatRoutingMode)
                : DEFAULT_SETTINGS.quickChatRoutingMode,
            agentEngine: ENGINE_PREFERENCES.includes(engine as AgentEnginePreference)
                ? (engine as AgentEnginePreference)
                : DEFAULT_SETTINGS.agentEngine,
            agentModel:
                typeof model === 'string' && model.length <= MAX_AGENT_MODEL_LENGTH && AGENT_MODEL_PATTERN.test(model)
                    ? model
                    : DEFAULT_SETTINGS.agentModel,
        };
    }

    private async handleStatusGet(): Promise<AgentEngineStatus> {
        const manager = this.deps.agentManager;
        if (!manager) {
            return { engine: null, available: false, error: 'The agent engine is not available in this build.' };
        }
        try {
            return await manager.getStatus(this.getSettings().agentEngine);
        } catch (error) {
            this.handleError('getting agent status', error);
            return { engine: null, available: false, error: 'Could not check for an agent CLI.' };
        }
    }

    private handleSettingsSet(update: unknown): AgentSettings {
        const valid = validateAgentSettingsUpdate(update);
        const before = this.getSettings();
        for (const [key, value] of Object.entries(valid) as [keyof AgentSettings, string][]) {
            this.deps.store.set(key, value);
        }
        const after = this.getSettings();
        if (after.agentEngine !== before.agentEngine) {
            this.deps.agentManager?.invalidateStatus();
        }
        this.logger.log('Agent settings updated:', {
            quickChatRoutingMode: after.quickChatRoutingMode,
            agentEngine: after.agentEngine,
            agentModelSet: after.agentModel.length > 0,
        });
        this.broadcastToAllWindows(IPC_CHANNELS.AGENT_SETTINGS_CHANGED, after);
        return after;
    }

    /** Quick Chat's window gets the events; the sender is the fallback. */
    private eventTarget(sender: WebContents): WebContents | null {
        const quickChat = this.deps.windowManager.getQuickChatWindow();
        if (quickChat && !quickChat.isDestroyed() && !quickChat.webContents.isDestroyed()) {
            return quickChat.webContents;
        }
        return sender && !sender.isDestroyed() ? sender : null;
    }

    private async handleRun(event: IpcMainInvokeEvent, request: unknown): Promise<{ runId: string }> {
        const manager = this.deps.agentManager;
        if (!manager) {
            throw new Error('The agent engine is not available in this build.');
        }
        const settings = this.getSettings();
        const sender = event.sender;
        const { screenshotId } = validateRunRequest(request);
        const screenshot = screenshotId ? this.deps.screenshotManager?.take(screenshotId) : null;
        if (screenshotId && !screenshot) {
            throw new Error('The screenshot is no longer available. Take it again.');
        }
        return manager.run(request, {
            enginePreference: settings.agentEngine,
            model: settings.agentModel,
            ...(screenshot ? { screenshot } : {}),
            emit: (agentEvent: AgentRunEvent) => {
                try {
                    this.eventTarget(sender)?.send(IPC_CHANNELS.AGENT_EVENT, agentEvent);
                } catch (error) {
                    this.handleError('sending agent event', error, { type: agentEvent.type });
                }
            },
        });
    }

    private handleCancel(runId: unknown): void {
        try {
            this.deps.agentManager?.cancel(runId);
        } catch (error) {
            this.handleError('cancelling agent run', error);
        }
    }

    private async handleApplyPlan(runId: unknown): Promise<FileActionResult> {
        const manager = this.deps.agentManager;
        if (!manager) {
            return {
                applied: 0,
                failed: [{ id: '', error: 'The agent engine is not available.' }],
                undoAvailable: false,
            };
        }
        return manager.applyPlan(runId);
    }

    private async handleUndoLast(): Promise<FileActionResult> {
        const manager = this.deps.agentManager;
        if (!manager) {
            return {
                applied: 0,
                failed: [{ id: '', error: 'The agent engine is not available.' }],
                undoAvailable: false,
            };
        }
        return manager.undoLastPlan();
    }

    unregister(): void {
        ipcMain.removeHandler(IPC_CHANNELS.AGENT_STATUS_GET);
        ipcMain.removeHandler(IPC_CHANNELS.AGENT_SETTINGS_GET);
        ipcMain.removeHandler(IPC_CHANNELS.AGENT_SETTINGS_SET);
        ipcMain.removeHandler(IPC_CHANNELS.AGENT_RUN);
        ipcMain.removeAllListeners(IPC_CHANNELS.AGENT_CANCEL);
        ipcMain.removeHandler(IPC_CHANNELS.AGENT_APPLY_PLAN);
        ipcMain.removeHandler(IPC_CHANNELS.AGENT_UNDO_LAST);
    }
}
