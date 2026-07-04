// Wiring-level tests for web_search / fetch_page's ToolRequests: the factories
// must yield the expected id/schema, be READ-ONLY (no confirmAlwaysAllow), and
// their handlers must route through the WebToolBackend and format the result the
// way the LLM sees it. Theia-DI-free (fake backend), plain node jest env.
import {
    createWebSearchTool,
    createFetchPageTool,
    formatSearchResults,
    formatFetchResult,
    WebToolBackend
} from './web-fetch-tool-request';
import { WEB_SEARCH_TOOL_ID, FETCH_PAGE_TOOL_ID, ARSCHAT_TOOL_PROVIDER_NAME } from './tool-ids';
import { WebSearchResult, FetchPageResult } from './web-fetch-protocol';

class FakeBackend implements WebToolBackend {
    lastQuery?: string;
    lastMaxResults?: number;
    lastUrl?: string;
    lastMaxLength?: number;
    searchResult: WebSearchResult[] = [
        { title: 'A', url: 'https://a.example', snippet: 'snip a' }
    ];
    pageResult: FetchPageResult = { text: 'body', truncated: false, isHtml: true };

    async webSearch(query: string, maxResults?: number): Promise<WebSearchResult[]> {
        this.lastQuery = query;
        this.lastMaxResults = maxResults;
        return this.searchResult;
    }
    async fetchPage(url: string, maxLength?: number): Promise<FetchPageResult> {
        this.lastUrl = url;
        this.lastMaxLength = maxLength;
        return this.pageResult;
    }
}

describe('web_search ToolRequest (shape + handler wiring)', () => {
    it('exposes the expected shape and is READ-ONLY (no confirmAlwaysAllow)', () => {
        const tool = createWebSearchTool(new FakeBackend());
        expect(tool.id).toBe(WEB_SEARCH_TOOL_ID);
        expect(tool.name).toBe(WEB_SEARCH_TOOL_ID);
        expect(tool.providerName).toBe(ARSCHAT_TOOL_PROVIDER_NAME);
        expect(tool.parameters.required).toContain('query');
        expect(tool.confirmAlwaysAllow).toBeUndefined();
    });

    it('routes the query + maxResults to the backend', async () => {
        const backend = new FakeBackend();
        const tool = createWebSearchTool(backend);
        await tool.handler(JSON.stringify({ query: 'theia ai', maxResults: 3 }));
        expect(backend.lastQuery).toBe('theia ai');
        expect(backend.lastMaxResults).toBe(3);
    });

    it('rejects an empty query without touching the backend', async () => {
        const backend = new FakeBackend();
        const out = (await createWebSearchTool(backend).handler(JSON.stringify({ query: '  ' }))) as string;
        expect(out).toMatch(/^ERROR:/);
        expect(backend.lastQuery).toBeUndefined();
    });

    it('surfaces a backend failure as an ERROR string', async () => {
        const backend = new FakeBackend();
        backend.webSearch = async () => { throw new Error('DuckDuckGo search failed: HTTP 503'); };
        const out = (await createWebSearchTool(backend).handler(JSON.stringify({ query: 'x' }))) as string;
        expect(out).toMatch(/^ERROR: DuckDuckGo search failed/);
    });

    it('formats results (or a no-results note) for the model', () => {
        const text = formatSearchResults('q', [
            { title: 'T1', url: 'https://one', snippet: 's1' },
            { title: 'T2', url: 'https://two', snippet: '' }
        ]);
        expect(text).toContain('1. T1');
        expect(text).toContain('https://one');
        expect(text).toContain('s1');
        expect(text).toContain('2. T2');
        expect(formatSearchResults('nothing', [])).toContain('No web results found');
    });
});

describe('fetch_page ToolRequest (shape + handler wiring)', () => {
    it('exposes the expected shape and is READ-ONLY (no confirmAlwaysAllow)', () => {
        const tool = createFetchPageTool(new FakeBackend());
        expect(tool.id).toBe(FETCH_PAGE_TOOL_ID);
        expect(tool.name).toBe(FETCH_PAGE_TOOL_ID);
        expect(tool.parameters.required).toContain('url');
        expect(tool.confirmAlwaysAllow).toBeUndefined();
    });

    it('routes url + maxLength to the backend', async () => {
        const backend = new FakeBackend();
        await createFetchPageTool(backend).handler(JSON.stringify({ url: 'https://p.example', maxLength: 4000 }));
        expect(backend.lastUrl).toBe('https://p.example');
        expect(backend.lastMaxLength).toBe(4000);
    });

    it('rejects an empty url without touching the backend', async () => {
        const backend = new FakeBackend();
        const out = (await createFetchPageTool(backend).handler(JSON.stringify({ url: '' }))) as string;
        expect(out).toMatch(/^ERROR:/);
        expect(backend.lastUrl).toBeUndefined();
    });

    it('surfaces a backend failure as an ERROR string', async () => {
        const backend = new FakeBackend();
        backend.fetchPage = async () => { throw new Error('Page fetch failed: HTTP 404 Not Found'); };
        const out = (await createFetchPageTool(backend).handler(JSON.stringify({ url: 'https://x' }))) as string;
        expect(out).toMatch(/^ERROR: Page fetch failed/);
    });

    it('formats the page content + a truncation note when cut', () => {
        const full = formatFetchResult('https://x', { text: 'hello world', truncated: false, isHtml: true });
        expect(full).toContain('Markdown');
        expect(full).toContain('hello world');
        expect(full).not.toContain('truncated');

        const cut = formatFetchResult('https://y', { text: 'partial', truncated: true, isHtml: false });
        expect(cut).toContain('partial');
        expect(cut).toContain('truncated');
        expect(cut).not.toContain('Markdown'); // non-HTML omits the Markdown note
    });
});
