import { renderMarkdown } from './arschat-markdown';

describe('renderMarkdown', () => {

    it('renders basic markdown to HTML', () => {
        const html = renderMarkdown('# Hello\n\nsome **bold** text');
        expect(html).toContain('<h1');
        expect(html).toContain('Hello');
        expect(html).toContain('<strong>bold</strong>');
    });

    it('renders a fenced code block with a highlighted <code> element', () => {
        const html = renderMarkdown('```ts\nconst x: number = 1;\n```');
        expect(html).toContain('arschat-code-block');
        expect(html).toContain('class="hljs');
        // highlight.js wraps keywords in hljs-* spans
        expect(html).toContain('hljs-');
        // language label
        expect(html.toLowerCase()).toContain('ts');
    });

    it('sanitizes dangerous HTML (no script survives)', () => {
        const html = renderMarkdown('normal <script>alert(1)</script> text');
        expect(html).not.toContain('<script>');
    });

    it('returns empty string for empty input', () => {
        expect(renderMarkdown('')).toBe('');
    });

    // ---- M6 e-23: KaTeX math ----

    it('renders inline math ($...$) to a katex span', () => {
        const html = renderMarkdown('Euler: $e^{i\\pi} + 1 = 0$ is neat');
        expect(html).toContain('class="katex"');
        // the surrounding prose is preserved
        expect(html).toContain('Euler');
        expect(html).toContain('is neat');
    });

    it('renders block math ($$...$$) to a katex display block', () => {
        const html = renderMarkdown('$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$');
        expect(html).toContain('katex');
        // display math gets the katex-display wrapper
        expect(html).toContain('katex-display');
    });

    it('keeps KaTeX span/class/style through DOMPurify (math is not stripped)', () => {
        const html = renderMarkdown('$\\frac{1}{2}$');
        expect(html).toContain('<span');
        expect(html).toContain('class="katex"');
        // KaTeX relies on inline sizing styles; they must survive sanitization
        expect(html).toContain('style=');
    });

    it('normalizes yen sign to backslash inside math (Japanese keyboard quirk)', () => {
        // LLMs on JIS keyboards emit ￥frac instead of \frac; it must still render.
        const html = renderMarkdown('$￥frac{1}{2}$');
        expect(html).toContain('class="katex"');
        // the raw yen source must not leak into the output as a literal command
        expect(html).not.toContain('￥frac');
    });

    it('does not treat a lone dollar sign (price) as math', () => {
        const html = renderMarkdown('It costs $5 today');
        expect(html).not.toContain('class="katex"');
        expect(html).toContain('$5');
    });
});
