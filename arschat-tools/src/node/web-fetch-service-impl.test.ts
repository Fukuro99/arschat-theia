// LIVE-NETWORK smoke test for the web_search backend (../node/web-fetch-service-impl.ts).
//
// This is the single allowed live smoke (ms-6 e-5 受入条件 3). It is OPT-IN: it
// only runs when ARSCHAT_WEB_SMOKE=1, so the default `yarn test` (and CI) never
// touches the network and cannot be broken by DuckDuckGo being down, rate
// limiting, or offline sandboxes. Run it manually with:
//   ARSCHAT_WEB_SMOKE=1 yarn --cwd arschat-tools test
//
// The offline path is still asserted (describe.skip prints as a skipped suite),
// so the file always contributes a green result to the default run.
import { WebFetchServiceImpl } from './web-fetch-service-impl';

const LIVE = process.env.ARSCHAT_WEB_SMOKE === '1';
const maybe = LIVE ? describe : describe.skip;

maybe('WebFetchServiceImpl live smoke (ARSCHAT_WEB_SMOKE=1)', () => {
    jest.setTimeout(30_000);

    it('webSearch returns real results with title + http(s) url', async () => {
        const svc = new WebFetchServiceImpl();
        const results = await svc.webSearch({ query: 'Eclipse Theia', maxResults: 5 });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].title.length).toBeGreaterThan(0);
        expect(results[0].url).toMatch(/^https?:\/\//);
    });

    it('fetchPage returns non-empty Markdown for an HTML page', async () => {
        const svc = new WebFetchServiceImpl();
        const page = await svc.fetchPage({ url: 'https://example.com', maxLength: 5000 });
        expect(page.isHtml).toBe(true);
        expect(page.text.length).toBeGreaterThan(0);
    });
});
