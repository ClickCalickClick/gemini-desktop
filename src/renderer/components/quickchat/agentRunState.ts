/**
 * State of the agent run shown in Quick Chat's results panel.
 *
 * A pure reducer so the streaming logic can be tested on its own. Quick Chat keeps
 * one turn on screen at a time; the conversation id carries over for follow-ups.
 *
 * @module agentRunState
 */

import type {
    AgentEngineId,
    AgentRunEvent,
    AgentRunStatus,
    AgentTaskCategory,
    FileActionPlan,
    FileActionResult,
} from '../../../shared/types/agent';

export interface ToolStep {
    key: number;
    name: string;
    summary: string;
    state: 'ACTIVE' | 'DONE';
    error?: string;
}

export type AgentRunPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'done';

export type PlanState = 'pending' | 'applying' | 'applied' | 'cancelled' | 'undoing' | 'undone';

export interface AgentRunState {
    phase: AgentRunPhase;
    runId: string | null;
    /** The prompt of the turn on screen (without any routing prefix). */
    prompt: string;
    category: AgentTaskCategory;
    engine: AgentEngineId | null;
    /** Streamed answer so far. */
    text: string;
    tools: ToolStep[];
    plan: FileActionPlan | null;
    planState: PlanState | null;
    planResult: FileActionResult | null;
    undoResult: FileActionResult | null;
    planError: string | null;
    status: AgentRunStatus | null;
    error: string | null;
    /** Conversation to continue with the next agent prompt. */
    conversationId: string | null;
    nextToolKey: number;
}

export type AgentRunAction =
    | { type: 'start'; prompt: string; category: AgentTaskCategory }
    | { type: 'assigned'; runId: string }
    | { type: 'event'; event: AgentRunEvent }
    | { type: 'stopRequested' }
    | { type: 'stopTimedOut' }
    | { type: 'startFailed'; error: string }
    | { type: 'setupMissing'; prompt: string; category: AgentTaskCategory; error: string }
    | { type: 'planApplying' }
    | { type: 'planApplied'; result: FileActionResult }
    | { type: 'planCancelled' }
    | { type: 'planUndoing' }
    | { type: 'planUndone'; result: FileActionResult }
    | { type: 'planFailed'; error: string }
    | { type: 'reset' };

export const INITIAL_AGENT_RUN_STATE: AgentRunState = {
    phase: 'idle',
    runId: null,
    prompt: '',
    category: 'general',
    engine: null,
    text: '',
    tools: [],
    plan: null,
    planState: null,
    planResult: null,
    undoResult: null,
    planError: null,
    status: null,
    error: null,
    conversationId: null,
    nextToolKey: 0,
};

/** True while a run is starting, running or stopping. */
export function isRunActive(state: AgentRunState): boolean {
    return state.phase === 'starting' || state.phase === 'running' || state.phase === 'stopping';
}

/** Whether an error means no agent CLI is installed or it is not signed in. */
export function needsSetupHint(error: string | null | undefined): boolean {
    if (!error) {
        return false;
    }
    return /no agent|not found|not installed|enoent|sign[\s-]?in|log[\s-]?in|auth|credential|unauthori[sz]ed|api[\s_-]?key/i.test(
        error
    );
}

function applyEvent(state: AgentRunState, event: AgentRunEvent): AgentRunState {
    // Ignore other runs, and anything that arrives after this run ended.
    if (event.runId !== state.runId || state.phase === 'done' || state.phase === 'idle') {
        return state;
    }
    switch (event.type) {
        case 'started':
            return { ...state, phase: state.phase === 'stopping' ? 'stopping' : 'running', engine: event.engine };
        case 'text':
            return {
                ...state,
                phase: state.phase === 'starting' ? 'running' : state.phase,
                text: state.text + event.delta,
            };
        case 'tool': {
            if (event.state === 'DONE') {
                let index = -1;
                for (let i = state.tools.length - 1; i >= 0; i--) {
                    const step = state.tools[i];
                    if (step && step.state === 'ACTIVE' && step.name === event.name && step.summary === event.summary) {
                        index = i;
                        break;
                    }
                }
                const existing = state.tools[index];
                if (existing) {
                    const tools = state.tools.slice();
                    tools[index] = { ...existing, state: 'DONE', error: event.error };
                    return { ...state, tools };
                }
            }
            const step: ToolStep = {
                key: state.nextToolKey,
                name: event.name,
                summary: event.summary,
                state: event.state,
                error: event.error,
            };
            return { ...state, tools: [...state.tools, step], nextToolKey: state.nextToolKey + 1 };
        }
        case 'plan':
            return {
                ...state,
                plan: event.plan,
                planState: 'pending',
                planResult: null,
                undoResult: null,
                planError: null,
            };
        case 'done':
            return {
                ...state,
                phase: 'done',
                status: event.status,
                error: event.error ?? null,
                // For file runs the response is the plan summary, which the plan box already shows.
                text: state.text || (state.plan ? '' : event.response),
                conversationId: event.conversationId ?? state.conversationId,
                tools: state.tools.map((step) => (step.state === 'ACTIVE' ? { ...step, state: 'DONE' } : step)),
            };
        default:
            return state;
    }
}

export function agentRunReducer(state: AgentRunState, action: AgentRunAction): AgentRunState {
    switch (action.type) {
        case 'start':
            return {
                ...INITIAL_AGENT_RUN_STATE,
                phase: 'starting',
                prompt: action.prompt,
                category: action.category,
                conversationId: state.conversationId,
            };
        case 'assigned':
            return { ...state, runId: action.runId };
        case 'event':
            return applyEvent(state, action.event);
        case 'stopTimedOut':
            return state.phase === 'stopping' ? { ...state, phase: 'done', status: 'CANCELED' } : state;
        case 'stopRequested':
            return isRunActive(state) ? { ...state, phase: 'stopping' } : state;
        case 'startFailed':
            return { ...state, phase: 'done', status: 'ERROR', error: action.error };
        case 'setupMissing':
            return {
                ...INITIAL_AGENT_RUN_STATE,
                phase: 'done',
                prompt: action.prompt,
                category: action.category,
                status: 'ERROR',
                error: action.error,
                conversationId: state.conversationId,
            };
        case 'planApplying':
            return { ...state, planState: 'applying', planError: null };
        case 'planApplied':
            return { ...state, planState: 'applied', planResult: action.result };
        case 'planCancelled':
            return { ...state, planState: 'cancelled' };
        case 'planUndoing':
            return { ...state, planState: 'undoing', planError: null };
        case 'planUndone':
            return { ...state, planState: 'undone', undoResult: action.result };
        case 'planFailed':
            return {
                ...state,
                planState: state.planState === 'undoing' ? 'applied' : 'pending',
                planError: action.error,
            };
        case 'reset':
            return INITIAL_AGENT_RUN_STATE;
        default:
            return state;
    }
}

/** Text sent to a Gemini tab by "Continue in Gemini". */
export function buildContinueInGeminiPrompt(prompt: string, answer: string): string {
    if (!answer.trim()) {
        return prompt;
    }
    return `${prompt}\n\nA local agent on my computer answered this:\n\n${answer.trim()}\n\nPlease continue from here.`;
}
