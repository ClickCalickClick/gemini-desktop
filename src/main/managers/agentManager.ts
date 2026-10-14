/**
 * Agent Manager: runs a local agent CLI (Antigravity CLI `agy`, or Gemini CLI `gemini`)
 * headless for Quick Chat, streams its progress as AgentRunEvents, and applies the file
 * plans the user confirms.
 *
 * Safety model (see src/main/AGENTS.md, "Agent engine"):
 * - The CLI is started unmodified, without a shell, with an app-owned scratch workspace
 *   as its working directory. Its default permissions only allow file writes inside the
 *   workspace and soft-deny everything that would ask (shell commands, other paths).
 * - The app never passes `--dangerously-skip-permissions` or a permissive approval mode,
 *   and does not run Antigravity CLI when the user's global settings allow more.
 * - Changes to the user's files are only made by the app, from a plan the user applied.
 * - The app writes only specific `command(...)` allow rules to Antigravity CLI's settings,
 *   only after the user approved a blocked command or turned on the lookup command list,
 *   records why it wants each rule and never removes the user's own (see agent/agentPermissions).
 *
 * Never log prompts or answers: only ids, lengths and statuses.
 *
 * @module AgentManager
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { app, shell } from 'electron';

import {
    AgentPermissionsError,
    hasInvisibleCharacters,
    lastingRuleFor,
    needsCaution,
    PermissionTracker,
    readAllowRules,
    refuseAllowRule,
    updateAllowRules,
    wantedRules,
    type PermissionRecord,
} from '../agent/agentPermissions';
import { discoverEngine, ENGINE_NAMES, getSearchDirectories, readBinaryVersion } from '../agent/engineDiscovery';
import {
    applyPlan,
    filterUnsafeActions,
    FILE_PLAN_JSON_SCHEMA,
    isUndoable,
    normalizePlan,
    undoPlan,
    type FileOperations,
    type PathPolicy,
    type UndoEntry,
} from '../agent/filePlan';
import { parseModelLines } from '../agent/models';
import { buildAgentPrompt, gatherContext, type WellKnownFolder } from '../agent/promptContext';
import { createEventParser, LineSplitter, parseJsonLine, type ParsedAgentEvent } from '../agent/streamParsers';
import {
    describeRiskySettings,
    findRiskySettings,
    prepareWorkspace,
    removeRunInputs,
    settingsFilesFor,
} from '../agent/workspace';
import { createLogger } from '../utils/logger';
import { commandRule, LOOKUP_COMMAND_RULES } from '../../shared/constants/agentLookupCommands';
import type {
    AgentEngineId,
    AgentEnginePreference,
    AgentEngineStatus,
    AgentModelList,
    AgentPermissionsInfo,
    AgentRunEvent,
    AgentRunRequest,
    AgentRunStatus,
    AgentTaskCategory,
    BlockedCommand,
    CommandApprovalDecision,
    FileActionPlan,
    FileActionResult,
} from '../../shared/types/agent';
import type { Logger } from '../types';

export const AGENT_TASK_CATEGORIES: readonly AgentTaskCategory[] = ['files', 'system', 'documents', 'code', 'general'];
export const MAX_PROMPT_LENGTH = 20_000;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** The CLI's own limit per run (`--print-timeout`). */
export const CLI_PRINT_TIMEOUT = '5m';
/** The app's limit per run, a little longer than the CLI's. */
export const DEFAULT_RUN_TIMEOUT_MS = 6 * 60 * 1000;
export const DEFAULT_CANCEL_GRACE_MS = 3000;
export const DEFAULT_STATUS_TTL_MS = 30_000;
/** How long a CLI may keep running after it reported its result. */
const AFTER_RESULT_GRACE_MS = 5000;
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_RESPONSE_CHARS = 1024 * 1024;
const MAX_STORED_PLANS = 10;
/** Runs whose blocked commands can still be approved. */
const MAX_STORED_BLOCKED_RUNS = 10;
/** Most blocked commands one approval covers. */
const MAX_BLOCKED_COMMANDS = 10;
/** How long `agy models` and `agy -p /model` may take. */
export const MODEL_LIST_TIMEOUT_MS = 20_000;
/** How long a model list is kept. */
export const MODEL_LIST_TTL_MS = 5 * 60 * 1000;
/** How long a failed listing is kept before the CLI is asked again. */
export const MODEL_LIST_FAILURE_TTL_MS = 60 * 1000;
const MAX_MODEL_OUTPUT_CHARS = 256 * 1024;

/**
 * Pass `--sandbox` to Antigravity CLI: terminal commands, if the user's settings allow any,
 * run in the OS sandbox (workspace, temporary folders and build caches writable, home folders
 * not visible, no network).
 */
const ANTIGRAVITY_SANDBOX = true;

/** Antigravity permission modes (from the `init` event) that ask before running tools. */
const SAFE_PERMISSION_MODES = ['request-review', 'strict'];

/** Options for a run that come from the user's settings. */
export interface AgentRunOptions {
    enginePreference: AgentEnginePreference;
    model: string;
    /** Receives the run's events. */
    emit: (event: AgentRunEvent) => void;
}

export interface AgentManagerOptions {
    logger?: Logger;
    homeDir?: () => string;
    userDataDir?: () => string;
    /** Scratch workspace; defaults to `<userData>/agent-workspace`. */
    workspaceDir?: () => string;
    getFolder?: (name: WellKnownFolder) => string | null;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    /** Replaces the usual install folders searched besides PATH (tests). */
    extraSearchDirectories?: string[];
    spawnProcess?: typeof spawn;
    readVersion?: (binaryPath: string) => Promise<string | undefined>;
    /** Settings files to check for an engine (tests); defaults to the CLI's own files. */
    settingsFiles?: (engine: AgentEngineId) => string[];
    trashItem?: (target: string) => Promise<void>;
    /** Antigravity CLI's global settings file, where the app writes command allow rules. */
    antigravitySettingsFile?: () => string;
    /** The app's record of the allow rules it added; defaults to `<userData>/agent-permissions.json`. */
    permissionRecordFile?: () => string;
    modelListTimeoutMs?: number;
    runTimeoutMs?: number;
    cancelGraceMs?: number;
    statusTtlMs?: number;
    now?: () => number;
}

interface ActiveRun {
    runId: string;
    engine: AgentEngineId;
    category: AgentTaskCategory;
    child: ChildProcess | null;
    emit: (event: AgentRunEvent) => void;
    finished: boolean;
    resultSeen: boolean;
    conversationId?: string;
    text: string;
    stderr: string;
    warnings: string[];
    timers: ReturnType<typeof setTimeout>[];
    /**
     * Terminal command steps in the order they started, to find the ones headless mode
     * refused. A step that never reported DONE counts as without output.
     */
    commandSteps: {
        tool: string;
        command: string;
        summary: string;
        stepIndex?: number;
        done: boolean;
        withoutOutput: boolean;
    }[];
    /** Rules for this answer that this run asked for; removed when it ends. */
    temporaryRules: string[];
    /** Set for a run that resumes a conversation after the user decided about blocked commands. */
    resume?: ResumeKind;
}

