/**
 * Agent results panel under Quick Chat's input: progress and Stop, tool steps,
 * the streamed answer (Markdown, rendered safely), a file plan with Apply, Cancel
 * and Undo, the approval card for commands the CLI blocked, errors with a setup
 * hint, and the follow-up actions.
 *
 * @module AgentPanel
 */

import React, { useId, useMemo } from 'react';

import { renderAgentMarkdown, tildify } from './agentMarkdown';
import { isEmptyAnswer, isRunActive, needsSetupHint } from './agentRunState';
import {
    CheckIcon,
    CopyIcon,
    ErrorIcon,
    FolderPlusIcon,
    LockIcon,
    MoveIcon,
    RenameIcon,
    StopIcon,
    ToolIcon,
    TrashIcon,
} from './Icons';
import { QUICK_CHAT_TEST_IDS } from '../../utils/testIds';
import type { AgentRunState, ToolStep } from './agentRunState';
import type {
    AgentEngineId,
    AgentRunStatus,
    BlockedCommand,
    CommandApprovalDecision,
    FileAction,
    FileActionResult,
} from '../../../shared/types/agent';

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

function ToolStepRow({ step, openOutput }: { step: ToolStep; openOutput: boolean }): React.ReactElement {
    const failed = Boolean(step.error);
    const blocked = !failed && Boolean(step.blocked);
    const stateLabel = failed ? 'failed' : blocked ? 'blocked' : step.state === 'ACTIVE' ? 'running' : 'done';
    const modifier = failed ? 'error' : blocked ? 'blocked' : step.state.toLowerCase();
    return (
        <li
            className={`qc-tools__step qc-tools__step--${modifier}`}
            data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_TOOL_STEP}
            data-state={stateLabel}
            aria-label={`${step.name} ${stateLabel}: ${step.summary}`}
        >
            <span className="qc-tools__icon" aria-hidden="true">
                {failed ? (
                    <ErrorIcon />
                ) : blocked ? (
                    <LockIcon />
                ) : step.state === 'ACTIVE' ? (
                    <ToolIcon />
                ) : (
                    <CheckIcon />
                )}
            </span>
            <span className="qc-tools__name">{step.name}</span>
            <span className="qc-tools__summary" title={step.summary}>
                {step.summary}
            </span>
            {step.error && <span className="qc-tools__error">{step.error}</span>}
            {blocked && <span className="qc-tools__blocked">Blocked</span>}
            {step.output && (
                <details
                    className="qc-tools__output"
                    open={openOutput}
                    data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_TOOL_OUTPUT}
                >
                    <summary>Output</summary>
                    <pre>{step.output}</pre>
                </details>
            )}
        </li>
    );
}

/** The prefixes of the lasting rules "Always allow" would add, or null when a command can only be allowed for this answer. */
function lastingPrefixes(blocked: BlockedCommand[]): { rules: string[]; prefixes: string[] } | null {
    const rules: string[] = [];
    for (const entry of blocked) {
        if (!entry.lastingRule) {
            return null;
        }
        if (!rules.includes(entry.lastingRule)) {
            rules.push(entry.lastingRule);
        }
    }
    return { rules, prefixes: rules.map((rule) => rule.replace(/^command\((.*)\)$/s, '$1')) };
}

