/**
 * Unit tests for the agent CLIs' stream-json parsers.
 */
import { describe, it, expect, vi } from 'vitest';

import {
    GeminiCliEventParser,
    LineSplitter,
    MAX_LINE_LENGTH,
    createEventParser,
    parseAntigravityEvent,
    parseJsonLine,
    summarizeToolParameters,
} from '../../../../src/main/agent/streamParsers';

describe('LineSplitter', () => {
    it('joins partial lines across chunks and skips blank lines', () => {
        const onLine = vi.fn();
        const splitter = new LineSplitter(onLine);
        splitter.push('{"a":');
        splitter.push('1}\n\n  \n{"b"');
        expect(onLine).toHaveBeenCalledTimes(1);
        expect(onLine).toHaveBeenCalledWith('{"a":1}');
        splitter.push(':2}\r\n{"c":3}');
        expect(onLine).toHaveBeenLastCalledWith('{"b":2}');
        splitter.flush();
        expect(onLine).toHaveBeenLastCalledWith('{"c":3}');
        expect(onLine).toHaveBeenCalledTimes(3);
    });

    it('drops a line longer than the limit and keeps going', () => {
        const onLine = vi.fn();
        const splitter = new LineSplitter(onLine);
        splitter.push('x'.repeat(MAX_LINE_LENGTH + 10));
        splitter.push('more of the same line');
        splitter.push('\n{"ok":true}\n');
        expect(onLine).toHaveBeenCalledTimes(1);
        expect(onLine).toHaveBeenCalledWith('{"ok":true}');
        splitter.push('y'.repeat(MAX_LINE_LENGTH + 1));
        splitter.flush();
        expect(onLine).toHaveBeenCalledTimes(1);
    });
});

describe('parseJsonLine', () => {
    it('returns objects only', () => {
        expect(parseJsonLine('{"event":"init"}')).toEqual({ event: 'init' });
        expect(parseJsonLine('not json')).toBeNull();
        expect(parseJsonLine('[1,2]')).toBeNull();
        expect(parseJsonLine('42')).toBeNull();
    });
});

describe('summarizeToolParameters', () => {
    it('prefers command and path keys and shortens long values', () => {
        expect(summarizeToolParameters({ other: 'x', command: 'ls  -la\n/tmp' })).toBe('ls -la /tmp');
        expect(summarizeToolParameters({ AbsolutePath: '/home/u/a.txt' })).toBe('/home/u/a.txt');
        expect(summarizeToolParameters({ count: 3, note: 'first string' })).toBe('first string');
        expect(summarizeToolParameters('raw')).toBe('raw');
        expect(summarizeToolParameters(undefined)).toBe('');
        expect(summarizeToolParameters({ count: 3 })).toBe('');
        const long = summarizeToolParameters({ query: 'q'.repeat(300) });
        expect(long.length).toBe(120);
        expect(long.endsWith('…')).toBe(true);
    });
});