/** How a run resumes after blocked commands: allowed, or answering without them. */
type ResumeKind = 'approved' | 'declined';

interface RunExtras {
    temporaryRules?: string[];
    resume?: ResumeKind;
}

/** A finished run whose blocked commands the user can still approve. */
interface BlockedRun {
    conversationId: string;
    category: AgentTaskCategory;
    commands: BlockedCommand[];
    /** Set when the commands cannot be allowed; answering without them still works. */
    approvalUnavailable?: string;
}

interface CachedModels {
    binaryPath: string;
    list: AgentModelList;
    checkedAt: number;
    /** How long this entry is kept: 5 minutes for a list, 1 minute for a failure. */
    ttlMs: number;
}

interface StoredPlan {
    plan: FileActionPlan;
    applied: boolean;
}

interface CachedStatus {
    preference: AgentEnginePreference;
    status: AgentEngineStatus;
    checkedAt: number;
}

/** Validate a run request from the renderer. Throws with a message fit for the UI. */
export function validateRunRequest(request: unknown): AgentRunRequest {
    if (typeof request !== 'object' || request === null) {
        throw new Error('Invalid agent request.');
    }
    const candidate = request as Record<string, unknown>;
    const { prompt, category, conversationId } = candidate;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new Error('The prompt is empty.');
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new Error(`The prompt is longer than ${MAX_PROMPT_LENGTH} characters.`);
    }
    if (typeof category !== 'string' || !AGENT_TASK_CATEGORIES.includes(category as AgentTaskCategory)) {
        throw new Error('Invalid agent task category.');
    }
    if (conversationId !== undefined && conversationId !== null && conversationId !== '') {
        if (typeof conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(conversationId)) {
            throw new Error('Invalid conversation id.');
        }
        return { prompt, category: category as AgentTaskCategory, conversationId };
    }
    return { prompt, category: category as AgentTaskCategory };
}

/** What a run's `done` event reports. */
interface DoneDetails {
    status: AgentRunStatus;
    response: string;
    error?: string;
    blocked?: BlockedCommand[];
    deniedActions?: string[];
    canResume?: boolean;
    approvalUnavailable?: string;
}

/** A settings problem's message for the UI; never the raw text of other errors. */
function permissionErrorMessage(error: unknown): string {
    return error instanceof AgentPermissionsError ? error.message : "Could not change Antigravity CLI's settings file.";
}

function union(list: string[], more: string[]): string[] {
    return [...new Set([...list, ...more])];
}

const AUTH_PATTERN =
    /authentication required|not (?:signed|logged) in|sign[- ]?in required|login required|unauthenticated/i;
const API_KEY_PATTERN = /GEMINI_API_KEY|api key/i;

/** Turn a CLI failure into a message for the user. */
export function describeFailure(
    engine: AgentEngineId,
    stderr: string,
    error: string | undefined,
    exitCode: number | null
): string {
    const combined = `${error ?? ''}\n${stderr}`;
    if (engine === 'antigravity' && AUTH_PATTERN.test(combined)) {
        return 'Antigravity CLI is not signed in. Open a terminal, run `agy` once and sign in with your Google account, then try again.';
    }
    if (engine === 'gemini-cli' && (AUTH_PATTERN.test(combined) || API_KEY_PATTERN.test(combined))) {
        return 'Gemini CLI needs an API key. Set GEMINI_API_KEY for your session (or run `gemini` once in a terminal to set up), then restart the app.';
    }
    if (error && error.trim()) {
        return error.trim().slice(0, 500);
    }
    const lastLines = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-3)
        .join(' ');
    if (lastLines) {
        return lastLines.slice(0, 500);
    }
    return exitCode === null
        ? `${ENGINE_NAMES[engine]} stopped unexpectedly.`
        : `${ENGINE_NAMES[engine]} exited with code ${exitCode}.`;
}

export default class AgentManager {
    private readonly logger: Logger;
    private readonly homeDir: () => string;
    private readonly userDataDir: () => string;
    private readonly workspaceDir: () => string;
    private readonly getFolder: (name: WellKnownFolder) => string | null;
    private readonly env: NodeJS.ProcessEnv;
    private readonly platform: NodeJS.Platform;
    private readonly extraSearchDirectories?: string[];
    private readonly spawnProcess: typeof spawn;
    private readonly readVersion?: (binaryPath: string) => Promise<string | undefined>;
    private readonly settingsFiles?: (engine: AgentEngineId) => string[];
    private readonly fileOps: FileOperations;
    private readonly antigravitySettingsFile: () => string;
    private readonly permissions: PermissionTracker;
    private readonly modelListTimeoutMs: number;
    private readonly runTimeoutMs: number;
    private readonly cancelGraceMs: number;
    private readonly statusTtlMs: number;
    private readonly now: () => number;

    private statusCache: CachedStatus | null = null;
    private activeRun: ActiveRun | null = null;
    private readonly plans = new Map<string, StoredPlan>();
    private readonly blockedRuns = new Map<string, BlockedRun>();
    private modelCache: CachedModels | null = null;
    private undoLog: UndoEntry[] = [];
    private fileWorkBusy = false;
    private disposed = false;

    constructor(options: AgentManagerOptions = {}) {
        this.logger = options.logger ?? createLogger('[AgentManager]');
        this.homeDir = options.homeDir ?? (() => os.homedir());
        this.userDataDir = options.userDataDir ?? (() => app.getPath('userData'));
        this.workspaceDir = options.workspaceDir ?? (() => path.join(this.userDataDir(), 'agent-workspace'));
        this.getFolder =
            options.getFolder ??
            ((name) => {
                try {
                    return app.getPath(name);
                } catch {
                    return null;
                }
            });
        this.env = options.env ?? process.env;
        this.platform = options.platform ?? process.platform;
        this.extraSearchDirectories = options.extraSearchDirectories;
        this.spawnProcess = options.spawnProcess ?? spawn;
        this.readVersion = options.readVersion;
        this.settingsFiles = options.settingsFiles;
        this.fileOps = { trashItem: options.trashItem ?? ((target) => shell.trashItem(target)) };
        this.antigravitySettingsFile =
            options.antigravitySettingsFile ??
            (() => settingsFilesFor('antigravity', this.homeDir(), this.platform)[0] ?? '');
        const permissionRecordFile =
            options.permissionRecordFile ?? (() => path.join(this.userDataDir(), 'agent-permissions.json'));
        this.permissions = new PermissionTracker(permissionRecordFile);
        this.modelListTimeoutMs = options.modelListTimeoutMs ?? MODEL_LIST_TIMEOUT_MS;
        this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
        this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
        this.statusTtlMs = options.statusTtlMs ?? DEFAULT_STATUS_TTL_MS;
        this.now = options.now ?? (() => Date.now());
    }

