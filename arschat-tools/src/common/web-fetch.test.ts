// Pure-logic tests for web_search / fetch_page's DDG parsing, URL unwrapping and
// truncation (../common/web-fetch.ts). Theia-DI-free / NO live network — the
// DuckDuckGo HTML is a fixed fixture — so these run in a plain node jest env
// alongside the file-tool / run_command tests.
import {
    parseDdgResults,
    unwrapDdgUrl,
    truncateText,
    clampFetchLength,
    FETCH_PAGE_DEFAULT_MAX_LENGTH,
    FETCH_PAGE_MAX_LENGTH
} from './web-fetch';

// A trimmed-but-faithful DuckDuckGo HTML result page. Mirrors the real markup
// this parser targets: result__a anchors (with //duckduckgo.com/l/?uddg=
// redirects) + positionally-aligned result__snippet anchors, plus a
// self-referential duckduckgo.com ad link that must be dropped.
const DDG_FIXTURE = `
<html><body>
  <div class="result results_links results_links_deep web-result">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffoo&amp;rut=abc">Example <b>Foo</b> Title</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffoo">This is the <b>foo</b> snippet text.</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmozilla.org%2Fbar">Mozilla Bar</a>
    <a class="result__snippet">Second snippet about bar.</a>
  </div>
  <div class="result result--ad">
    <a class="result__a" href="//duckduckgo.com/y.js?ad=1">Sponsored duckduckgo.com internal</a>
    <a class="result__snippet">Ad snippet (should be dropped).</a>
  </div>
</body></html>`;

describe('unwrapDdgUrl (DDG redirect -> real URL)', () => {
    it('extracts the decoded uddg target from a protocol-relative redirect', () => {
        const url = unwrapDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=x');
        expect(url).toBe('https://example.com/page');
    });

    it('falls back to the raw href when there is no uddg param', () => {
        expect(unwrapDdgUrl('https://direct.example/path')).toBe('https://direct.example/path');
    });

    it('falls back to the raw href on an unparseable value', () => {
        expect(unwrapDdgUrl('not a url')).toBe('not a url');
    });
});

describe('parseDdgResults (DuckDuckGo HTML scrape)', () => {
    it('extracts title/url/snippet, strips tags, and unwraps the redirect', () => {
        const results = parseDdgResults(DDG_FIXTURE, 10);
        expect(results.length).toBe(2); // the duckduckgo.com ad link is dropped
        expect(results[0]).toEqual({
            title: 'Example Foo Title',
            url: 'https://example.com/foo',
            snippet: 'This is the foo snippet text.'
        });
        expect(results[1].title).toBe('Mozilla Bar');
        expect(results[1].url).toBe('https://mozilla.org/bar');
        expect(results[1].snippet).toBe('Second snippet about bar.');
    });

    it('drops results that resolve back to duckduckgo.com', () => {
        const urls = parseDdgResults(DDG_FIXTURE, 10).map(r => r.url);
        expect(urls.some(u => u.includes('duckduckgo.com'))).toBe(false);
    });

    it('respects maxResults', () => {
        expect(parseDdgResults(DDG_FIXTURE, 1).length).toBe(1);
    });

    it('returns [] for HTML with no results', () => {
        expect(parseDdgResults('<html><body>no results</body></html>', 10)).toEqual([]);
    });
});

describe('truncateText (page/text length cap)', () => {
    it('leaves short text untouched and flags nothing', () => {
        const r = truncateText('hello', 100);
        expect(r.text).toBe('hello');
        expect(r.truncated).toBe(false);
    });

    it('cuts long text at the cap and appends a ...(truncated) marker', () => {
        const r = truncateText('x'.repeat(200), 50);
        expect(r.truncated).toBe(true);
        expect(r.text.startsWith('x'.repeat(50))).toBe(true);
        expect(r.text.endsWith('...(truncated)')).toBe(true);
    });
});

describe('clampFetchLength (default + hard ceiling)', () => {
    it('defaults to 15000 when omitted or non-positive', () => {
        expect(clampFetchLength(undefined)).toBe(FETCH_PAGE_DEFAULT_MAX_LENGTH);
        expect(clampFetchLength(0)).toBe(FETCH_PAGE_DEFAULT_MAX_LENGTH);
        expect(clampFetchLength(-5)).toBe(FETCH_PAGE_DEFAULT_MAX_LENGTH);
    });

    it('passes a sane caller value through', () => {
        expect(clampFetchLength(2000)).toBe(2000);
    });

    it('clamps an oversized request to the 50000 hard ceiling', () => {
        expect(clampFetchLength(1_000_000)).toBe(FETCH_PAGE_MAX_LENGTH);
    });
});
