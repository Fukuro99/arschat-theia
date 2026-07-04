// *****************************************************************************
// web_search ToolProvider (PHASE1_DESIGN.md §7, M5 e-5).
//
// Thin @injectable @theia/ai-core ToolProvider: getTool() delegates to the pure
// createWebSearchTool() factory (../common/web-fetch-tool-request.ts), passing a
// backend that forwards to the WebFetchService JSON-RPC proxy (bound in the
// frontend module from webFetchServicePath). The actual network scrape runs on
// the *backend* (Node fetch, no CORS).
//
// Approval: web_search is read-only (network read, no local mutation), so its
// ToolRequest carries no `confirmAlwaysAllow` and runs without a confirmation
// prompt under Theia's default ALWAYS_ALLOW — same as read_file.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';
import { WebToolBackend, createWebSearchTool } from '../common/web-fetch-tool-request';
import { WebFetchService, WebSearchResult, FetchPageResult } from '../common/web-fetch-protocol';

@injectable()
export class WebSearchToolProvider implements ToolProvider, WebToolBackend {

    @inject(WebFetchService)
    protected readonly web!: WebFetchService;

    getTool(): ToolRequest {
        return createWebSearchTool(this);
    }

    async webSearch(query: string, maxResults?: number): Promise<WebSearchResult[]> {
        return this.web.webSearch({ query, maxResults });
    }

    async fetchPage(url: string, maxLength?: number): Promise<FetchPageResult> {
        return this.web.fetchPage({ url, maxLength });
    }
}
