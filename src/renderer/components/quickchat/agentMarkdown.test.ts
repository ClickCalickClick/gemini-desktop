/**
 * Unit tests for safe agent Markdown rendering and the agent run reducer.
 */

import { describe, it, expect } from 'vitest';

import { escapeHtml, renderAgentMarkdown, tildify } from './agentMarkdown';
import { agentRunReducer, INITIAL_AGENT_RUN_STATE, isRunActive, needsSetupHint } from './agentRunState';

describe('renderAgentMarkdown', () => {
    it('renders Markdown formatting', () => {
        const html = renderAgentMarkdown('# Title\n\n- **bold** and `code`');
        expect(html).toContain('<h1');
        expect(html).toContain('<strong>bold</strong>');
        expect(html).toContain('<code>code</code>');
    });

    it('escapes inline and block HTML', () => {
        const html = renderAgentMarkdown('a <b onmouseover="x">b</b>\n\n<iframe src="https://evil"></iframe>');
        expect(html).not.toMatch(/<b[\s>]/);
        expect(html).not.toContain('<iframe');
        expect(html).toContain('&lt;iframe src=&quot;https://evil&quot;&gt;');
    });

    it('turns links into text with their address', () => {
        const html = renderAgentMarkdown('[docs](https://example.com/docs) and https://example.com');
        expect(html).not.toContain('<a ');
        expect(html).toContain('docs</span> <span class="qc-md-url">(https://example.com/docs)</span>');
        expect(html).toContain('title="https://example.com">https://example.com</span>');
    });

    it('replaces images with their alt text', () => {
        const html = renderAgentMarkdown('![a "chart"](https://example.com/x.png)');
        expect(html).not.toContain('<img');
        expect(html).toContain('[a &quot;chart&quot;]');
    });

    it('escapeHtml escapes the five special characters', () => {
        expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    });
});

describe('tildify', () => {
    it.each([
        ['/home/jared/Downloads/a.pdf', '~/Downloads/a.pdf'],
        ['/Users/jared/Documents', '~/Documents'],
        ['/home/jared', '~'],
        ['C:\\Users\\jared\\Desktop\\x.txt', '~\\Desktop\\x.txt'],
        ['/tmp/x', '/tmp/x'],
        ['/homework/x', '/homework/x'],
    ])('%s → %s', (input, output) => {
        expect(tildify(input)).toBe(output);
    });
});

describe('agentRunReducer', () => {
    const started = agentRunReducer(
        agentRunReducer(INITIAL_AGENT_RUN_STATE, { type: 'start', prompt: 'p', category: 'files' }),
        { type: 'assigned', runId: 'r1' }
    );

    it('keeps the conversation id across turns and resets it on reset', () => {
        const done = agentRunReducer(started, {
            type: 'event',
            event: { type: 'done', runId: 'r1', status: 'SUCCESS', response: 'x', conversationId: 'c1' },
        });
        expect(done.conversationId).toBe('c1');
        const next = agentRunReducer(done, { type: 'start', prompt: 'q', category: 'general' });
        expect(next.conversationId).toBe('c1');
        expect(next.text).toBe('');
        expect(agentRunReducer(next, { type: 'reset' }).conversationId).toBeNull();
    });

    it('ignores events from other runs', () => {
        const state = agentRunReducer(started, { type: 'event', event: { type: 'text', runId: 'r2', delta: 'x' } });
        expect(state).toBe(started);
    });

    it('marks steps done when the run ends', () => {
        let state = agentRunReducer(started, {
            type: 'event',
            event: { type: 'tool', runId: 'r1', name: 'shell', summary: 'ls', state: 'ACTIVE' },
        });
        expect(isRunActive(state)).toBe(true);
        state = agentRunReducer(state, {
            type: 'event',
            event: { type: 'done', runId: 'r1', status: 'ERROR', response: '', error: 'boom' },
        });
        expect(state.tools[0]?.state).toBe('DONE');
        expect(state.error).toBe('boom');
        expect(isRunActive(state)).toBe(false);
    });

    it('needsSetupHint recognises missing CLI and sign-in errors', () => {
        expect(needsSetupHint('No agent CLI found')).toBe(true);
        expect(needsSetupHint('agy: command not found')).toBe(true);
        expect(needsSetupHint('Please sign in first')).toBe(true);
        expect(needsSetupHint('GEMINI_API_KEY is not set')).toBe(true);
        expect(needsSetupHint('Timed out')).toBe(false);
        expect(needsSetupHint(null)).toBe(false);
    });
});