    // =========================================================================
    // Engine status
    // =========================================================================

    /** Which engine will be used. Cached for ~30 s; `force` checks again. */
    async getStatus(preference: AgentEnginePreference, force = false): Promise<AgentEngineStatus> {
        const cached = this.statusCache;
        if (!force && cached && cached.preference === preference && this.now() - cached.checkedAt < this.statusTtlMs) {
            return cached.status;
        }
        const status = await this.discover(preference);
        this.statusCache = { preference, status, checkedAt: this.now() };
        this.logger.log('Agent engine status:', {
            preference,
            engine: status.engine,
            available: status.available,
        });
        return status;
    }

    /** Forget the cached status (after settings change or a failed start). */
    invalidateStatus(): void {
        this.statusCache = null;
    }

    private async discover(preference: AgentEnginePreference): Promise<AgentEngineStatus> {
        const homeDir = this.homeDir();
        const base = {
            env: this.env,
            homeDir,
            platform: this.platform,
            extraDirectories: this.extraSearchDirectories,
            readVersion: this.readVersion ?? ((binaryPath: string) => readBinaryVersion(binaryPath, this.childEnv())),
            checkEngine: (engine: AgentEngineId) => this.checkEngineSettings(engine),
        };
        return discoverEngine(preference, base);
    }

    /** Why an engine's settings rule it out, or null when they keep the CLI's defaults. */
    private async checkEngineSettings(engine: AgentEngineId): Promise<string | null> {
        const files = this.settingsFiles?.(engine) ?? settingsFilesFor(engine, this.homeDir(), this.platform);
        const risky = await findRiskySettings(engine, files);
        return risky.length > 0 ? describeRiskySettings(engine, risky) : null;
    }

    // =========================================================================
    // Runs
    // =========================================================================

    /** Start a run. Resolves with its id at once; progress arrives through `emit`. */
    async run(request: unknown, options: AgentRunOptions): Promise<{ runId: string }> {
        return this.startNewRun(validateRunRequest(request), options, {});
    }

    /**
     * Start a run. A resumed run (after the user decided about blocked commands) gathers no
     * context and copies no files: the conversation already has them, and the commands in
     * its prompt must not make the app hand their files to the agent. `temporaryRules` are
     * rules for this answer, written to Antigravity's settings right before the CLI starts
     * and removed when the run ends, however it ends.
     */
    private startNewRun(valid: AgentRunRequest, options: AgentRunOptions, extras: RunExtras): { runId: string } {
        const temporaryRules = extras.temporaryRules ?? [];
        if (this.disposed) {
            throw new Error('The app is quitting.');
        }

        // Only one run at a time: a new run cancels the previous one.
        if (this.activeRun && !this.activeRun.finished) {
            this.cancel(this.activeRun.runId);
        }

        const runId = randomUUID();
        const run: ActiveRun = {
            runId,
            engine: 'antigravity',
            category: valid.category,
            child: null,
            emit: options.emit,
            finished: false,
            resultSeen: false,
            text: '',
            stderr: '',
            warnings: [],
            timers: [],
            commandSteps: [],
            temporaryRules: [],
            resume: extras.resume,
        };
        this.activeRun = run;

        // Events are sent after the runId has been returned to the renderer.
        setTimeout(() => {
            void this.startRun(run, valid, options, temporaryRules).catch((error: unknown) => {
                this.logger.error('Agent run failed to start:', { runId, error: (error as Error)?.message });
                this.finish(run, { status: 'ERROR', response: '', error: 'The agent could not be started.' });
            });
        }, 0);

        return { runId };
    }

