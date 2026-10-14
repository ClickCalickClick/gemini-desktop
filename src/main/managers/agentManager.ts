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
 *
 * Never log prompts or answers: only ids, lengths and statuses.
 *
 * @module AgentManager
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import { app, shell } from 'electron';

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
import type {
    AgentEngineId,
    AgentEnginePreference,
    AgentEngineStatus,
    AgentRunEvent,
    AgentRunRequest,
    AgentRunStatus,
    AgentTaskCategory,
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

/**
 * Pass `--sandbox` to Antigravity CLI: terminal commands, if the user's settings allow any,
 * run in the OS sandbox where only the workspace is writable.
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
    private readonly runTimeoutMs: number;
    private readonly cancelGraceMs: number;
    private readonly statusTtlMs: number;
    private readonly now: () => number;

    private statusCache: CachedStatus | null = null;
    private activeRun: ActiveRun | null = null;
    private readonly plans = new Map<string, StoredPlan>();
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
        const valid = validateRunRequest(request);
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
        };
        this.activeRun = run;

        // Events are sent after the runId has been returned to the renderer.
        setTimeout(() => {
            void this.startRun(run, valid, options).catch((error: unknown) => {
                this.logger.error('Agent run failed to start:', { runId, error: (error as Error)?.message });
                this.finish(run, { status: 'ERROR', response: '', error: 'The agent could not be started.' });
            });
        }, 0);

        return { runId };
    }

    private async startRun(run: ActiveRun, request: AgentRunRequest, options: AgentRunOptions): Promise<void> {
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
        const context = await gatherContext(request.prompt, {
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

        this.logger.log('Starting agent run:', {
            runId: run.runId,
            engine: status.engine,
            category: request.category,
            promptLength: request.prompt.length,
            contextLocations: context.locations,
            copiedFiles: context.copiedFiles,
            followUp: Boolean(request.conversationId),
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
                run.emit({
                    type: 'tool',
                    runId: run.runId,
                    name: event.name,
                    summary: event.summary,
                    state: event.state,
                    ...(event.error ? { error: event.error } : {}),
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

    private completeRun(run: ActiveRun, result: Extract<ParsedAgentEvent, { kind: 'result' }>): void {
        const conversationId = result.conversationId ?? run.conversationId;
        if (conversationId) {
            run.conversationId = conversationId;
        }
        const response = result.response ?? run.text;

        if (result.status !== 'SUCCESS') {
            const status: AgentRunStatus = result.status;
            this.finish(run, {
                status,
                response,
                error:
                    status === 'ERROR'
                        ? describeFailure(run.engine, run.stderr, result.error ?? run.warnings.at(-1), null)
                        : result.error,
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
            this.finish(run, { status: 'SUCCESS', response: safePlan.summary });
            this.scheduleLingeringKill(run);
            return;
        }

        this.finish(run, { status: 'SUCCESS', response });
        this.scheduleLingeringKill(run);
    }

    private finish(run: ActiveRun, done: { status: AgentRunStatus; response: string; error?: string }): void {
        if (run.finished) {
            return;
        }
        run.finished = true;
        for (const timer of run.timers.splice(0)) {
            clearTimeout(timer);
        }
        void removeRunInputs(this.workspaceDir(), run.runId).catch(() => undefined);
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
