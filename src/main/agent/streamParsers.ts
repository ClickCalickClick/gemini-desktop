/**
 * Parsers for the agent CLIs' `--output-format stream-json` output (NDJSON).
 *
 * Both parsers turn one JSON line into zero or more engine-neutral events. Unknown
 * events and fields are ignored, so newer CLI versions keep working.
 *
 * @module agent/streamParsers
 */

import type { AgentEngineId } from '../../shared/types/agent';
import { isObject, type JsonObject } from './json';

/** Longest line kept in the buffer; longer lines are dropped. */
export const MAX_LINE_LENGTH = 8 * 1024 * 1024;

/**
 * Splits a chunked text stream into complete lines. Partial lines wait for the next
 * chunk; a line longer than {@link MAX_LINE_LENGTH} is dropped.
 */
export class LineSplitter {
    private buffer = '';
    private discarding = false;

    constructor(private readonly onLine: (line: string) => void) {}

    push(chunk: string): void {
        let rest = chunk;
        let newlineIndex = rest.indexOf('\n');
        while (newlineIndex !== -1) {
            const piece = rest.slice(0, newlineIndex);
            rest = rest.slice(newlineIndex + 1);
            if (this.discarding) {
                this.discarding = false;
                this.buffer = '';
            } else {
                const line = this.buffer + piece;
                this.buffer = '';
                this.emit(line);
            }
            newlineIndex = rest.indexOf('\n');
        }
        if (this.discarding) {
            return;
        }
        this.buffer += rest;
        if (this.buffer.length > MAX_LINE_LENGTH) {
            this.buffer = '';
            this.discarding = true;
        }
    }

    /** Emit what is left once the stream has ended. */
    flush(): void {
        if (!this.discarding && this.buffer.length > 0) {
            this.emit(this.buffer);
        }
        this.buffer = '';
        this.discarding = false;
    }

    private emit(line: string): void {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
            this.onLine(trimmed);
        }
    }
}

/** Final status reported by a CLI, before mapping to AgentRunStatus. */
export type ParsedResultStatus = 'SUCCESS' | 'ERROR' | 'CANCELED' | 'INTERRUPTED';

/** Engine-neutral events produced by the parsers. */
export type ParsedAgentEvent =
    | { kind: 'init'; conversationId?: string; permissionMode?: string }
    | { kind: 'text'; delta: string }
    | { kind: 'tool'; name: string; summary: string; state: 'ACTIVE' | 'DONE'; error?: string }
    | { kind: 'warning'; message: string }
    | {
          kind: 'result';
          status: ParsedResultStatus;
          response?: string;
          error?: string;
          conversationId?: string;
          structuredOutput?: unknown;
      };

function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Parse one line as a JSON object, or null when it is not one. */
export function parseJsonLine(line: string): JsonObject | null {
    try {
        const value: unknown = JSON.parse(line);
        return isObject(value) ? value : null;
    } catch {
        return null;
    }
}

/** Read an error that may be a string or `{type, message}`. */
function errorMessage(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return nonEmpty(value);
    }
    if (isObject(value)) {
        return nonEmpty(value.message) ?? nonEmpty(value.type);
    }
    return undefined;
}

const SUMMARY_KEYS = [
    'command',
    'CommandLine',
    'command_line',
    'cmd',
    'absolute_path',
    'AbsolutePath',
    'file_path',
    'filePath',
    'TargetFile',
    'path',
    'dir_path',
    'directory',
    'DirectoryPath',
    'url',
    'Url',
    'query',
    'Query',
    'pattern',
    'Pattern',
];

const MAX_SUMMARY_LENGTH = 120;

