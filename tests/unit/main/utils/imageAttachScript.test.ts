// @vitest-environment jsdom
/**
 * Unit tests for imageAttachScript (H10): the page scripts that attach Quick Chat's screenshot
 * to Gemini's message box. The scripts run here against a small fake of Gemini's input area.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
    buildAwaitClipboardPasteScript,
    buildPrepareClipboardPasteScript,
    buildSyntheticAttachScript,
    type ImageAttachResult,
} from '../../../../src/main/utils/imageAttachScript';

const PNG_BASE64 = Buffer.from('fake png bytes').toString('base64');

/** jsdom has no DataTransfer, ClipboardEvent or DragEvent; just enough of them for the script. */
function installEventPolyfills(): void {
    const scope = globalThis as unknown as Record<string, unknown>;
    if (!scope.DataTransfer) {
        class FakeDataTransfer {
            files: File[] = [];
            items = {
                add: (file: File) => {
                    this.files.push(file);
                },
            };
        }
        scope.DataTransfer = FakeDataTransfer;
    }
    if (!scope.ClipboardEvent) {
        class FakeClipboardEvent extends Event {
            clipboardData: unknown;
            constructor(type: string, init: EventInit & { clipboardData?: unknown } = {}) {
                super(type, init);
                this.clipboardData = init.clipboardData ?? null;
            }
        }
        scope.ClipboardEvent = FakeClipboardEvent;
    }
    if (!scope.DragEvent) {
        class FakeDragEvent extends Event {
            dataTransfer: unknown;
            constructor(type: string, init: EventInit & { dataTransfer?: unknown } = {}) {
                super(type, init);
                this.dataTransfer = init.dataTransfer ?? null;
            }
        }
        scope.DragEvent = FakeDragEvent;
    }
}

/** A fake Gemini input area with a Quill editor inside. */
function createInputArea(): { area: HTMLElement; editor: HTMLElement } {
    const area = document.createElement('input-area-v2');
    const wrapper = document.createElement('div');
    const editor = document.createElement('div');
    editor.className = 'ql-editor';
    editor.setAttribute('contenteditable', 'true');
    wrapper.appendChild(editor);
    area.appendChild(wrapper);
    document.body.appendChild(area);
    return { area, editor };
}

function addPreview(area: HTMLElement): void {
    area.appendChild(document.createElement('img'));
}

/** Run a page script the way executeJavaScript does and return its completion value. */
function runInPage<T>(script: string): Promise<T> {
    return Promise.resolve((0, eval)(script) as T);
}

