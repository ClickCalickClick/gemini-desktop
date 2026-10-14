/**
 * Scripts that attach Quick Chat's screenshot to the message box of a Gemini tab (H10).
 *
 * Gemini takes an image pasted or dropped into its message box and uploads it. The script
 * builds a PNG file in the page and offers it as a paste, then as a drop, and watches the
 * message area for a new preview to tell whether Gemini took it. When neither works, the main
 * process pastes from the clipboard instead (a real paste, see QuickChatIpcHandler), with the
 * `prepare` and `await` scripts around it.
 *
 * Gemini's preview markup is not part of any contract, so the check is loose: anything that
 * looks like an image or a file chip appearing in the message area counts.
 *
 * @module imageAttachScript
 */

import { GEMINI_EDITOR_SELECTORS } from './constants';

/** Result of the `synthetic` and `await` scripts. */
export interface ImageAttachResult {
    attached: boolean;
    method?: 'paste' | 'drop' | 'clipboard';
    error?: string;
}

/** How long each way waits for Gemini to show the image. */
export const ATTACH_WAIT_MS = 3000;

/** Elements that suggest an attachment preview in the message area. */
export const ATTACHMENT_HINT_SELECTOR = [
    'img',
    'uploader-file-preview',
    'file-preview',
    '[class*="file-preview"]',
    '[class*="attachment"]',
    '[class*="image-preview"]',
    '[data-test-id*="file-preview"]',
    '[data-test-id*="uploaded"]',
].join(', ');

const SHARED_HELPERS = (editorSelectors: string, waitMs: number) => `
    const editorSelectors = ${editorSelectors};
    const hintSelector = ${JSON.stringify(ATTACHMENT_HINT_SELECTOR)};
    function findEditor() {
        for (const selector of editorSelectors) {
            try {
                const element = document.querySelector(selector);
                if (element) return element;
            } catch (e) {}
        }
        return null;
    }
    // The message area: the closest ancestor that looks like Gemini's input area, else a few levels up.
    function findArea(editor) {
        let node = editor;
        let fallback = editor;
        for (let depth = 0; node && node !== document.body && depth < 10; depth++) {
            const tag = (node.tagName || '').toLowerCase();
            const cls = typeof node.className === 'string' ? node.className : '';
            if (tag.includes('input-area') || cls.includes('input-area') || tag === 'fieldset' || tag === 'form') {
                return node;
            }
            if (depth === 6) fallback = node;
            node = node.parentElement;
        }
        return fallback || document.body;
    }
    function countHints(area) {
        try { return area.querySelectorAll(hintSelector).length; } catch (e) { return 0; }
    }
    function waitForMore(area, before) {
        return new Promise((resolve) => {
            const started = Date.now();
            (function check() {
                if (countHints(area) > before) return resolve(true);
                if (Date.now() - started >= ${waitMs}) return resolve(false);
                setTimeout(check, 100);
            })();
        });
    }
`;

/**
 * Offer the PNG to Gemini as a paste, then as a drop. Resolves an ImageAttachResult.
 */
export function buildSyntheticAttachScript(
    pngBase64: string,
    fileName = 'screenshot.png',
    waitMs = ATTACH_WAIT_MS
): string {
    if (!/^[A-Za-z0-9+/=]*$/.test(pngBase64)) {
        throw new Error('Invalid base64 image data');
    }
    return `
(async function() {
    'use strict';
    ${SHARED_HELPERS(JSON.stringify(GEMINI_EDITOR_SELECTORS), waitMs)}
    try {
        const editor = findEditor();
        if (!editor) return { attached: false, error: 'editor_not_found' };
        const area = findArea(editor);
        const binary = atob('${pngBase64}');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], ${JSON.stringify(fileName)}, { type: 'image/png', lastModified: Date.now() });
        const transfer = () => { const dt = new DataTransfer(); dt.items.add(file); return dt; };

        editor.focus();
        const baseline = countHints(area);
        // For the prepare script: a paste that shows up late must not be pasted again.
        window.__geminiDesktopHintsBaseline = baseline;
        let before = baseline;
        try {
            editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer(), bubbles: true, cancelable: true }));
        } catch (e) {}
        if (await waitForMore(area, before)) return { attached: true, method: 'paste' };

        if (countHints(area) > baseline) return { attached: true, method: 'paste' };
        before = countHints(area);
        try {
            const dt = transfer();
            for (const type of ['dragenter', 'dragover', 'drop']) {
                editor.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
            }
        } catch (e) {}
        if (await waitForMore(area, before)) return { attached: true, method: 'drop' };

        return { attached: false, error: 'no_preview_seen' };
    } catch (e) {
        return { attached: false, error: (e && e.message) || 'unknown_error' };
    }
})();
`.trim();
}

/**
 * Focus the message box and remember how many previews it shows, before a real paste. Resolves
 * `{ ready, alreadyAttached }`: `alreadyAttached` when a preview appeared since the synthetic
 * script started (its paste or drop was only slow), so no second copy is pasted.
 */
export function buildPrepareClipboardPasteScript(): string {
    return `
(function() {
    'use strict';
    ${SHARED_HELPERS(JSON.stringify(GEMINI_EDITOR_SELECTORS), 0)}
    const editor = findEditor();
    if (!editor) return { ready: false };
    const count = countHints(findArea(editor));
    const baseline = window.__geminiDesktopHintsBaseline;
    delete window.__geminiDesktopHintsBaseline;
    if (typeof baseline === 'number' && count > baseline) return { ready: false, alreadyAttached: true };
    editor.focus();
    window.__geminiDesktopHintsBefore = count;
    return { ready: true };
})();
`.trim();
}

/** After a real paste: wait for a new preview. Resolves an ImageAttachResult. */
export function buildAwaitClipboardPasteScript(waitMs = ATTACH_WAIT_MS): string {
    return `
(async function() {
    'use strict';
    ${SHARED_HELPERS(JSON.stringify(GEMINI_EDITOR_SELECTORS), waitMs)}
    const editor = findEditor();
    if (!editor) return { attached: false, error: 'editor_not_found' };
    const before = typeof window.__geminiDesktopHintsBefore === 'number' ? window.__geminiDesktopHintsBefore : 0;
    delete window.__geminiDesktopHintsBefore;
    const attached = await waitForMore(findArea(editor), before);
    return attached ? { attached: true, method: 'clipboard' } : { attached: false, error: 'no_preview_seen' };
})();
`.trim();
}
