// *****************************************************************************
// Pure web_search / fetch_page ToolRequest factories (PHASE1_DESIGN.md §7, M5 e-5).
//
// Build the web_search / fetch_page ToolRequests (id, schema, description,
// handler) given a plain "web" backend. Theia-DI-free (only touches
// @theia/ai-core's ToolRequest *type*), so the tool shape, arg handling, and
// result formatting are unit-tested in a plain node jest env, mirroring
// command-tool-request.ts / file-tool-requests.ts.
//
// APPROVAL: web_search / fetch_page are read-only — they hit the network but do
// not write to the user's disk or run local commands — so they carry NO
// `confirmAlwaysAllow`. Under Theia 1.71.2's default ToolConfirmationMode
// (ALWAYS_ALLOW for tools without that flag) they run without a confirmation
// prompt, exactly like read_file. (SPEC: ms-6 e-5 "承認は不要 (read-only 扱い)".)
//
// ERRORS: HTTP failures / timeouts are returned as a `toolError(...)` string
// (never thrown), so the LLM reads the failure and can react — same contract as
// the other tools.
// *****************************************************************************

import type { ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { ARSCHAT_TOOL_PROVIDER_NAME, WEB_SEARCH_TOOL_ID, FETCH_PAGE_TOOL_ID } from './tool-ids';
import { parseToolArgs, toolError } from './tool-args';
import { WebSearchResult, FetchPageResult } from './web-fetch-protocol';

/** The network operations the web tools need; implemented by the backend proxy. */
export interface WebToolBackend {
    webSearch(query: string, maxResults?: number): Promise<WebSearchResult[]>;
    fetchPage(url: string, maxLength?: number): Promise<FetchPageResult>;
}

/** Format DuckDuckGo results into the numbered list the model reads back. */
export function formatSearchResults(query: string, results: WebSearchResult[]): string {
    if (results.length === 0) {
        return `No web results found for "${query}".`;
    }
    const lines = [`Web search results for "${query}":`, ''];
    results.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        if (r.snippet) {
            lines.push(`   ${r.snippet}`);
        }
        lines.push('');
    });
    return lines.join('\n').trimEnd();
}

export function createWebSearchTool(backend: WebToolBackend): ToolRequest {
    return {
        id: WEB_SEARCH_TOOL_ID,
        name: WEB_SEARCH_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        // Read-only (network read, no local mutation): NO confirmAlwaysAllow, so
        // Theia keeps it at the default ALWAYS_ALLOW and it runs without a prompt,
        // exactly like read_file. (ms-6 e-5 SPEC.)
        description: 'Search the web (via DuckDuckGo) and return a ranked list of results, each with a '
            + 'title, URL and snippet. Use this to find current information, documentation, or pages to '
            + 'read in full with fetch_page.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The search query.'
                },
                maxResults: {
                    type: 'number',
                    description: 'Maximum number of results to return. Defaults to 10.'
                }
            },
            required: ['query']
        },
        handler: async (argString: string) => {
            try {
                const { query, maxResults } = parseToolArgs<{ query: string; maxResults?: number }>(argString);
                if (!query || !query.trim()) {
                    return toolError('web_search requires a non-empty "query" argument.');
                }
                const results = await backend.webSearch(query.trim(), maxResults);
                return formatSearchResults(query.trim(), results);
            } catch (e) {
                return toolError(e instanceof Error ? e.message : String(e));
            }
        }
    };
}

export function createFetchPageTool(backend: WebToolBackend): ToolRequest {
    return {
        id: FETCH_PAGE_TOOL_ID,
        name: FETCH_PAGE_TOOL_ID,
        providerName: ARSCHAT_TOOL_PROVIDER_NAME,
        // Read-only (network read, no local mutation): NO confirmAlwaysAllow.
        description: 'Fetch a web page by URL and return its main text content. HTML pages are converted '
            + 'to Markdown (boilerplate like nav/scripts/footers stripped); non-HTML responses are '
            + 'returned as raw text. Very long pages are truncated. Use web_search first to find URLs.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'The absolute URL of the page to fetch (http:// or https://).'
                },
                maxLength: {
                    type: 'number',
                    description: 'Maximum length in characters of the returned content. Defaults to 15000.'
                }
            },
            required: ['url']
        },
        handler: async (argString: string) => {
            try {
                const { url, maxLength } = parseToolArgs<{ url: string; maxLength?: number }>(argString);
                if (!url || !url.trim()) {
                    return toolError('fetch_page requires a non-empty "url" argument.');
                }
                const result = await backend.fetchPage(url.trim(), maxLength);
                return formatFetchResult(url.trim(), result);
            } catch (e) {
                return toolError(e instanceof Error ? e.message : String(e));
            }
        }
    };
}

/** Format a fetched page into the model-facing text (content + truncation note). */
export function formatFetchResult(url: string, result: FetchPageResult): string {
    const header = `Content of ${url}${result.isHtml ? ' (converted to Markdown)' : ''}:`;
    const body = result.text || '(empty)';
    return result.truncated
        ? `${header}\n\n${body}\n\n(content was truncated to fit the context limit)`
        : `${header}\n\n${body}`;
}
