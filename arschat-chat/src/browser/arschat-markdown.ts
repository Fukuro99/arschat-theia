// *****************************************************************************
// ArsChat Markdown rendering (PHASE1_DESIGN.md §5).
//
// PHASE1_DESIGN.md §5 asks: check whether @theia/core's markdown renderer can
// be used, and if not, add marked + highlight.js.
//
// Decision (recorded in BUILD_NOTES.md M3): we use `marked` + `highlight.js`
// directly rather than @theia/core's MarkdownRenderer, because:
//   - MarkdownRenderer.render() returns an HTMLElement and expects a
//     MarkdownString + an async codeBlockRenderer callback wired into Theia's
//     Monaco-based tokenizer; bridging that into a React render() that
//     re-renders on every streamed chunk is awkward and pulls in the Monaco
//     colorizer for every code block.
//   - The old ArsChat already renders with `marked` (see
//     src/renderer/components/MessageBubble.tsx). Reusing the same library keeps
//     the streaming/`<think>` UX identical to the app users know.
//   - `marked` 14.x is already resolvable in the workspace; highlight.js is a
//     small, self-contained highlighter that works synchronously (no async
//     tokenizer), which suits per-chunk re-rendering.
//
// Output is sanitized with DOMPurify before it is injected via
// dangerouslySetInnerHTML, so streamed model output cannot inject script/style.
// *****************************************************************************

import { marked } from 'marked';
import type { HLJSApi } from 'highlight.js';
import type { DOMPurify as DOMPurifyType } from 'dompurify';

// highlight.js and dompurify ship `export default` / `export =`; the workspace
// tsconfig has no esModuleInterop. We resolve them LAZILY (inside the first
// render) rather than at module-eval time, so a resolution quirk can never throw
// while the frontend DI module is being loaded (that would take down the whole
// renderer). Runtime shapes vary (some builds expose the API under `.default`;
// DOMPurify's CJS entry is a factory pre-bound to a DOM when `window` exists).

let hljs: HLJSApi | undefined;
let DOMPurify: DOMPurifyType | undefined;
/** marked-katex-extension factory, resolved lazily like the other deps. */
let markedKatex: ((options?: unknown) => unknown) | undefined;
let configured = false;

/* eslint-disable @typescript-eslint/no-var-requires */
function ensureDeps(): void {
    if (!hljs) {
        const mod = require('highlight.js') as { default?: HLJSApi } & HLJSApi;
        hljs = mod.default ?? mod;
    }
    if (!DOMPurify) {
        const mod = require('dompurify') as DOMPurifyType & { default?: DOMPurifyType };
        let instance: DOMPurifyType = mod.default ?? mod;
        if (typeof instance.sanitize !== 'function' && typeof window !== 'undefined') {
            instance = (instance as unknown as (w: Window) => DOMPurifyType)(window);
        }
        DOMPurify = instance;
    }
    if (!markedKatex) {
        // marked-katex-extension ships `module.exports = fn` (CJS); with no
        // esModuleInterop we accept both the bare function and a `.default`.
        const mod = require('marked-katex-extension') as
            { default?: (options?: unknown) => unknown } | ((options?: unknown) => unknown);
        markedKatex = (typeof mod === 'function' ? mod : mod.default) as (options?: unknown) => unknown;
    }
}
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * Japanese LLM output frequently emits ¥ (U+00A5) or ￥ (U+FFE5, full-width) in
 * place of the LaTeX escape `\`, because on JIS keyboards the yen sign occupies
 * the backslash key. KaTeX only understands `\`, so - restricted to inside
 * $...$ / $$...$$ spans so we never touch ordinary prose - we normalize them
 * back to `\`. Mirrors the old ArsChat MessageBubble.tsx normalizeYenToBackslash.
 */
function normalizeYenToBackslash(text: string): string {
    const yen = /[¥￥]/g;
    let result = text.replace(/\$\$([\s\S]*?)\$\$/g, (_m, math: string) => `$$${math.replace(yen, '\\')}$$`);
    result = result.replace(/\$([^$\n]+?)\$/g, (_m, math: string) => `$${math.replace(yen, '\\')}$`);
    return result;
}

function configure(): void {
    if (configured) {
        return;
    }
    configured = true;
    marked.setOptions({
        gfm: true,
        breaks: true
    });
    // KaTeX math: inline $...$ and block $$...$$, matching the old ArsChat
    // MessageBubble.tsx options (throwOnError: false so a malformed expression
    // renders as red source text instead of aborting the whole parse; output:
    // 'html' avoids MathML so the sanitizer only ever sees <span>/class/style,
    // which DOMPurify keeps by default).
    if (markedKatex) {
        marked.use(markedKatex({ throwOnError: false, output: 'html' }) as Parameters<typeof marked.use>[0]);
    }
    // Syntax-highlight fenced code blocks. `marked` 14 uses a `walkTokens`/
    // renderer approach; we override the `code` renderer to run highlight.js and
    // emit a <pre><code class="hljs language-x"> block the CSS can style.
    marked.use({
        renderer: {
            code(this: unknown, token: { text: string; lang?: string }): string {
                const raw = token.text ?? '';
                const lang = (token.lang ?? '').trim().split(/\s+/)[0];
                let highlighted: string;
                let languageClass = '';
                const hl = hljs;
                if (hl && lang && hl.getLanguage(lang)) {
                    try {
                        highlighted = hl.highlight(raw, { language: lang }).value;
                        languageClass = ` language-${escapeAttr(lang)}`;
                    } catch {
                        highlighted = escapeHtml(raw);
                    }
                } else if (hl) {
                    try {
                        highlighted = hl.highlightAuto(raw).value;
                    } catch {
                        highlighted = escapeHtml(raw);
                    }
                } else {
                    highlighted = escapeHtml(raw);
                }
                const label = lang ? `<div class="arschat-code-lang">${escapeHtml(lang)}</div>` : '';
                return `<pre class="arschat-code-block">${label}<code class="hljs${languageClass}">${highlighted}</code></pre>`;
            }
        }
    });
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
    return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Render a Markdown string to sanitized HTML with syntax-highlighted code
 * blocks. Safe to call on every streamed chunk (synchronous, no async
 * tokenizer). Returns an empty string for empty input.
 */
export function renderMarkdown(markdownText: string): string {
    if (!markdownText) {
        return '';
    }
    ensureDeps();
    configure();
    const rawHtml = marked.parse(normalizeYenToBackslash(markdownText), { async: false }) as string;
    if (DOMPurify) {
        // KaTeX (output: 'html') emits <span class=... style=... aria-hidden=...>.
        // span/class/style/aria-hidden are in DOMPurify's default allow-list, so
        // math survives sanitization; we list style/aria-hidden explicitly (ADD_ATTR
        // is additive) so a future default-config change can't silently drop the
        // inline sizing KaTeX relies on.
        return DOMPurify.sanitize(rawHtml, {
            ADD_ATTR: ['target', 'class', 'style', 'aria-hidden'],
            ALLOW_DATA_ATTR: false
        });
    }
    return rawHtml;
}
