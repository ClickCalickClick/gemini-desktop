/**
 * Agent results panel under Quick Chat's input: progress and Stop, tool steps,
 * the streamed answer (Markdown, rendered safely), a file plan with Apply, Cancel
 * and Undo, errors with a setup hint, and the follow-up actions.
 *
 * @module AgentPanel
 */

import React, { useMemo } from 'react';

import { renderAgentMarkdown, tildify } from './agentMarkdown';
import { isRunActive, needsSetupHint } from './agentRunState';
import {
    CheckIcon,
    CopyIcon,
    ErrorIcon,
    FolderPlusIcon,
    MoveIcon,
    RenameIcon,
    StopIcon,
    ToolIcon,
    TrashIcon,
} from './Icons';
import { QUICK_CHAT_TEST_IDS } from '../../utils/testIds';
import type { AgentRunState, ToolStep } from './agentRunState';
import type { AgentEngineId, AgentRunStatus, FileAction, FileActionResult } from '../../../shared/types/agent';

const ENGINE_NAMES: Record<AgentEngineId, string> = {
    antigravity: 'Antigravity CLI',
    'gemini-cli': 'Gemini CLI',
};

export const AGENT_SETUP_HINT =
    'Install Antigravity CLI from https://antigravity.google/download, then run agy once in a terminal to sign in.';

const STATUS_MESSAGES: Partial<Record<AgentRunStatus, string>> = {
    CANCELED: 'Stopped.',
    INTERRUPTED: 'The agent was interrupted.',
    TIMEOUT: 'The agent took too long and was stopped.',
    ERROR: 'The agent failed.',
};

const OP_LABELS: Record<FileAction['op'], string> = {
    move: 'Move',
    copy: 'Copy',
    rename: 'Rename',
    mkdir: 'New folder',
    trash: 'Move to trash',
};

function OpIcon({ op }: { op: FileAction['op'] }): React.ReactElement {
    switch (op) {
        case 'copy':
            return <CopyIcon />;
        case 'rename':
            return <RenameIcon />;
        case 'mkdir':
            return <FolderPlusIcon />;
        case 'trash':
            return <TrashIcon />;
        default:
            return <MoveIcon />;
    }
}

function PlanActionRow({ action }: { action: FileAction }): React.ReactElement {
    const from = action.from ? tildify(action.from) : null;
    const to = action.to ? tildify(action.to) : null;
    return (
        <li
            className="qc-plan__action"
            data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PLAN_ACTION}
            data-op={action.op}
        >
            <span className="qc-plan__op" title={OP_LABELS[action.op]} aria-label={OP_LABELS[action.op]}>
                <OpIcon op={action.op} />
            </span>
            <span className="qc-plan__paths">
                {from && <span className="qc-plan__path">{from}</span>}
                {from && to && (
                    <span className="qc-plan__arrow" aria-label="to">
                        →
                    </span>
                )}
                {to && <span className="qc-plan__path">{to}</span>}
            </span>
        </li>
    );
}

function ToolStepRow({ step }: { step: ToolStep }): React.ReactElement {
    const failed = Boolean(step.error);
    const stateLabel = failed ? 'failed' : step.state === 'ACTIVE' ? 'running' : 'done';
    return (
        <li
            className={`qc-tools__step qc-tools__step--${failed ? 'error' : step.state.toLowerCase()}`}
            data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_TOOL_STEP}
            data-state={stateLabel}
            aria-label={`${step.name} ${stateLabel}: ${step.summary}`}
        >
            <span className="qc-tools__icon" aria-hidden="true">
                {failed ? <ErrorIcon /> : step.state === 'ACTIVE' ? <ToolIcon /> : <CheckIcon />}
            </span>
            <span className="qc-tools__name">{step.name}</span>
            <span className="qc-tools__summary" title={step.summary}>
                {step.summary}
            </span>
            {step.error && <span className="qc-tools__error">{step.error}</span>}
        </li>
    );
}

function resultText(result: FileActionResult, verb: string): string {
    if (result.applied === 0 && result.failed.length > 0) {
        // A refusal (for example a path outside the home folder) or every action failing.
        return 'Nothing changed.';
    }
    const count = `${result.applied} change${result.applied === 1 ? '' : 's'}`;
    const failures = result.failed.length > 0 ? `, ${result.failed.length} failed` : '';
    return `${verb} ${count}${failures}.`;
}

function FailureList({ result }: { result: FileActionResult | null }): React.ReactElement | null {
    if (!result || result.failed.length === 0) {
        return null;
    }
    return (
        <ul className="qc-plan__failures">
            {result.failed.map((failure, index) => (
                <li key={`${failure.id}-${index}`}>{failure.error}</li>
            ))}
        </ul>
    );
}

export interface AgentPanelProps {
    state: AgentRunState;
    onStop: () => void;
    onApplyPlan: () => void;
    onCancelPlan: () => void;
    onUndoPlan: () => void;
    onNew: () => void;
    onContinueInGemini: () => void;
}