describe('imageAttachScript', () => {
    beforeAll(() => {
        installEventPolyfills();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        delete (window as unknown as Record<string, unknown>).__geminiDesktopHintsBefore;
    });

    describe('buildSyntheticAttachScript', () => {
        it('rejects data that is not base64', () => {
            expect(() => buildSyntheticAttachScript("abc');alert(1);//")).toThrow('Invalid base64 image data');
            expect(() => buildSyntheticAttachScript('a b')).toThrow('Invalid base64 image data');
            expect(() => buildSyntheticAttachScript(PNG_BASE64)).not.toThrow();
        });

        it('builds valid JavaScript with the file name escaped', () => {
            const script = buildSyntheticAttachScript(PNG_BASE64, 'my "shot".png', 50);
            expect(() => new Function(script)).not.toThrow();
            expect(script).toContain(JSON.stringify('my "shot".png'));
        });

        it('attaches by paste when Gemini shows a preview after the paste event', async () => {
            const { area, editor } = createInputArea();
            let pasted: File | undefined;
            editor.addEventListener('paste', (event) => {
                const data = (event as unknown as { clipboardData: { files: File[] } }).clipboardData;
                pasted = data.files[0];
                addPreview(area);
            });
            const result = await runInPage<ImageAttachResult>(buildSyntheticAttachScript(PNG_BASE64, undefined, 50));
            expect(result).toEqual({ attached: true, method: 'paste' });
            expect(pasted?.name).toBe('screenshot.png');
            expect(pasted?.type).toBe('image/png');
            expect(pasted?.size).toBe(Buffer.from(PNG_BASE64, 'base64').length);
        });

        it('falls back to a drop when the paste shows nothing', async () => {
            const { area, editor } = createInputArea();
            const seen: string[] = [];
            for (const type of ['paste', 'dragenter', 'dragover', 'drop']) {
                editor.addEventListener(type, () => seen.push(type));
            }
            editor.addEventListener('drop', () => addPreview(area));
            const result = await runInPage<ImageAttachResult>(buildSyntheticAttachScript(PNG_BASE64, undefined, 50));
            expect(result).toEqual({ attached: true, method: 'drop' });
            expect(seen).toEqual(['paste', 'dragenter', 'dragover', 'drop']);
        });

        it('reports no preview when nothing reacts', async () => {
            createInputArea();
            const started = Date.now();
            const result = await runInPage<ImageAttachResult>(buildSyntheticAttachScript(PNG_BASE64, undefined, 50));
            expect(result).toEqual({ attached: false, error: 'no_preview_seen' });
            expect(Date.now() - started).toBeLessThan(2000);
        });

        it('does not count a preview that was already there', async () => {
            const { area } = createInputArea();
            addPreview(area);
            const result = await runInPage<ImageAttachResult>(buildSyntheticAttachScript(PNG_BASE64, undefined, 50));
            expect(result.attached).toBe(false);
        });

        it('reports a missing editor', async () => {
            const result = await runInPage<ImageAttachResult>(buildSyntheticAttachScript(PNG_BASE64, undefined, 50));
            expect(result).toEqual({ attached: false, error: 'editor_not_found' });
        });
    });

    describe('clipboard paste scripts', () => {
        it('are valid JavaScript', () => {
            expect(() => new Function(buildPrepareClipboardPasteScript())).not.toThrow();
            expect(() => new Function(buildAwaitClipboardPasteScript(50))).not.toThrow();
        });

        it('focus the editor, remember the previews and see a new one after the paste', async () => {
            const { area, editor } = createInputArea();
            addPreview(area);
            await expect(runInPage(buildPrepareClipboardPasteScript())).resolves.toEqual({ ready: true });
            expect(document.activeElement).toBe(editor);
            expect((window as unknown as Record<string, unknown>).__geminiDesktopHintsBefore).toBe(1);

            addPreview(area);
            const result = await runInPage<ImageAttachResult>(buildAwaitClipboardPasteScript(50));
            expect(result).toEqual({ attached: true, method: 'clipboard' });
            expect((window as unknown as Record<string, unknown>).__geminiDesktopHintsBefore).toBeUndefined();
        });

        it('report no preview when the paste showed nothing', async () => {
            const { area } = createInputArea();
            addPreview(area);
            await runInPage<boolean>(buildPrepareClipboardPasteScript());
            const result = await runInPage<ImageAttachResult>(buildAwaitClipboardPasteScript(50));
            expect(result).toEqual({ attached: false, error: 'no_preview_seen' });
        });

        it('report a late preview from the synthetic paste, so it is not pasted twice', async () => {
            const { area } = createInputArea();
            (window as unknown as Record<string, unknown>).__geminiDesktopHintsBaseline = 0;
            addPreview(area);
            await expect(runInPage(buildPrepareClipboardPasteScript())).resolves.toEqual({
                ready: false,
                alreadyAttached: true,
            });
            expect((window as unknown as Record<string, unknown>).__geminiDesktopHintsBaseline).toBeUndefined();
        });

        it('report a missing editor', async () => {
            await expect(runInPage(buildPrepareClipboardPasteScript())).resolves.toEqual({ ready: false });
            await expect(runInPage<ImageAttachResult>(buildAwaitClipboardPasteScript(50))).resolves.toEqual({
                attached: false,
                error: 'editor_not_found',
            });
        });
    });
});
