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
});
