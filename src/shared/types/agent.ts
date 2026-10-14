/**
 * Agent Types
 *
 * Shared contract for the hybrid Quick Chat: prompts are routed either to a Gemini
 * web tab (as today) or to a local agent CLI (Antigravity CLI `agy`, or the
 * open-source Gemini CLI `gemini` with an API key) that runs on this machine.
 */

/** Agent CLIs the app knows how to drive. */
export type AgentEngineId = 'antigravity' | 'gemini-cli';

/** Engine preference in Options. 'auto' prefers Antigravity, then Gemini CLI. */
export type AgentEnginePreference = 'auto' | AgentEngineId;

/** Where a Quick Chat prompt goes. */
export type QuickChatRoute = 'web' | 'agent';

/** Routing preference in Options. 'auto' lets the router decide per prompt. */
export type QuickChatRoutingMode = 'auto' | QuickChatRoute;

/**
 * What kind of agent task a prompt is. 'files' tasks change files and always go
 * through a plan the user confirms; the others only answer.
 */
export type AgentTaskCategory = 'files' | 'system' | 'documents' | 'code' | 'general';

/** The router's decision for one prompt, shown to the user before sending. */
export interface RouteDecision {
    route: QuickChatRoute;
    /** Set when route is 'agent'. */
    category?: AgentTaskCategory;
    /** Short human-readable reason, e.g. "mentions a folder" or "asks for an image". */
    reason: string;
    /** True when the user forced the route with a prefix or a shortcut. */
    forced: boolean;
    /** The prompt with any routing prefix removed. */
    prompt: string;
}

/** Whether an agent CLI is installed and usable. */
export interface AgentEngineStatus {
    /** The engine that will be used, or null when none is available. */
    engine: AgentEngineId | null;
    available: boolean;
    /** Absolute path of the binary, when found. */
    path?: string;
    version?: string;
    /** Why the engine is unavailable, in words fit for the UI. */
    error?: string;
}

/** Agent settings stored in user preferences. */
export interface AgentSettings {
    quickChatRoutingMode: QuickChatRoutingMode;
    agentEngine: AgentEnginePreference;
    /** Model slug passed to the CLI, or '' for the CLI's default. */
    agentModel: string;
}

/** A request from Quick Chat to run the agent. */
export interface AgentRunRequest {
    prompt: string;
    category: AgentTaskCategory;
    /** Continue an earlier conversation (follow-up questions in Quick Chat). */
    conversationId?: string;
}

/** One file operation proposed by the agent. Nothing runs until the user applies the plan. */
export interface FileAction {
    id: string;
    op: 'move' | 'copy' | 'rename' | 'mkdir' | 'trash';
    /** Absolute source path (not used by mkdir). */
    from?: string;
    /** Absolute destination path (not used by trash). */
    to?: string;
}

export interface FileActionPlan {
    /** One or two sentences describing the plan. */
    summary: string;
    actions: FileAction[];
}

export interface FileActionResult {
    applied: number;
    failed: { id: string; error: string }[];
    /** True when the applied actions can be undone with undoLastFilePlan. */
    undoAvailable: boolean;
}

/**
 * A terminal command the CLI refused to run because headless mode cannot ask for
 * approval (Antigravity soft-denies it and reports it in `denied_actions`).
 */
export interface BlockedCommand {
    /** Tool that asked to run it, e.g. `run_command`. */
    tool: string;
    /** The full command line. */
    command: string;
    /** The tool step's one-line summary, to find its row in the panel. */
    summary: string;
    /**
     * The lasting allow rule offered by "Always allow", e.g. `command(df)`. Missing when
     * the command changes things, uses shell syntax or is otherwise not safe to allow for good.
     */
    lastingRule?: string;
}

/** What the user decided about a run's blocked commands. */
export type CommandApprovalDecision = 'once' | 'always';

/** Request to approve a finished run's blocked commands and resume its conversation. */
export interface CommandApprovalRequest {
    runId: string;
    decision: CommandApprovalDecision;
}

/** A model offered by the CLI (`agy models`). */
export interface AgentModel {
    id: string;
    name: string;
}

/** The CLI's models, or why they could not be listed. */
export interface AgentModelList {
    models: AgentModel[];
    /** The CLI's default model, when it could be read. */
    defaultModel?: AgentModel;
    error?: string;
}

/** A group of read-only command rules, for the Options list. */
export interface ReadOnlyCommandGroup {
    name: string;
    prefixes: readonly string[];
}

/** Command allow rules the app manages in Antigravity CLI's settings. */
export interface AgentPermissionsInfo {
    /** False when the engine in use is not Antigravity CLI; the rest is then empty. */
    supported: boolean;
    /** Antigravity CLI's settings file. */
    settingsFile: string;
    /** Set when the settings file cannot be read or changed (for example invalid JSON). */
    error?: string;
    /** True when the read-only command list is turned on. */
    readOnlyCommandsEnabled: boolean;
    /** Lasting rules the user added with "Always allow" that are still in the file. */
    allowedRules: string[];
}

/** Final status of a run, mirroring the CLI's result status. */
export type AgentRunStatus = 'SUCCESS' | 'ERROR' | 'CANCELED' | 'INTERRUPTED' | 'TIMEOUT';

/** Events streamed from the main process to Quick Chat while a run is in progress. */
export type AgentRunEvent =
    | { type: 'started'; runId: string; engine: AgentEngineId }
    | { type: 'text'; runId: string; delta: string }
    | {
          type: 'tool';
          runId: string;
          name: string;
          /** Short description, e.g. the command line or file path. */
          summary: string;
          state: 'ACTIVE' | 'DONE';
          error?: string;
      }
    | { type: 'plan'; runId: string; plan: FileActionPlan }
    | {
          type: 'done';
          runId: string;
          status: AgentRunStatus;
          response: string;
          conversationId?: string;
          error?: string;
          /** Commands the CLI refused to run (Antigravity only). */
          blocked?: BlockedCommand[];
          /** Actions the CLI reports it denied (`command`, ...), when it says so. */
          deniedActions?: string[];
          /** True when the blocked commands can be approved and the run resumed. */
          canApprove?: boolean;
      };