/** A short one-line description of a tool call, from its parameters. */
export function summarizeToolParameters(parameters: unknown): string {
    let value: string | undefined;
    if (typeof parameters === 'string') {
        value = parameters;
    } else if (isObject(parameters)) {
        for (const key of SUMMARY_KEYS) {
            const candidate = nonEmpty(parameters[key]);
            if (candidate) {
                value = candidate;
                break;
            }
        }
        if (!value) {
            value = Object.values(parameters)
                .map((entry) => nonEmpty(entry))
                .find((entry): entry is string => entry !== undefined);
        }
    }
    if (!value) {
        return '';
    }
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length > MAX_SUMMARY_LENGTH ? `${oneLine.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : oneLine;
}

function mapAntigravityStatus(status: unknown): ParsedResultStatus {
    switch (status) {
        case 'SUCCESS':
            return 'SUCCESS';
        case 'CANCELED':
            return 'CANCELED';
        case 'INTERRUPTED':
            return 'INTERRUPTED';
        default:
            // ERROR, INVALID, WAITING, RUNNING and anything unknown.
            return 'ERROR';
    }
}

/**
 * Antigravity CLI events: `init`, `step_update` and `result`.
 * See https://antigravity.google/docs/cli/headless/
 */
export function parseAntigravityEvent(event: JsonObject): ParsedAgentEvent[] {
    switch (event.event) {
        case 'init': {
            const init = isObject(event.init) ? event.init : {};
            const conversationId = nonEmpty(event.conversation_id) ?? nonEmpty(init.conversation_id);
            const permissionMode = nonEmpty(init.permission_mode);
            return [
                {
                    kind: 'init',
                    ...(conversationId ? { conversationId } : {}),
                    ...(permissionMode ? { permissionMode } : {}),
                },
            ];
        }
        case 'step_update': {
            const step = event.step_update;
            if (!isObject(step)) {
                return [];
            }
            // Steps of subagents are summarised by their parent step; skip their text.
            const stepType = str(step.step_type);
            const state = step.state === 'DONE' ? 'DONE' : 'ACTIVE';
            if (stepType === 'tool') {
                const toolInfo = isObject(step.tool_info) ? step.tool_info : {};
                const name = nonEmpty(toolInfo.name) ?? nonEmpty(step.tool_name) ?? 'tool';
                const error = errorMessage(toolInfo.error);
                return [
                    {
                        kind: 'tool',
                        name,
                        summary: summarizeToolParameters(toolInfo.parameters),
                        state,
                        ...(error ? { error } : {}),
                    },
                ];
            }
            if ((stepType === 'agent_response' || stepType === undefined) && !isObject(step.subagent_info)) {
                const delta = str(step.text_delta);
                if (delta) {
                    return [{ kind: 'text', delta }];
                }
            }
            return [];
        }
        case 'result': {
            const result = event.result;
            if (!isObject(result)) {
                return [];
            }
            const conversationId = nonEmpty(result.conversation_id);
            const error = errorMessage(result.error);
            return [
                {
                    kind: 'result',
                    status: mapAntigravityStatus(result.status),
                    ...(typeof result.response === 'string' ? { response: result.response } : {}),
                    ...(error ? { error } : {}),
                    ...(conversationId ? { conversationId } : {}),
                    ...(result.structured_output !== undefined ? { structuredOutput: result.structured_output } : {}),
                },
            ];
        }
        default:
            return [];
    }
}

/**
 * Gemini CLI events: `init`, `message`, `tool_use`, `tool_result`, `error` and `result`.
 * Tool results only carry the tool's id, so the parser remembers the names it has seen.
 * See https://geminicli.com/docs/cli/headless/
 */
export class GeminiCliEventParser {
    private readonly tools = new Map<string, { name: string; summary: string }>();

    parse(event: JsonObject): ParsedAgentEvent[] {
        switch (event.type) {
            case 'init': {
                const conversationId = nonEmpty(event.session_id);
                return [{ kind: 'init', ...(conversationId ? { conversationId } : {}) }];
            }
            case 'message': {
                if (event.role !== 'assistant') {
                    return [];
                }
                const delta = str(event.content);
                return delta ? [{ kind: 'text', delta }] : [];
            }
            case 'tool_use': {
                const name = nonEmpty(event.tool_name) ?? 'tool';
                const summary = summarizeToolParameters(event.parameters);
                const toolId = nonEmpty(event.tool_id);
                if (toolId) {
                    this.tools.set(toolId, { name, summary });
                }
                return [{ kind: 'tool', name, summary, state: 'ACTIVE' }];
            }
            case 'tool_result': {
                const toolId = nonEmpty(event.tool_id);
                const known = toolId ? this.tools.get(toolId) : undefined;
                const error = event.status === 'error' ? (errorMessage(event.error) ?? 'Tool failed') : undefined;
                return [
                    {
                        kind: 'tool',
                        name: known?.name ?? nonEmpty(event.tool_name) ?? 'tool',
                        summary: known?.summary ?? '',
                        state: 'DONE',
                        ...(error ? { error } : {}),
                    },
                ];
            }
            case 'error': {
                const message = nonEmpty(event.message);
                return message ? [{ kind: 'warning', message }] : [];
            }
            case 'result': {
                const error = errorMessage(event.error);
                return [
                    {
                        kind: 'result',
                        status: event.status === 'success' ? 'SUCCESS' : 'ERROR',
                        ...(error ? { error } : {}),
                    },
                ];
            }
            default:
                return [];
        }
    }
}

/** Create a line parser for an engine. */
export function createEventParser(engine: AgentEngineId): (event: JsonObject) => ParsedAgentEvent[] {
    if (engine === 'gemini-cli') {
        const parser = new GeminiCliEventParser();
        return (event) => parser.parse(event);
    }
    return parseAntigravityEvent;
}
