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
      };
