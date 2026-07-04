// *****************************************************************************
// Pure web_search / fetch_page helpers (PHASE1_DESIGN.md §7, M5 e-5).
//
// web_search / fetch_page are *backend* (node) tools: they hit the network and
// (for fetch_page) run TurndownService, both of which need Node. What stays here
// is the Theia-DI-free, unit-testable core, ported from ArsChat's web-search.ts:
//   - parseDdgResults(): scrape the DuckDuckGo HTML result page into
//     {title,url,snippet}[], unwrapping the DDG `uddg` redirect to the real URL
//     and dropping duckduckgo.com self-links,
//   - truncateText(): bound page/text length so a huge page cannot blow the
//     model's context window,
// mirroring the "pure logic in common/, thin glue elsewhere" split used by the
// file + run_command tools. The backend impl (web-fetch-service-impl.ts) calls
// these so the parsing and truncation rules are covered by plain node jest with
// fixed HTML fixtures (no live network).
// *****************************************************************************

import type { WebSearchResult } from './web-fetch-protocol';

/**
 * Chrome UA + ja Accept-Language, matching ArsChat's web-search.ts. DuckDuckGo's
 * HTML endpoint serves the scrapeable markup to a browser-looking client; a bare
 * fetch UA gets a different / empty page. Shared by both requests.
 */
export const WEB_FETCH_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/124.0.0.0 Safari/537.36';

/** Default number of DuckDuckGo results returned when the request omits it. */
export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 10;

/**
 * Default fetch_page output cap in chars. We keep ArsChat's original 15,000
 * default (rather than the 50,000 run_command/read_file ceiling): fetched web
 * pages are pulled in *bulk* — the model often fetches several to answer one
 * question — so a tighter per-page budget keeps the aggregate context sane while
 * still capturing the substantive body of an article. The hard 50,000 ceiling
 * still applies as an upper clamp (see FETCH_PAGE_MAX_LENGTH). Rationale recorded
 * in BUILD_NOTES ("Phase 1 M5 実装メモ (e-5)").
 */
export const FETCH_PAGE_DEFAULT_MAX_LENGTH = 15_000;

/**
 * Absolute upper bound on fetch_page output, kept in sync with read_file /
 * run_command's 50,000-char context ceiling. A caller-supplied maxLength is
 * clamped to this so the tool can never be coerced into flooding the context
 * window with an arbitrarily large page.
 */
export const FETCH_PAGE_MAX_LENGTH = 50_000;

/** Request timeout (ms) for web_search — DuckDuckGo HTML endpoint. */
export const WEB_SEARCH_TIMEOUT_MS = 15_000;

/** Request timeout (ms) for fetch_page — arbitrary pages can be slower. */
export const FETCH_PAGE_TIMEOUT_MS = 20_000;

/** Tags stripped from HTML before Markdown conversion (boilerplate / non-content). */
export const FETCH_PAGE_STRIP_TAGS = ['script', 'style', 'nav', 'footer', 'aside', 'noscript', 'iframe', 'svg'];

/** Strip HTML tags from a fragment and collapse surrounding whitespace. */
function stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '').trim();
}

/**
 * Unwrap a DuckDuckGo HTML result href into the real destination URL.
 *
 * DDG links are redirects of the form `//duckduckgo.com/l/?uddg=<encoded-url>`;
 * the `uddg` query param carries the real (URL-encoded) target. We normalise a
 * protocol-relative href to https, parse it, and return the decoded `uddg` when
 * present. On any parse failure we fall back to the raw href.
 */
export function unwrapDdgUrl(href: string): string {
    try {
        const full = href.startsWith('//') ? `https:${href}` : href;
        const parsed = new URL(full);
        const uddg = parsed.searchParams.get('uddg');
        return uddg ?? href;
    } catch {
        return href;
    }
}

/**
 * Parse a DuckDuckGo HTML result page into structured results.
 *
 * Ported verbatim (behaviour-wise) from ArsChat's web-search.ts:
 *  - snippets are collected first from `result__snippet` anchors,
 *  - result links come from `result__a` anchors; their href is unwrapped via
 *    unwrapDdgUrl(), titleless entries are skipped, and any result still on
 *    duckduckgo.com (ads / internal links) is dropped,
 *  - snippet[i] is paired positionally with result link i (missing -> '').
 * Bounded to `maxResults`.
 */
export function parseDdgResults(html: string, maxResults: number): WebSearchResult[] {
    const results: WebSearchResult[] = [];

    // Collect snippets first (positionally aligned with the result links below).
    const snippets: string[] = [];
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
        snippets.push(stripTags(m[1]));
    }

    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let idx = 0;
    while ((m = linkRe.exec(html)) !== null && results.length < maxResults) {
        const href = m[1];
        const title = stripTags(m[2]);
        if (!title) {
            continue;
        }
        const url = unwrapDdgUrl(href);
        if (url.includes('duckduckgo.com')) {
            continue;
        }
        results.push({ title, url, snippet: snippets[idx] ?? '' });
        idx++;
    }

    return results;
}

/**
 * Bound `text` to `maxLength` chars, appending a `...(truncated)` marker when
 * cut. Matches ArsChat web-search.ts's truncation shape. Returns the text plus a
 * flag so the result type can report truncation to the model.
 */
export function truncateText(
    text: string,
    maxLength: number
): { text: string; truncated: boolean } {
    if (text.length <= maxLength) {
        return { text, truncated: false };
    }
    return { text: `${text.slice(0, maxLength)}\n\n...(truncated)`, truncated: true };
}

/** Clamp a caller-supplied fetch_page maxLength into (0, FETCH_PAGE_MAX_LENGTH]. */
export function clampFetchLength(maxLength: number | undefined): number {
    if (maxLength === undefined || !Number.isFinite(maxLength) || maxLength <= 0) {
        return FETCH_PAGE_DEFAULT_MAX_LENGTH;
    }
    return Math.min(Math.floor(maxLength), FETCH_PAGE_MAX_LENGTH);
}
