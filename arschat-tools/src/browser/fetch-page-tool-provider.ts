// *****************************************************************************
// fetch_page ToolProvider (PHASE1_DESIGN.md §7, M5 e-5).
//
// Thin @injectable @theia/ai-core ToolProvider: getTool() delegates to the pure
// createFetchPageTool() factory (../common/web-fetch-tool-request.ts), passing a
// backend that forwards to the WebFetchService JSON-RPC proxy (bound in the
// frontend module from webFetchServicePath). The fetch + HTML->Markdown
// conversion runs on the *backend* (Node fetch + Turndown, no CORS).
//
// Approval: fetch_page is read-only (network read, no local mutation), so its
// ToolRequest carries no `confirmAlwaysAllow` and runs without a confirmation
// prompt under Theia's default ALWAYS_ALLOW — same as read_file.
// *****************************************************************************

import { inject, injectable } from '@theia/core/shared/inversify';
import { ToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { ToolRequest } from '@theia/ai-core';
import { WebToolBackend, createFetchPageTool } from '../common/web-fetch-tool-request';
import { WebFetchService, WebSearchResult, FetchPageResult } from '../common/web-fetch-protocol';

@injectable()
export class FetchPageToolProvider implements ToolProvider, WebToolBackend {

    @inject(WebFetchService)
    protected readonly web!: WebFetchService;

    getTool(): ToolRequest {
        return createFetchPageTool(this);
    }

    async webSearch(query: string, maxResults?: number): Promise<WebSearchResult[]> {
        return this.web.webSearch({ query, maxResults });
    }

    async fetchPage(url: string, maxLength?: number): Promise<FetchPageResult> {
        return this.web.fetchPage({ url, maxLength });
    }
}