export function AgentPanel({
    state,
    onStop,
    onApplyPlan,
    onCancelPlan,
    onUndoPlan,
    onNew,
    onContinueInGemini,
}: AgentPanelProps): React.ReactElement {
    const active = isRunActive(state);
    const html = useMemo(() => renderAgentMarkdown(state.text), [state.text]);
    const engineName = state.engine ? ENGINE_NAMES[state.engine] : 'the agent';
    const statusMessage =
        state.phase === 'done' && state.status && state.status !== 'SUCCESS'
            ? (state.error ?? STATUS_MESSAGES[state.status] ?? 'The agent failed.')
            : null;
    const showHint = state.phase === 'done' && needsSetupHint(state.error);
    // One short announcement per state change for screen readers, instead of a live region on the streaming text.
    const announcement = active
        ? state.phase === 'stopping'
            ? 'Stopping the agent'
            : 'The agent is working'
        : state.phase === 'done'
          ? (statusMessage ?? (state.plan ? 'File plan ready' : 'Answer ready'))
          : '';
    const planBusy = state.planState === 'applying' || state.planState === 'undoing';

    return (
        <div
            className="qc-agent-panel"
            data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PANEL}
            role="region"
            aria-label="Agent answer"
        >
            {active && (
                <div className="qc-agent-progress" data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PROGRESS}>
                    <span className="qc-agent-progress__bar" aria-hidden="true" />
                    <span className="qc-agent-progress__label">
                        {state.phase === 'stopping' ? 'Stopping…' : `Working with ${engineName}…`}
                    </span>
                    <button
                        type="button"
                        className="qc-button qc-button--quiet"
                        onClick={onStop}
                        disabled={state.phase === 'stopping'}
                        aria-label="Stop the agent (Escape)"
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_STOP}
                    >
                        <StopIcon />
                        <span>Stop</span>
                    </button>
                </div>
            )}

            <p
                className="qc-visually-hidden"
                role="status"
                data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_ANNOUNCER}
            >
                {announcement}
            </p>

            <div className="qc-agent-body">
                {state.tools.length > 0 && (
                    <ul
                        className="qc-tools"
                        aria-label="Agent steps"
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_TOOLS}
                    >
                        {state.tools.map((step) => (
                            <ToolStepRow key={step.key} step={step} />
                        ))}
                    </ul>
                )}

                {state.text && (
                    <div
                        className="qc-agent-output qc-markdown"
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_OUTPUT}
                        // Safe: renderAgentMarkdown escapes raw HTML and drops links and images.
                        dangerouslySetInnerHTML={{ __html: html }}
                    />
                )}

                {state.plan && (
                    <div className="qc-plan" data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PLAN}>
                        <p className="qc-plan__summary">{state.plan.summary}</p>
                        <ul className="qc-plan__actions" aria-label="Proposed file changes">
                            {state.plan.actions.map((action) => (
                                <PlanActionRow key={action.id} action={action} />
                            ))}
                        </ul>

                        {(state.planState === 'pending' || state.planState === 'applying') && (
                            <div className="qc-plan__buttons">
                                <button
                                    type="button"
                                    className="qc-button qc-button--primary"
                                    onClick={onApplyPlan}
                                    disabled={state.phase !== 'done' || planBusy || state.plan.actions.length === 0}
                                    aria-label={`Apply ${state.plan.actions.length} file changes`}
                                    data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PLAN_APPLY}
                                >
                                    {state.planState === 'applying' ? 'Applying…' : 'Apply'}
                                </button>
                                <button
                                    type="button"
                                    className="qc-button"
                                    onClick={onCancelPlan}
                                    disabled={planBusy}
                                    aria-label="Cancel the plan without changing anything"
                                    data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PLAN_CANCEL}
                                >
                                    Cancel
                                </button>
                            </div>
                        )}

                        {state.planState === 'cancelled' && (
                            <p
                                className="qc-plan__result"
                                data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PLAN_RESULT}
                            >
                                Plan cancelled. Nothing changed.
                            </p>
                        )}

                        {(state.planState === 'applied' || state.planState === 'undoing') && state.planResult && (
                            <div
                                className="qc-plan__result"
                                data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PLAN_RESULT}
                            >
                                <p>{resultText(state.planResult, 'Applied')}</p>
                                <FailureList result={state.planResult} />
                                {state.planResult.undoAvailable && (
                                    <button
                                        type="button"
                                        className="qc-button"
                                        onClick={onUndoPlan}
                                        disabled={planBusy}
                                        aria-label="Undo the applied file changes"
                                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PLAN_UNDO}
                                    >
                                        {state.planState === 'undoing' ? 'Undoing…' : 'Undo'}
                                    </button>
                                )}
                            </div>
                        )}

                        {state.planState === 'undone' && state.undoResult && (
                            <div
                                className="qc-plan__result"
                                data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_PLAN_RESULT}
                            >
                                <p>{resultText(state.undoResult, 'Undid')}</p>
                                <FailureList result={state.undoResult} />
                            </div>
                        )}

                        {state.planError && (
                            <p className="qc-agent-error" role="alert">
                                {state.planError}
                            </p>
                        )}
                    </div>
                )}

                {statusMessage && (
                    <p
                        className={`qc-agent-error${state.status === 'CANCELED' ? ' qc-agent-error--quiet' : ''}`}
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_ERROR}
                    >
                        {statusMessage}
                    </p>
                )}

                {showHint && (
                    <p className="qc-agent-hint" data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_SETUP_HINT}>
                        {AGENT_SETUP_HINT}
                    </p>
                )}
            </div>

            {state.phase === 'done' && (
                <div className="qc-agent-footer">
                    <span className="qc-agent-footer__hint">
                        {state.conversationId ? 'Type a follow-up question above.' : ''}
                    </span>
                    <button
                        type="button"
                        className="qc-button qc-button--quiet"
                        onClick={onContinueInGemini}
                        aria-label="Continue this conversation in a Gemini tab"
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_CONTINUE_WEB}
                    >
                        Continue in Gemini
                    </button>
                    <button
                        type="button"
                        className="qc-button qc-button--quiet"
                        onClick={onNew}
                        aria-label="Start a new agent conversation"
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_NEW}
                    >
                        New
                    </button>
                </div>
            )}
        </div>
    );
}

export default AgentPanel;