describe('parseAntigravityEvent', () => {
    it('reads the conversation id from init', () => {
        expect(parseAntigravityEvent({ event: 'init', conversation_id: 'c1', init: { cwd: '/w' } })).toEqual([
            { kind: 'init', conversationId: 'c1' },
        ]);
        expect(parseAntigravityEvent({ event: 'init' })).toEqual([{ kind: 'init' }]);
        expect(
            parseAntigravityEvent({ event: 'init', conversation_id: 'c1', init: { permission_mode: 'always-proceed' } })
        ).toEqual([{ kind: 'init', conversationId: 'c1', permissionMode: 'always-proceed' }]);
    });

    it('turns agent text deltas into text events and ignores user input and subagents', () => {
        expect(
            parseAntigravityEvent({
                event: 'step_update',
                step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hi' },
            })
        ).toEqual([{ kind: 'text', delta: 'Hi' }]);
        expect(
            parseAntigravityEvent({
                event: 'step_update',
                step_update: { step_type: 'user_input', state: 'DONE', text_delta: 'prompt' },
            })
        ).toEqual([]);
        expect(
            parseAntigravityEvent({
                event: 'step_update',
                step_update: { step_type: 'agent_response', text_delta: 'x', subagent_info: { id: 1 } },
            })
        ).toEqual([]);
        expect(parseAntigravityEvent({ event: 'step_update', step_update: 'bad' })).toEqual([]);
        expect(
            parseAntigravityEvent({ event: 'step_update', step_update: { step_type: 'checkpoint', state: 'DONE' } })
        ).toEqual([]);
    });

    it('turns tool steps into tool events with a summary and error', () => {
        expect(
            parseAntigravityEvent({
                event: 'step_update',
                step_update: {
                    step_type: 'tool',
                    state: 'DONE',
                    tool_name: 'fallback',
                    tool_info: {
                        name: 'run_command',
                        parameters: { command: 'git status' },
                        error: { type: 'PERMISSION', message: 'denied' },
                    },
                },
            })
        ).toEqual([
            {
                kind: 'tool',
                name: 'run_command',
                summary: 'git status',
                state: 'DONE',
                error: 'denied',
                command: 'git status',
                hasOutput: false,
            },
        ]);
        expect(
            parseAntigravityEvent({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'view' } })
        ).toEqual([{ kind: 'tool', name: 'view', summary: '', state: 'ACTIVE' }]);
    });

    it('maps result statuses and keeps structured output', () => {
        expect(
            parseAntigravityEvent({
                event: 'result',
                result: {
                    conversation_id: 'c2',
                    status: 'SUCCESS',
                    response: 'done',
                    structured_output: { summary: 's', actions: [] },
                    usage: {},
                },
            })
        ).toEqual([
            {
                kind: 'result',
                status: 'SUCCESS',
                response: 'done',
                conversationId: 'c2',
                structuredOutput: { summary: 's', actions: [] },
            },
        ]);
        for (const [status, expected] of [
            ['CANCELED', 'CANCELED'],
            ['INTERRUPTED', 'INTERRUPTED'],
            ['INVALID', 'ERROR'],
            ['WAITING', 'ERROR'],
            ['ERROR', 'ERROR'],
        ]) {
            expect(parseAntigravityEvent({ event: 'result', result: { status, error: 'boom' } })).toEqual([
                { kind: 'result', status: expected, error: 'boom' },
            ]);
        }
        expect(parseAntigravityEvent({ event: 'result', result: null })).toEqual([]);
    });

    it('ignores unknown events', () => {
        expect(parseAntigravityEvent({ event: 'telemetry', x: 1 })).toEqual([]);
    });

    describe('a command headless mode refused (agy 1.3.5)', () => {
        // Real lines for "how much disk space is left on my laptop" without allow rules.
        const LINES = [
            '{"event":"step_update","step_update":{"conversation_id":"66c0","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"df -h"}}}}',
            '{"event":"step_update","step_update":{"conversation_id":"66c0","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.04,"tool_info":{"name":"run_command","parameters":{"CommandLine":"df -h"}}}}',
            '{"event":"result","result":{"conversation_id":"66c0","status":"SUCCESS","response":"","duration_seconds":4.4,"num_turns":1,"usage":{},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}',
        ];

        it('keeps the command line, marks the DONE step without output and reads denied_actions', () => {
            const events = LINES.map((line) => parseAntigravityEvent(parseJsonLine(line) ?? {}));
            expect(events).toEqual([
                [{ kind: 'tool', name: 'run_command', summary: 'df -h', state: 'ACTIVE', command: 'df -h' }],
                [
                    {
                        kind: 'tool',
                        name: 'run_command',
                        summary: 'df -h',
                        state: 'DONE',
                        command: 'df -h',
                        hasOutput: false,
                    },
                ],
                [
                    {
                        kind: 'result',
                        status: 'SUCCESS',
                        response: '',
                        conversationId: '66c0',
                        deniedActions: ['command'],
                    },
                ],
            ]);
        });

        it('marks a command that ran (its DONE step carries output)', () => {
            const ran = parseAntigravityEvent({
                event: 'step_update',
                step_update: {
                    state: 'DONE',
                    step_type: 'tool',
                    tool_name: 'run_command',
                    tool_info: {
                        name: 'run_command',
                        parameters: { CommandLine: 'df -h' },
                        output: 'Filesystem Size Used Avail Use% Mounted on',
                    },
                },
            });
            expect(ran).toEqual([
                {
                    kind: 'tool',
                    name: 'run_command',
                    summary: 'df -h',
                    state: 'DONE',
                    command: 'df -h',
                    hasOutput: true,
                },
            ]);
            // A tool that is not a command has no command line.
            expect(
                parseAntigravityEvent({
                    event: 'step_update',
                    step_update: {
                        state: 'DONE',
                        step_type: 'tool',
                        tool_info: { name: 'view_file', parameters: { AbsolutePath: '/w/a.txt' }, output: 'x' },
                    },
                })
            ).toEqual([{ kind: 'tool', name: 'view_file', summary: '/w/a.txt', state: 'DONE', hasOutput: true }]);
        });

        it('keeps a long command line whole while the summary is shortened', () => {
            const long = `du -sh ${'/a'.repeat(100)}`;
            const [event] = parseAntigravityEvent({
                event: 'step_update',
                step_update: {
                    state: 'DONE',
                    step_type: 'tool',
                    tool_info: { name: 'run_command', parameters: { CommandLine: long } },
                },
            });
            expect(event).toMatchObject({ command: long, hasOutput: false });
            expect((event as { summary: string }).summary.length).toBe(120);
        });

        it('reads denied action names and skips malformed entries', () => {
            expect(
                parseAntigravityEvent({
                    event: 'result',
                    result: {
                        status: 'SUCCESS',
                        denied_actions: [
                            { action: 'command' },
                            { display_name: 'ReadFile' },
                            'write_file',
                            3,
                            { action: 'command' },
                        ],
                    },
                })
            ).toEqual([{ kind: 'result', status: 'SUCCESS', deniedActions: ['command', 'ReadFile', 'write_file'] }]);
            expect(
                parseAntigravityEvent({ event: 'result', result: { status: 'SUCCESS', denied_actions: [] } })
            ).toEqual([{ kind: 'result', status: 'SUCCESS' }]);
        });
    });
});

