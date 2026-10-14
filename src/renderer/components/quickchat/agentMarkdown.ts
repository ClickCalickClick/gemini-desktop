/**
 * Safe Markdown rendering for agent output in Quick Chat.
 *
 * Agent output is untrusted. Raw HTML in it is escaped and shown as text, links
 * are shown as text with their address (they must not navigate Quick Chat's
 * window, and the renderer has no API to open them in a browser), and images are
 * replaced by their alt text so nothing is loaded from the network.
 *
 * @module agentMarkdown
 */

import { Marked } from 'marked';

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/** Escape text for use in HTML content or a quoted attribute. */
export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const agentMarked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
        html({ text, block }) {
            const escaped = escapeHtml(text);
            return block ? `<p>${escaped}</p>` : escaped;
        },
        link({ href, tokens }) {
            const inner = this.parser.parseInline(tokens);
            const safeHref = escapeHtml(href);
            const innerText = inner.replace(/<[^>]*>/g, '');
            const address = innerText === safeHref ? '' : ` <span class="qc-md-url">(${safeHref})</span>`;
            return `<span class="qc-md-link" title="${safeHref}">${inner}</span>${address}`;
        },
        image({ text }) {
            return text ? `<span class="qc-md-image">[${escapeHtml(text)}]</span>` : '';
        },
    },
});

/** Render agent Markdown to HTML that is safe to insert into the DOM. */
export function renderAgentMarkdown(markdown: string): string {
    return agentMarked.parse(markdown, { async: false });
}

/** Show a home-folder path with `~` (`/home/me/Downloads` → `~/Downloads`). */
export function tildify(path: string): string {
    return path.replace(/^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/, '~');
}
