/**
 * Unit tests for parsing Antigravity CLI's model list.
 */
import { describe, expect, it } from 'vitest';

import { MAX_MODELS, parseModelLines } from '../../../../src/main/agent/models';

describe('parseModelLines', () => {
    it('reads `agy models` output and skips the progress line', () => {
        const output = [
            'Fetching available models...',
            'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
            'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
            '',
        ].join('\n');
        expect(parseModelLines(output)).toEqual([
            { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
            { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
        ]);
    });

    it('reads the default model line of `agy -p /model`', () => {
        expect(parseModelLines('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\n')[0]).toEqual({
            id: 'gemini-3.8-flash-high',
            name: 'Gemini 3.8 Flash (High)',
        });
    });

    it('ignores malformed lines, ids the app would not pass on, duplicates and colors', () => {
        const output = [
            'no tab here',
            '\tName without id',
            'id-without-name\t   ',
            'bad id\tName',
            'bad;id\tName',
            'ok-1\tFirst',
            'ok-1\tDuplicate',
            '\u001b[32mok-2\u001b[0m\t  Second   model ',
        ].join('\n');
        expect(parseModelLines(output)).toEqual([
            { id: 'ok-1', name: 'First' },
            { id: 'ok-2', name: 'Second model' },
        ]);
    });

    it('keeps at most MAX_MODELS models', () => {
        const output = Array.from({ length: MAX_MODELS + 20 }, (_, index) => `m-${index}\tModel ${index}`).join('\n');
        expect(parseModelLines(output)).toHaveLength(MAX_MODELS);
    });
});
