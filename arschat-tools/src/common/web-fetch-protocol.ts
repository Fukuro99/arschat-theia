// *****************************************************************************
// RPC protocol for the web_search / fetch_page backend service
// (PHASE1_DESIGN.md §7, M5 e-5).
//
// Both tools hit the network (DuckDuckGo HTML scrape / arbitrary page fetch),
// which must run on the *backend*: Node's built-in `fetch` avoids the browser's
// CORS restrictions, and TurndownService (HTML -> Markdown) is a node dep. So
// the work lives in ../node/web-fetch-service-impl.ts and the frontend
// ToolProviders (../browser/web-*-tool-provider.ts) reach it through a JSON-RPC
// proxy created from `webFetchServicePath`, the same
// ConnectionHandler/RpcConnectionHandler pattern e-4's run_command uses (and
// which Theia's own @theia/file-search FileSearchService follows).
//
// This module is deliberately Theia-runtime-free (only a plain symbol +
// interfaces + data types) so it can be imported from both node and browser
// without dragging browser/DOM deps into the node build (same discipline as
// tool-ids.ts / command-runner-protocol.ts).
// *****************************************************************************

/** JSON-RPC service path the web_search / fetch_page backend is exposed on. */
export const webFetchServicePath = '/services/arschat-web-fetch';

/** DI symbol for the backend web-fetch service (bound in node + as a proxy in browser). */
export const WebFetchService = Symbol('WebFetchService');

/** One DuckDuckGo search hit. */
export interface WebSearchResult {
    /** The result title (HTML stripped). */
    title: string;
    /** The real destination URL (DDG `uddg` redirect already unwrapped). */
    url: string;
    /** The result snippet (HTML stripped), or '' when none was parsed. */
    snippet: string;
}

/** A request to run a DuckDuckGo web search. */
export interface WebSearchRequest {
    /** The search query. */
    query: string;
    /** Max number of results to return. Defaults to WEB_SEARCH_DEFAULT_MAX_RESULTS. */
    maxResults?: number;
}

/** A request to fetch a single page and return it as (Markdown) text. */
export interface FetchPageRequest {
    /** The absolute URL to fetch. */
    url: string;
    /** Max output length in chars. Defaults to FETCH_PAGE_DEFAULT_MAX_LENGTH. */
    maxLength?: number;
}

/** The result of fetch_page: the (possibly truncated) page text. */
export interface FetchPageResult {
    /** Page content: Markdown for HTML pages, raw text otherwise. */
    text: string;
    /** True when `text` was cut to the length cap. */
    truncated: boolean;
    /** True when the response was HTML converted to Markdown, false for raw text. */
    isHtml: boolean;
}

/**
 * The backend service the frontend calls over JSON-RPC. Two thin methods; the
 * frontend ToolProviders build the requests and format the results for the model.
 */
export interface WebFetchService {
    webSearch(request: WebSearchRequest): Promise<WebSearchResult[]>;
    fetchPage(request: FetchPageRequest): Promise<FetchPageResult>;
}