    private async startRun(
        run: ActiveRun,
        request: AgentRunRequest,
        options: AgentRunOptions,
        temporaryRules: string[]
    ): Promise<void> {
        if (run.finished) {
            return;
        }
        const status = await this.getStatus(options.enginePreference);
        if (run.finished) {
            return;
        }
        if (!status.available || !status.engine || !status.path) {
            this.finish(run, { status: 'ERROR', response: '', error: status.error ?? 'No agent CLI is available.' });
            return;
        }
        run.engine = status.engine;

        // The status may be cached; check the settings again right before running.
        const refusal = await this.checkEngineSettings(status.engine);
        if (refusal) {
            this.invalidateStatus();
            this.finish(run, { status: 'ERROR', response: '', error: refusal });
            return;
        }
        if (run.finished) {
            return;
        }

        const homeDir = this.homeDir();
        const workspaceDir = this.workspaceDir();
        await prepareWorkspace(workspaceDir);
        if (run.finished) {
            return;
        }

        const inputsRelativeDir = `inputs/${run.runId}`;
        const context = run.resume
            ? { text: '', locations: 0, copiedFiles: 0 }
            : await gatherContext(request.prompt, {
                  homeDir,
                  userDataDir: this.userDataDir(),
                  platform: this.platform,
                  getFolder: this.getFolder,
                  inputsDir: path.join(workspaceDir, 'inputs', run.runId),
                  inputsRelativeDir,
                  category: request.category,
              });
        if (run.finished) {
            return;
        }

        const prompt = buildAgentPrompt({
            prompt: request.prompt,
            category: request.category,
            engine: status.engine,
            context: context.text,
            homeDir,
        });
        const args = this.buildArgs(status.engine, prompt, request, options.model);

        if (temporaryRules.length > 0) {
            if (status.engine !== 'antigravity') {
                this.finish(run, {
                    status: 'ERROR',
                    response: '',
                    error: 'Only Antigravity CLI can run approved commands.',
                });
                return;
            }
            try {
                this.addTemporaryRules(run, temporaryRules);
            } catch (error) {
                this.finish(run, { status: 'ERROR', response: '', error: permissionErrorMessage(error) });
                return;
            }
        }

        this.logger.log('Starting agent run:', {
            runId: run.runId,
            engine: status.engine,
            category: request.category,
            promptLength: request.prompt.length,
            contextLocations: context.locations,
            copiedFiles: context.copiedFiles,
            followUp: Boolean(request.conversationId),
            resume: run.resume ?? null,
            temporaryRules: run.temporaryRules.length,
        });

        let child: ChildProcess;
        try {
            child = this.spawnProcess(status.path, args, {
                cwd: workspaceDir,
                env: this.childEnv(path.dirname(status.path)),
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
                windowsHide: true,
            });
        } catch (error) {
            this.invalidateStatus();
            this.finish(run, {
                status: 'ERROR',
                response: '',
                error: `Could not start ${ENGINE_NAMES[status.engine]}: ${(error as Error).message}`,
            });
            return;
        }
        run.child = child;
        run.emit({ type: 'started', runId: run.runId, engine: status.engine });

        run.timers.push(
            setTimeout(() => {
                if (!run.finished) {
                    this.logger.warn('Agent run timed out:', { runId: run.runId });
                    this.finish(run, {
                        status: 'TIMEOUT',
                        response: run.text,
                        error: 'The agent took too long and was stopped.',
                    });
                    this.stopChild(child);
                }
            }, this.runTimeoutMs)
        );

        const parse = createEventParser(status.engine);
        const splitter = new LineSplitter((line) => {
            const json = parseJsonLine(line);
            if (!json) {
                return;
            }
            for (const event of parse(json)) {
                this.handleParsedEvent(run, event);
            }
        });

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => splitter.push(chunk));
        child.stdout?.on('end', () => splitter.flush());
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            if (run.stderr.length < MAX_STDERR_CHARS) {
                run.stderr = (run.stderr + chunk).slice(0, MAX_STDERR_CHARS);
            }
        });

        child.on('error', (error: NodeJS.ErrnoException) => {
            this.logger.error('Agent process error:', { runId: run.runId, code: error.code });
            this.invalidateStatus();
            this.finish(run, {
                status: 'ERROR',
                response: run.text,
                error: `Could not run ${ENGINE_NAMES[run.engine]}: ${error.message}`,
            });
        });

        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
            splitter.flush();
            this.logger.log('Agent process exited:', {
                runId: run.runId,
                code,
                signal,
                stderrLength: run.stderr.length,
            });
            if (run.child === child) {
                run.child = null;
            }
            if (run.finished) {
                return;
            }
            if (code === 0 && !run.resultSeen && run.text.length > 0) {
                // No result event, but the agent answered.
                this.completeRun(run, { kind: 'result', status: 'SUCCESS', response: run.text });
                return;
            }
            this.finish(run, {
                status: 'ERROR',
                response: run.text,
                error: describeFailure(run.engine, run.stderr, undefined, code),
            });
        });
    }

    private buildArgs(engine: AgentEngineId, prompt: string, request: AgentRunRequest, model: string): string[] {
        const args = ['-p', prompt, '--output-format', 'stream-json'];
        // Settings validation refuses such ids; never let one be read as another flag.
        if (model.startsWith('-')) {
            model = '';
        }
        if (engine === 'antigravity') {
            args.push('--print-timeout', CLI_PRINT_TIMEOUT);
            if (ANTIGRAVITY_SANDBOX) {
                args.push('--sandbox');
            }
            if (model) {
                args.push('--model', model);
            }
            if (request.conversationId) {
                args.push('--conversation', request.conversationId);
            }
            if (request.category === 'files') {
                args.push('--json-schema', JSON.stringify(FILE_PLAN_JSON_SCHEMA));
            }
        } else {
            // Gemini CLI: the default approval mode refuses tools that need approval when headless.
            args.push('--approval-mode', 'default');
            if (model) {
                args.push('--model', model);
            }
            if (request.conversationId) {
                args.push('--resume', request.conversationId);
            }
        }
        return args;
    }

    /** Environment for the CLI: the app's, with the usual install folders on PATH. */
    private childEnv(binaryDir?: string): NodeJS.ProcessEnv {
        const delimiter = this.platform === 'win32' ? ';' : ':';
        const dirs = getSearchDirectories({
            env: this.env,
            homeDir: this.homeDir(),
            platform: this.platform,
            extraDirectories: this.extraSearchDirectories,
        });
        const pathValue = [...(binaryDir ? [binaryDir] : []), ...dirs].join(delimiter);
        const env: NodeJS.ProcessEnv = { ...this.env, PATH: pathValue, NO_COLOR: '1' };
        // Never let the CLI run as Electron's Node by accident.
        delete env.ELECTRON_RUN_AS_NODE;
        return env;
    }

    private handleParsedEvent(run: ActiveRun, event: ParsedAgentEvent): void {
        if (run.finished) {
            return;
        }
        switch (event.kind) {
            case 'init':
                if (event.conversationId) {
                    run.conversationId = event.conversationId;
                }
                // Runtime guard, whatever the settings files say: the CLI reports how it
                // handles tools that need approval.
                if (
                    run.engine === 'antigravity' &&
                    event.permissionMode !== undefined &&
                    !SAFE_PERMISSION_MODES.includes(event.permissionMode)
                ) {
                    this.logger.warn('Agent CLI runs tools without asking; stopping run:', {
                        runId: run.runId,
                        permissionMode: event.permissionMode,
                    });
                    this.invalidateStatus();
                    this.finish(run, {
                        status: 'ERROR',
                        response: '',
                        error: 'Antigravity CLI is set to run tools without asking; Quick Chat will not use it like that.',
                    });
                    if (run.child) {
                        this.stopChild(run.child);
                    }
                }
                break;
            case 'text':
                if (run.text.length < MAX_RESPONSE_CHARS) {
                    run.text += event.delta;
                }
                // File runs answer with a plan; their raw JSON is not shown as text.
                if (run.category !== 'files') {
                    run.emit({ type: 'text', runId: run.runId, delta: event.delta });
                }
                break;
            case 'tool':
                if (event.command) {
                    this.trackCommandStep(run, event);
                }
                run.emit({
                    type: 'tool',
                    runId: run.runId,
                    name: event.name,
                    summary: event.summary,
                    state: event.state,
                    ...(event.error ? { error: event.error } : {}),
                    ...(event.command ? { command: event.command } : {}),
                    ...(event.stepIndex !== undefined ? { stepIndex: event.stepIndex } : {}),
                    ...(event.output ? { output: event.output } : {}),
                });
                break;
            case 'warning':
                run.warnings.push(event.message);
                break;
            case 'result':
                run.resultSeen = true;
                this.completeRun(run, event);
                break;
        }
    }

    /**
     * Record a terminal command step. agy 1.3.5 may report a refused command only as
     * ACTIVE (sometimes twice) and never DONE, so steps are recorded when they start and
     * updated when they finish.
     */
    private trackCommandStep(run: ActiveRun, event: Extract<ParsedAgentEvent, { kind: 'tool' }>): void {
        const command = event.command as string;
        let existing: ActiveRun['commandSteps'][number] | undefined;
        for (let i = run.commandSteps.length - 1; i >= 0; i--) {
            const step = run.commandSteps[i];
            if (!step || step.done) {
                continue;
            }
            const same =
                event.stepIndex !== undefined && step.stepIndex !== undefined
                    ? step.stepIndex === event.stepIndex
                    : step.command === command;
            if (same) {
                existing = step;
                break;
            }
        }
        if (!existing) {
            existing = {
                tool: event.name,
                command,
                summary: event.summary,
                ...(event.stepIndex !== undefined ? { stepIndex: event.stepIndex } : {}),
                done: false,
                withoutOutput: true,
            };
            run.commandSteps.push(existing);
        }
        if (event.state === 'DONE') {
            existing.done = true;
            existing.withoutOutput = event.hasOutput === false && !event.error;
        }
    }

    private completeRun(run: ActiveRun, result: Extract<ParsedAgentEvent, { kind: 'result' }>): void {
        const conversationId = result.conversationId ?? run.conversationId;
        if (conversationId) {
            run.conversationId = conversationId;
        }
        const response = result.response ?? run.text;
        const blocked = this.collectBlocked(run, result);

        if (result.status !== 'SUCCESS') {
            const status: AgentRunStatus = result.status;
            this.finish(run, {
                status,
                response,
                error:
                    status === 'ERROR'
                        ? describeFailure(run.engine, run.stderr, result.error ?? run.warnings.at(-1), null)
                        : result.error,
                ...blocked,
            });
            this.scheduleLingeringKill(run);
            return;
        }

        if (run.category === 'files') {
            const plan = normalizePlan(result.structuredOutput ?? response, {
                homeDir: this.homeDir(),
                platform: this.platform,
            });
            if (!plan) {
                this.finish(run, {
                    status: 'ERROR',
                    response,
                    error: 'The agent did not return a file plan. Try describing the change again.',
                });
                this.scheduleLingeringKill(run);
                return;
            }
            const { plan: safePlan, removed } = filterUnsafeActions(plan, this.pathPolicy());
            if (removed > 0) {
                const note = `(${removed} proposed change${removed === 1 ? '' : 's'} outside your home folder or in a hidden folder ${removed === 1 ? 'was' : 'were'} left out.)`;
                safePlan.summary = safePlan.summary ? `${safePlan.summary} ${note}` : note;
            }
            this.storePlan(run.runId, safePlan);
            this.logger.log('Agent proposed a file plan:', {
                runId: run.runId,
                actions: safePlan.actions.length,
                removed,
            });
            run.emit({ type: 'plan', runId: run.runId, plan: safePlan });
            this.finish(run, { status: 'SUCCESS', response: safePlan.summary, ...blocked });
            this.scheduleLingeringKill(run);
            return;
        }

        this.finish(run, { status: 'SUCCESS', response, ...blocked });
        this.scheduleLingeringKill(run);
    }

    /**
     * The commands headless mode refused in this run. With agy 1.3.5 a refused command's
     * step ends DONE without output or error, but so does a command that ran and printed
     * nothing, so a command only counts as refused when the result lists denied commands:
     * then the last that many output-less command steps are the refused ones (a denial ends
     * the turn, so in practice it is the last tool step). A command step that never reached
     * DONE (seen with a refused `cat`) counts as output-less.
     */
    private collectBlocked(
        run: ActiveRun,
        result: Extract<ParsedAgentEvent, { kind: 'result' }>
    ): Partial<DoneDetails> {
        const deniedActions = result.deniedActions;
        if (run.engine !== 'antigravity' || !deniedActions || deniedActions.length === 0) {
            return {};
        }
        const blocked: BlockedCommand[] = [];
        const count = result.deniedCommands ?? 0;
        if (count > 0) {
            const refused = run.commandSteps.filter((step) => step.withoutOutput).slice(-count);
            const seen = new Set<string>();
            for (const step of refused) {
                if (seen.has(step.command)) {
                    continue;
                }
                seen.add(step.command);
                const lastingRule = lastingRuleFor(step.command);
                blocked.push({
                    tool: step.tool,
                    command: step.command,
                    summary: step.summary,
                    ...(step.stepIndex !== undefined ? { stepIndex: step.stepIndex } : {}),
                    ...(lastingRule ? { lastingRule } : {}),
                    ...(needsCaution(step.command) ? { caution: true } : {}),
                });
            }
        }
        // The card needs a conversation to resume and an answering task (file tasks must
        // not run commands). A run that already answers without the commands gets no card.
        const canResume =
            blocked.length > 0 &&
            blocked.length <= MAX_BLOCKED_COMMANDS &&
            Boolean(run.conversationId) &&
            run.category !== 'files' &&
            run.resume !== 'declined';
        const approvalUnavailable = canResume ? this.approvalUnavailable(blocked) : undefined;
        if (canResume && run.conversationId) {
            this.blockedRuns.set(run.runId, {
                conversationId: run.conversationId,
                category: run.category,
                commands: blocked,
                ...(approvalUnavailable ? { approvalUnavailable } : {}),
            });
            while (this.blockedRuns.size > MAX_STORED_BLOCKED_RUNS) {
                const oldest = this.blockedRuns.keys().next().value as string;
                this.blockedRuns.delete(oldest);
            }
        }
        this.logger.log('Agent CLI denied actions:', {
            runId: run.runId,
            deniedActions,
            blockedCommands: blocked.length,
            canResume,
            approvalAvailable: canResume && !approvalUnavailable,
        });
        return {
            blocked,
            deniedActions,
            canResume,
            ...(approvalUnavailable ? { approvalUnavailable } : {}),
        };
    }

    /** Why blocked commands cannot be allowed, or undefined when they can. */
    private approvalUnavailable(blocked: BlockedCommand[]): string | undefined {
        if (this.platform === 'win32') {
            return "On Windows the app does not allow the agent's commands: Antigravity CLI does not document a sandbox there.";
        }
        if (blocked.some((entry) => hasInvisibleCharacters(entry.command))) {
            return 'A command contains control or invisible characters, so what you see may not be what would run. It cannot be allowed.';
        }
        const refusal = blocked.map((entry) => refuseAllowRule(commandRule(entry.command))).find(Boolean);
        return refusal ? `This command cannot be allowed: ${refusal}` : undefined;
    }

    private finish(run: ActiveRun, done: DoneDetails): void {
        if (run.finished) {
            return;
        }
        run.finished = true;
        for (const timer of run.timers.splice(0)) {
            clearTimeout(timer);
        }
        void removeRunInputs(this.workspaceDir(), run.runId).catch(() => undefined);
        this.removeTemporaryRules(run);
        this.logger.log('Agent run finished:', {
            runId: run.runId,
            status: done.status,
            responseLength: done.response.length,
        });
        run.emit({
            type: 'done',
            runId: run.runId,
            status: done.status,
            response: done.response,
            ...(run.conversationId ? { conversationId: run.conversationId } : {}),
            ...(done.error ? { error: done.error } : {}),
            ...(done.blocked && done.blocked.length > 0 ? { blocked: done.blocked } : {}),
            ...(done.deniedActions && done.deniedActions.length > 0 ? { deniedActions: done.deniedActions } : {}),
            ...(done.canResume ? { canResume: true } : {}),
            ...(done.approvalUnavailable ? { approvalUnavailable: done.approvalUnavailable } : {}),
        });
    }

    /** Stop a CLI that keeps running after it reported its result. */
    private scheduleLingeringKill(run: ActiveRun): void {
        const child = run.child;
        if (!child) {
            return;
        }
        const timer = setTimeout(() => {
            if (run.child === child) {
                this.stopChild(child);
            }
        }, AFTER_RESULT_GRACE_MS);
        timer.unref?.();
    }

    /** SIGINT, then SIGTERM after a grace period, then SIGKILL. */
    private stopChild(child: ChildProcess): void {
        const isAlive = (): boolean => child.exitCode === null && child.signalCode === null;
        if (!isAlive()) {
            return;
        }
        try {
            child.kill('SIGINT');
        } catch {
            // Already gone.
        }
        const term = setTimeout(() => {
            if (isAlive()) {
                try {
                    child.kill('SIGTERM');
                } catch {
                    // Already gone.
                }
                const killTimer = setTimeout(() => {
                    if (isAlive()) {
                        try {
                            child.kill('SIGKILL');
                        } catch {
                            // Already gone.
                        }
                    }
                }, this.cancelGraceMs);
                killTimer.unref?.();
            }
        }, this.cancelGraceMs);
        term.unref?.();
    }

    /** Stop a run. Emits `done` with CANCELED. Unknown or finished runs are ignored. */
    cancel(runId: unknown): boolean {
        const run = this.activeRun;
        if (!run || typeof runId !== 'string' || run.runId !== runId || run.finished) {
            return false;
        }
        this.logger.log('Cancelling agent run:', { runId });
        this.finish(run, { status: 'CANCELED', response: run.text });
        if (run.child) {
            this.stopChild(run.child);
        }
        return true;
    }

    /** True while a run is in progress. */
    isRunning(): boolean {
        return Boolean(this.activeRun && !this.activeRun.finished);
    }

    // =========================================================================
    // Blocked commands and allow rules (Antigravity CLI)
    // =========================================================================

    /**
     * Record that the app wants `rules` (with `change`), noting the ones that were in the
     * settings file before the app wanted them as the user's own, then add the missing ones.
     * The record is written first, so a crash leaves nothing the app would not remove.
     */
    private wantRules(rules: string[], change: (record: PermissionRecord) => PermissionRecord): string[] {
        const file = this.antigravitySettingsFile();
        const present = readAllowRules(file);
        this.permissions.update((record) => {
            const wanted = wantedRules(record);
            const userOwned = rules.filter((rule) => present.includes(rule) && !wanted.has(rule));
            const next = change(record);
            return { ...next, userOwned: union(next.userOwned, userOwned) };
        });
        const { added } = updateAllowRules(file, { add: rules.filter((rule) => !present.includes(rule)) });
        this.invalidateStatus();
        return added;
    }

    /**
     * Forget the app's reasons for `rules` (with `change`) and remove from the settings file
     * those no reason keeps any more. The user's own rules are never removed.
     */
    private releaseRules(rules: string[], change: (record: PermissionRecord) => PermissionRecord): string[] {
        const next = change(this.permissions.read());
        const stillWanted = new Set([...next.lasting, ...next.lookup, ...next.pending, ...next.userOwned]);
        const { removed } = updateAllowRules(this.antigravitySettingsFile(), {
            remove: rules.filter((rule) => !stillWanted.has(rule)),
        });
        // A user-owned rule no reason refers to any more is the user's business again.
        const referenced = new Set([...next.lasting, ...next.lookup, ...next.pending]);
        this.permissions.write({ ...next, userOwned: next.userOwned.filter((rule) => referenced.has(rule)) });
        this.invalidateStatus();
        return removed;
    }

    /** Write a run's rules for this answer, recording them as pending first. */
    private addTemporaryRules(run: ActiveRun, rules: string[]): void {
        run.temporaryRules = [...new Set(rules)];
        try {
            this.wantRules(run.temporaryRules, (record) => ({
                ...record,
                pending: union(record.pending, run.temporaryRules),
            }));
        } catch (error) {
            const failed = run.temporaryRules.splice(0);
            try {
                this.permissions.update((record) => ({
                    ...record,
                    pending: record.pending.filter((rule) => !failed.includes(rule)),
                }));
            } catch {
                // The record stays; the next start cleans up.
            }
            throw error;
        }
        this.logger.log('Added temporary allow rules:', { runId: run.runId, count: run.temporaryRules.length });
    }

    /** Remove a run's rules for this answer. On failure they stay pending for the next start. */
    private removeTemporaryRules(run: ActiveRun): void {
        const rules = run.temporaryRules.splice(0);
        if (rules.length === 0) {
            return;
        }
        try {
            const removed = this.releaseRules(rules, (record) => ({
                ...record,
                pending: record.pending.filter((rule) => !rules.includes(rule)),
            }));
            this.logger.log('Removed temporary allow rules:', { runId: run.runId, count: removed.length });
        } catch (error) {
            this.logger.warn('Could not remove temporary allow rules; they are removed at the next start:', {
                runId: run.runId,
                count: rules.length,
                error: error instanceof AgentPermissionsError ? 'settings' : (error as NodeJS.ErrnoException)?.code,
            });
        }
    }

    /**
     * Remove rules for one answer that a crashed or killed app left behind, and bring the
     * lookup list up to date when it is on. Call once at startup.
     */
    initialize(): void {
        let record: PermissionRecord;
        try {
            record = this.permissions.read();
        } catch {
            return;
        }
        if (record.pending.length > 0) {
            try {
                const removed = this.releaseRules(record.pending, (current) => ({ ...current, pending: [] }));
                this.logger.log('Removed leftover temporary allow rules:', { count: removed.length });
            } catch (error) {
                this.logger.warn('Could not remove leftover temporary allow rules:', {
                    count: record.pending.length,
                    error: error instanceof AgentPermissionsError ? 'settings' : (error as NodeJS.ErrnoException)?.code,
                });
            }
        }
        if (record.lookupEnabled && this.platform !== 'win32') {
            try {
                this.syncLookupRules(true);
            } catch (error) {
                this.logger.warn('Could not update the lookup command rules:', {
                    error: error instanceof AgentPermissionsError ? 'settings' : (error as NodeJS.ErrnoException)?.code,
                });
            }
        }
    }

    /**
     * Decide about a finished run's blocked commands and resume its conversation, without
     * gathering context again. "once" adds a rule per command line for the resumed run
     * only; "always" adds the lasting lookup prefix rules the run offered; "without" asks
     * the agent to answer from what it has. Resolves with the resumed run's id, or an error
     * for the UI.
     */
    async approveBlockedCommands(
        request: unknown,
        options: AgentRunOptions
    ): Promise<{ runId?: string; error?: string }> {
        if (typeof request !== 'object' || request === null) {
            return { error: 'Invalid approval.' };
        }
        const { runId, decision } = request as { runId?: unknown; decision?: unknown };
        if (typeof runId !== 'string' || (decision !== 'once' && decision !== 'always' && decision !== 'without')) {
            return { error: 'Invalid approval.' };
        }
        const blocked = this.blockedRuns.get(runId);
        if (!blocked) {
            return { error: 'These commands can no longer be approved. Ask again.' };
        }
        const choice: CommandApprovalDecision = decision;
        if (choice !== 'without' && blocked.approvalUnavailable) {
            return { error: blocked.approvalUnavailable };
        }

        let temporaryRules: string[] = [];
        if (choice === 'always') {
            const rules = blocked.commands.map((entry) => entry.lastingRule);
            if (rules.some((rule) => rule === undefined)) {
                return { error: 'Some of these commands can only be allowed for this answer.' };
            }
            try {
                const added = this.wantRules(rules as string[], (record) => ({
                    ...record,
                    lasting: union(record.lasting, rules as string[]),
                }));
                this.logger.log('Added lasting allow rules:', { count: added.length });
            } catch (error) {
                return { error: permissionErrorMessage(error) };
            }
        } else if (choice === 'once') {
            temporaryRules = blocked.commands.map((entry) => commandRule(entry.command));
            const refusal = temporaryRules.map(refuseAllowRule).find((reason) => reason !== null);
            if (refusal) {
                return { error: refusal };
            }
            try {
                // Fail here, while the card is still showing, when the file cannot be changed.
                readAllowRules(this.antigravitySettingsFile());
            } catch (error) {
                return { error: permissionErrorMessage(error) };
            }
        }

        const one = blocked.commands.length === 1;
        const list = blocked.commands.map((entry) => `\`${entry.command}\``).join(', ');
        const prompt =
            choice === 'without'
                ? `The user did not allow: ${list}. Do not run any more commands. Answer the original question from the command output you already have, and say briefly what you could not check.`
                : `The user approved ${one ? 'this command' : 'these commands'}: ${list}. Run ${one ? 'it' : 'them'} now and answer the original question from the output. Other commands still need the user's approval, so only run another one if the question cannot be answered without it.`;
        try {
            const valid = validateRunRequest({
                prompt,
                category: blocked.category,
                conversationId: blocked.conversationId,
            });
            const started = this.startNewRun(valid, options, {
                temporaryRules,
                resume: choice === 'without' ? 'declined' : 'approved',
            });
            this.blockedRuns.delete(runId);
            this.logger.log('Decided about blocked commands:', {
                runId,
                resumedRunId: started.runId,
                decision: choice,
                commands: blocked.commands.length,
            });
            return started;
        } catch (error) {
            return { error: (error as Error).message };
        }
    }

    /**
     * Add the lookup list's rules or take them back. The whole list is recorded as wanted,
     * so turning it off keeps rules the user also chose with "Always allow", rules for a
     * running answer and the user's own rules.
     */
    private syncLookupRules(enabled: boolean): void {
        const record = this.permissions.read();
        if (enabled) {
            const wanted = new Set(LOOKUP_COMMAND_RULES);
            // Rules of an older list that are no longer in it.
            const outdated = record.lookup.filter((rule) => !wanted.has(rule));
            const added = this.wantRules([...LOOKUP_COMMAND_RULES], (current) => ({
                ...current,
                lookupEnabled: true,
                lookup: [...LOOKUP_COMMAND_RULES],
            }));
            const removed = outdated.length > 0 ? this.releaseRules(outdated, (current) => ({ ...current })) : [];
            this.logger.log('Lookup command rules on:', { added: added.length, removed: removed.length });
        } else {
            const removed = this.releaseRules(record.lookup, (current) => ({
                ...current,
                lookupEnabled: false,
                lookup: [],
            }));
            this.logger.log('Lookup command rules off:', { removed: removed.length });
        }
    }

    /** The command rules the app manages, for Options. */
    async getPermissions(preference: AgentEnginePreference): Promise<AgentPermissionsInfo> {
        const status = await this.getStatus(preference);
        const settingsFile = this.antigravitySettingsFile();
        // On Windows Antigravity CLI documents no sandbox, so the app allows no commands there.
        if (status.engine !== 'antigravity' || this.platform === 'win32') {
            return { supported: false, settingsFile, lookupCommandsEnabled: false, allowedRules: [] };
        }
        const record = this.permissions.read();
        try {
            const present = new Set(readAllowRules(settingsFile));
            return {
                supported: true,
                settingsFile,
                lookupCommandsEnabled: record.lookupEnabled,
                allowedRules: record.lasting.filter((rule) => present.has(rule)),
            };
        } catch (error) {
            return {
                supported: true,
                settingsFile,
                error: permissionErrorMessage(error),
                lookupCommandsEnabled: record.lookupEnabled,
                allowedRules: record.lasting,
            };
        }
    }

    /** Turn the lookup command list on or off. */
    async setLookupCommands(enabled: unknown, preference: AgentEnginePreference): Promise<AgentPermissionsInfo> {
        if (typeof enabled !== 'boolean') {
            throw new Error('Invalid value.');
        }
        const before = await this.getPermissions(preference);
        if (!before.supported) {
            return before;
        }
        try {
            this.syncLookupRules(enabled);
        } catch (error) {
            return { ...(await this.getPermissions(preference)), error: permissionErrorMessage(error) };
        }
        return this.getPermissions(preference);
    }

    /** Take back a lasting rule the user chose with "Always allow". Other rules stay. */
    async removeAllowedRule(rule: unknown, preference: AgentEnginePreference): Promise<AgentPermissionsInfo> {
        const record = this.permissions.read();
        if (typeof rule !== 'string' || !record.lasting.includes(rule)) {
            return { ...(await this.getPermissions(preference)), error: 'The app did not add this rule.' };
        }
        try {
            this.releaseRules([rule], (current) => ({
                ...current,
                lasting: current.lasting.filter((entry) => entry !== rule),
            }));
            this.logger.log('Removed a lasting allow rule.');
        } catch (error) {
            return { ...(await this.getPermissions(preference)), error: permissionErrorMessage(error) };
        }
        return this.getPermissions(preference);
    }

    // =========================================================================
    // Models
    // =========================================================================

    /**
     * The models Antigravity CLI offers (`agy models`) and its default (`agy -p /model`,
     * which the CLI answers itself), cached for 5 minutes; a failure is kept for a minute
     * so a broken install does not hold up Options. Gemini CLI cannot list its models.
     */
    async listModels(preference: AgentEnginePreference, refresh = false): Promise<AgentModelList> {
        const status = await this.getStatus(preference);
        if (status.engine === 'gemini-cli') {
            return { models: [], error: 'Gemini CLI does not list its models.' };
        }
        if (!status.available || status.engine !== 'antigravity' || !status.path) {
            return { models: [], error: status.error ?? 'No agent CLI is available.' };
        }
        const cached = this.modelCache;
        if (!refresh && cached && cached.binaryPath === status.path && this.now() - cached.checkedAt < cached.ttlMs) {
            return cached.list;
        }
        const list = await this.readModels(status.path);
        this.modelCache = {
            binaryPath: status.path,
            list,
            checkedAt: this.now(),
            ttlMs: list.error ? MODEL_LIST_FAILURE_TTL_MS : MODEL_LIST_TTL_MS,
        };
        return list;
    }

    private async readModels(binaryPath: string): Promise<AgentModelList> {
        const listing = await this.readCliOutput(binaryPath, ['models']);
        const models = listing.ok ? parseModelLines(listing.stdout) : [];
        if (models.length === 0) {
            this.logger.warn('Could not list the agent models:', { ok: listing.ok, code: listing.code });
            return {
                models: [],
                error: listing.ok
                    ? 'Antigravity CLI did not list any models.'
                    : 'Could not list the models of Antigravity CLI.',
            };
        }
        // Only once listing worked, and with a short limit in case a CLI sends it to the model.
        const defaultLine = await this.readCliOutput(binaryPath, ['-p', '/model', '--print-timeout', '20s']);
        const named = defaultLine.ok ? parseModelLines(defaultLine.stdout)[0] : undefined;
        // Trust only a default that is one of the listed models.
        const defaultModel = named ? models.find((model) => model.id === named.id) : undefined;
        this.logger.log('Listed agent models:', { count: models.length, defaultKnown: Boolean(defaultModel) });
        return { models, ...(defaultModel ? { defaultModel } : {}) };
    }

    /** Run the CLI with short arguments (no prompt from the user) and collect its output. */
    private readCliOutput(
        binaryPath: string,
        args: string[]
    ): Promise<{ ok: boolean; stdout: string; code: number | null }> {
        return new Promise((resolve) => {
            // An empty folder of its own, emptied each time, so no workspace files or rules apply.
            const cwd = path.join(this.userDataDir(), 'agent-cli');
            let child: ChildProcess;
            try {
                fs.rmSync(cwd, { recursive: true, force: true });
                fs.mkdirSync(cwd, { recursive: true });
                child = this.spawnProcess(binaryPath, args, {
                    cwd,
                    env: this.childEnv(path.dirname(binaryPath)),
                    stdio: ['ignore', 'pipe', 'ignore'],
                    shell: false,
                    windowsHide: true,
                });
            } catch {
                resolve({ ok: false, stdout: '', code: null });
                return;
            }
            let stdout = '';
            let settled = false;
            const settle = (result: { ok: boolean; stdout: string; code: number | null }) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(result);
                }
            };
            const timer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Already gone.
                }
                settle({ ok: false, stdout: '', code: null });
            }, this.modelListTimeoutMs);
            child.stdout?.setEncoding('utf8');
            child.stdout?.on('data', (chunk: string) => {
                if (stdout.length < MAX_MODEL_OUTPUT_CHARS) {
                    stdout += chunk;
                }
            });
            child.on('error', () => settle({ ok: false, stdout: '', code: null }));
            child.on('close', (code: number | null) => settle({ ok: code === 0, stdout, code }));
        });
    }

    // =========================================================================
    // File plans
    // =========================================================================

    private pathPolicy(): PathPolicy {
        return { homeDir: this.homeDir(), userDataDir: this.userDataDir(), platform: this.platform };
    }

    private storePlan(runId: string, plan: FileActionPlan): void {
        this.plans.set(runId, { plan, applied: false });
        while (this.plans.size > MAX_STORED_PLANS) {
            const oldest = this.plans.keys().next().value as string;
            this.plans.delete(oldest);
        }
    }

    /** The plan a run proposed, if any (for tests and diagnostics). */
    getPlan(runId: string): FileActionPlan | null {
        return this.plans.get(runId)?.plan ?? null;
    }

    private refusal(error: string): FileActionResult {
        return { applied: 0, failed: [{ id: '', error }], undoAvailable: isUndoable(this.undoLog) };
    }

    /** Apply a run's plan, once. The plan becomes the one Undo reverses. */
    async applyPlan(runId: unknown): Promise<FileActionResult> {
        if (typeof runId !== 'string') {
            return this.refusal('Invalid run id.');
        }
        const stored = this.plans.get(runId);
        if (!stored) {
            return this.refusal('There is no file plan for this answer.');
        }
        if (stored.applied) {
            return this.refusal('This plan has already been applied.');
        }
        if (this.fileWorkBusy) {
            return this.refusal('Another file plan is being applied.');
        }

        // Every path is checked again on disk (symbolic links included) before each action.
        const policy = this.pathPolicy();
        this.fileWorkBusy = true;
        try {
            const { result, undoLog } = await applyPlan(stored.plan, policy, this.fileOps);
            // A plan that changed nothing can be tried again; otherwise it is spent and
            // becomes the plan Undo reverses.
            if (result.applied > 0) {
                stored.applied = true;
            }
            if (result.applied > 0 || isUndoable(undoLog)) {
                this.undoLog = undoLog;
            }
            this.logger.log('Applied file plan:', {
                runId,
                applied: result.applied,
                failed: result.failed.length,
            });
            return result;
        } finally {
            this.fileWorkBusy = false;
        }
    }

    /** Undo the last applied plan, once. */
    async undoLastPlan(): Promise<FileActionResult> {
        if (!isUndoable(this.undoLog)) {
            return { applied: 0, failed: [{ id: '', error: 'There is nothing to undo.' }], undoAvailable: false };
        }
        if (this.fileWorkBusy) {
            return this.refusal('A file plan is being applied.');
        }
        const log = this.undoLog;
        this.undoLog = [];
        this.fileWorkBusy = true;
        try {
            const result = await undoPlan(log, this.pathPolicy(), this.fileOps);
            this.logger.log('Undid file plan:', { applied: result.applied, failed: result.failed.length });
            return result;
        } finally {
            this.fileWorkBusy = false;
        }
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /** Stop any running CLI. Called when the app quits. */
    dispose(): void {
        this.disposed = true;
        const run = this.activeRun;
        if (!run) {
            return;
        }
        for (const timer of run.timers.splice(0)) {
            clearTimeout(timer);
        }
        run.finished = true;
        this.removeTemporaryRules(run);
        const child = run.child;
        if (child && child.exitCode === null && child.signalCode === null) {
            try {
                child.kill('SIGTERM');
            } catch {
                // Already gone.
            }
        }
        this.activeRun = null;
    }
}