describe('GeminiCliEventParser', () => {
    it('maps Gemini CLI events and remembers tool names by id', () => {
        const parser = new GeminiCliEventParser();
        expect(parser.parse({ type: 'init', session_id: 's1', model: 'm' })).toEqual([
            { kind: 'init', conversationId: 's1' },
        ]);
        expect(parser.parse({ type: 'message', role: 'user', content: 'q' })).toEqual([]);
        expect(parser.parse({ type: 'message', role: 'assistant', content: 'Hello', delta: true })).toEqual([
            { kind: 'text', delta: 'Hello' },
        ]);
        expect(
            parser.parse({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: '/a' } })
        ).toEqual([{ kind: 'tool', name: 'read_file', summary: '/a', state: 'ACTIVE' }]);
        expect(
            parser.parse({ type: 'tool_result', tool_id: 't1', status: 'error', error: { message: 'nope' } })
        ).toEqual([{ kind: 'tool', name: 'read_file', summary: '/a', state: 'DONE', error: 'nope' }]);
        expect(parser.parse({ type: 'tool_result', tool_id: 'unknown', status: 'success' })).toEqual([
            { kind: 'tool', name: 'tool', summary: '', state: 'DONE' },
        ]);
        expect(parser.parse({ type: 'error', severity: 'warning', message: 'slow' })).toEqual([
            { kind: 'warning', message: 'slow' },
        ]);
        expect(parser.parse({ type: 'result', status: 'success', stats: {} })).toEqual([
            { kind: 'result', status: 'SUCCESS' },
        ]);
        expect(parser.parse({ type: 'result', status: 'error', error: { type: 'Auth', message: 'no key' } })).toEqual([
            { kind: 'result', status: 'ERROR', error: 'no key' },
        ]);
        expect(parser.parse({ type: 'other' })).toEqual([]);
    });

    it('createEventParser picks the parser for each engine', () => {
        expect(createEventParser('antigravity')({ event: 'init', conversation_id: 'a' })).toEqual([
            { kind: 'init', conversationId: 'a' },
        ]);
        expect(createEventParser('gemini-cli')({ type: 'init', session_id: 'b' })).toEqual([
            { kind: 'init', conversationId: 'b' },
        ]);
    });
});
