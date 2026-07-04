// *****************************************************************************
// web_search / fetch_page backend service (PHASE1_DESIGN.md §7, M5 e-5).
//
// The single node place that performs the actual network I/O for the web tools.
// Exposed to the frontend over JSON-RPC via WebFetchService / webFetchServicePath
// (see ../common/web-fetch-protocol.ts and arschat-tools-backend-module.ts).
//
// Ported from ArsChat's web-search.ts (webSearch + fetchPage), with the parsing,
// URL unwrapping, and truncation extracted to the pure, unit-tested helpers in
// ../common/web-fetch.ts (fixed-fixture jest, no live network). This file is the
// thin `fetch` + TurndownService glue that must run on the backend:
//   - Node's built-in `fetch` (Node 18+) — no browser CORS wall,
//   - TurndownService (HTML -> Markdown) is a node-only dependency.
//
// Deviations from the ArsChat original (recorded in BUILD_NOTES "e-5"):
//   (1) HTTP failures / timeouts are RETURNED as an Error to the JSON-RPC caller;
//       the frontend ToolProviders turn any thrown error into a toolError(...)
//       string, so the LLM reads the failure rather than the tool silently
//       breaking. (The original threw; the difference is the frontend contract.)
//   (2) fetch_page keeps ArsChat's 15,000-char default but clamps a
//       caller-supplied maxLength to a 50,000 hard ceiling (clampFetchLength),
//       matching read_file / run_command's context budget.
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
// turndown ships `export = TurndownService` (CommonJS). The package tsconfig has
// no esModuleInterop, so use the TS `import = require` form rather than a default
// import (which would need that flag).
import TurndownService = require('turndown');
import {
    WebFetchService,
    WebSearchRequest,
    WebSearchResult,
    FetchPageRequest,
    FetchPageResult
} from '../common/web-fetch-protocol';
import {
    WEB_FETCH_USER_AGENT,
    WEB_SEARCH_DEFAULT_MAX_RESULTS,
    WEB_SEARCH_TIMEOUT_MS,
    FETCH_PAGE_TIMEOUT_MS,
    FETCH_PAGE_STRIP_TAGS,
    parseDdgResults,
    truncateText,
    clampFetchLength
} from '../common/web-fetch';

@injectable()
export class WebFetchServiceImpl implements WebFetchService {

    async webSearch(request: WebSearchRequest): Promise<WebSearchResult[]> {
        const maxResults = request.maxResults ?? WEB_SEARCH_DEFAULT_MAX_RESULTS;
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': WEB_FETCH_USER_AGENT,
                Accept: 'text/html',
                'Accept-Language': 'ja,en;q=0.9'
            },
            signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)
        });
        if (!res.ok) {
            throw new Error(`DuckDuckGo search failed: HTTP ${res.status} ${res.statusText}`);
        }
        const html = await res.text();
        return parseDdgResults(html, maxResults);
    }

    async fetchPage(request: FetchPageRequest): Promise<FetchPageResult> {
        const maxLength = clampFetchLength(request.maxLength);
        const res = await fetch(request.url, {
            headers: {
                'User-Agent': WEB_FETCH_USER_AGENT,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ja,en;q=0.9'
            },
            signal: AbortSignal.timeout(FETCH_PAGE_TIMEOUT_MS)
        });
        if (!res.ok) {
            throw new Error(`Page fetch failed: HTTP ${res.status} ${res.statusText}`);
        }

        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('html')) {
            // Non-HTML: return the raw text (truncated).
            const raw = await res.text();
            const { text, truncated } = truncateText(raw, maxLength);
            return { text, truncated, isHtml: false };
        }

        const html = await res.text();
        const td = new TurndownService({
            headingStyle: 'atx',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced'
        });
        // FETCH_PAGE_STRIP_TAGS is a plain string[] in the Theia-free common module;
        // turndown's Filter type wants (keyof HTMLElementTagNameMap)[]. Every entry is
        // a valid tag name, so narrow it here (keeps common/ DOM-type-free).
        td.remove(FETCH_PAGE_STRIP_TAGS as TurndownService.Filter);
        const markdown = td.turndown(html);
        const { text, truncated } = truncateText(markdown, maxLength);
        return { text, truncated, isHtml: true };
    }
}