/** A command line with control and invisible formatting characters made visible as `\u{…}`. */
function visibleCommand(command: string): string {
    return command.replace(
        /[\p{Cc}\p{Cf}]/gu,
        (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`
    );
}

interface ApprovalCardProps {
    blocked: BlockedCommand[];
    answered: boolean;
    busy: boolean;
    error: string | null;
    /** Why the commands cannot be allowed; only "Answer without it" is offered then. */
    unavailable: string | null;
    onDecide: (decision: CommandApprovalDecision) => void;
    onDismiss: () => void;
}

/**
 * "The agent needs to run:" with Allow for this answer, Always allow (lookup commands
 * only), Answer without it, and a close button (Escape) that dismisses the card.
 */
function ApprovalCard({
    blocked,
    answered,
    busy,
    error,
    unavailable,
    onDecide,
    onDismiss,
}: ApprovalCardProps): React.ReactElement {
    const titleId = useId();
    const alwaysDescriptionId = useId();
    const lasting = unavailable ? null : lastingPrefixes(blocked);
    const one = blocked.length === 1;
    const alwaysDescription = lasting
        ? `Adds ${lasting.rules.join(' and ')} to Antigravity CLI's settings, so the agent can run ${
              lasting.prefixes.length === 1 ? 'this command' : 'these commands'
          }, with any arguments, without asking. Remove it in Options → Quick Chat.`
        : '';
    return (
        <div
            className="qc-approval"
            role="group"
            aria-labelledby={titleId}
            data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_APPROVAL}
        >
            <div className="qc-approval__header">
                <p className="qc-approval__title" id={titleId}>
                    {answered ? 'The agent was not allowed to run:' : 'The agent needs to run:'}
                </p>
                <button
                    type="button"
                    className="qc-button qc-button--quiet qc-approval__close"
                    onClick={onDismiss}
                    disabled={busy}
                    title="Dismiss (Esc)"
                    aria-label="Dismiss without answering (Escape)"
                    data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_APPROVE_DISMISS}
                >
                    ×
                </button>
            </div>
            <ul className="qc-approval__commands" aria-label={one ? 'Blocked command' : 'Blocked commands'}>
                {blocked.map((entry) => (
                    <li key={entry.command}>
                        <code className="qc-approval__command">{visibleCommand(entry.command)}</code>
                        {entry.caution && (
                            <p
                                className="qc-approval__caution"
                                data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_APPROVE_CAUTION}
                            >
                                Careful: this command can change or delete things.
                            </p>
                        )}
                    </li>
                ))}
            </ul>
            <p className="qc-approval__note">
                {unavailable ??
                    `Allow for this answer: the agent may run ${one ? 'this command' : 'these commands'}, also with extra arguments, until it finishes this answer. ${
                        one ? 'It runs' : 'They run'
                    } inside the agent's sandbox.`}
            </p>
            <div className="qc-approval__buttons">
                {!unavailable && (
                    <button
                        type="button"
                        className="qc-button qc-button--primary"
                        onClick={() => onDecide('once')}
                        disabled={busy}
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_APPROVE_ONCE}
                    >
                        {busy ? 'Working…' : 'Allow for this answer'}
                    </button>
                )}
                {lasting && (
                    <button
                        type="button"
                        className="qc-button"
                        onClick={() => onDecide('always')}
                        disabled={busy}
                        title={alwaysDescription}
                        aria-describedby={alwaysDescriptionId}
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_APPROVE_ALWAYS}
                    >
                        <span>Always allow</span>{' '}
                        <code className="qc-approval__prefix">{lasting.prefixes.join(', ')}</code>
                    </button>
                )}
                <button
                    type="button"
                    className={`qc-button${unavailable ? ' qc-button--primary' : ' qc-button--quiet'}`}
                    onClick={() => onDecide('without')}
                    disabled={busy}
                    data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_APPROVE_WITHOUT}
                >
                    {one ? 'Answer without it' : 'Answer without them'}
                </button>
            </div>
            {lasting && (
                <span className="qc-visually-hidden" id={alwaysDescriptionId}>
                    {alwaysDescription}
                </span>
            )}
            {error && (
                <p className="qc-agent-error" role="alert">
                    {error}
                </p>
            )}
        </div>
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
    onDecideCommands: (decision: CommandApprovalDecision) => void;
    onDismissCommands: () => void;
}

/** What the panel says about a run that ended without an answer, or null. */
function emptyAnswerMessage(state: AgentRunState): string | null {
    if (state.approval === 'pending' || state.approval === 'approving') {
        return null;
    }
    if (state.approval === 'dismissed') {
        return 'The agent could not finish without running these commands.';
    }
    if (state.resume === 'declined' && state.phase === 'done' && (isEmptyAnswer(state) || state.blocked.length > 0)) {
        return 'The agent could not answer without running commands.';
    }
    if (!isEmptyAnswer(state)) {
        return null;
    }
    if (state.blocked.length > 0) {
        return 'The agent could not finish because the commands it needed were blocked.';
    }
    return state.deniedActions.length > 0
        ? `The agent gave no answer. The CLI refused something it needed (${state.deniedActions.join(', ')}).`
        : 'The agent gave no answer.';
}

export function AgentPanel({
    state,
    onStop,
    onApplyPlan,
    onCancelPlan,
    onUndoPlan,
    onNew,
    onContinueInGemini,
    onDecideCommands,
    onDismissCommands,
}: AgentPanelProps): React.ReactElement {
    const active = isRunActive(state);
    const html = useMemo(() => renderAgentMarkdown(state.text), [state.text]);
    const engineName = state.engine ? ENGINE_NAMES[state.engine] : 'the agent';
    const statusMessage =
        state.phase === 'done' && state.status && state.status !== 'SUCCESS'
            ? (state.error ?? STATUS_MESSAGES[state.status] ?? 'The agent failed.')
            : null;
    const showHint = state.phase === 'done' && needsSetupHint(state.error);
    const showApproval =
        state.phase === 'done' && state.canResume && (state.approval === 'pending' || state.approval === 'approving');
    const emptyMessage = state.phase === 'done' && !statusMessage ? emptyAnswerMessage(state) : null;
    // One short announcement per state change for screen readers, instead of a live region on the streaming text.
    const announcement = active
        ? state.phase === 'stopping'
            ? 'Stopping the agent'
            : 'The agent is working'
        : state.phase === 'done'
          ? (statusMessage ??
            (showApproval
                ? 'The agent needs your approval to run a command'
                : (emptyMessage ?? (state.plan ? 'File plan ready' : 'Answer ready'))))
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
                            // Without an answer, what the commands printed is all there is to read.
                            <ToolStepRow
                                key={step.key}
                                step={step}
                                openOutput={state.phase === 'done' && !state.text.trim()}
                            />
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

                {showApproval && (
                    <ApprovalCard
                        blocked={state.blocked}
                        answered={Boolean(state.text.trim())}
                        busy={state.approval === 'approving'}
                        error={state.approvalError}
                        unavailable={state.approvalUnavailable}
                        onDecide={onDecideCommands}
                        onDismiss={onDismissCommands}
                    />
                )}

                {emptyMessage && (
                    <p
                        className="qc-agent-error qc-agent-error--quiet"
                        data-testid={QUICK_CHAT_TEST_IDS.QUICK_CHAT_AGENT_EMPTY}
                    >
                        {emptyMessage}
                    </p>
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
