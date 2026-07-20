import { ExtensionFetchServiceImpl, parseGitHubRepoUrl } from './extension-fetch-service-impl';

class TestExtensionFetchService extends ExtensionFetchServiceImpl {
    fetchPublic(url: string, expectedOrigin: string): Promise<string> {
        return this.fetchText(url, 1024, 'text/plain,*/*;q=0.8', expectedOrigin);
    }
}

function responseWithUrl(body: string, url: string): Response {
    const response = new Response(body, { status: 200 });
    Object.defineProperty(response, 'url', { value: url });
    return response;
}

describe('parseGitHubRepoUrl', () => {
    it('accepts owner and repository names with GitHub-safe characters and trims .git', () => {
        expect(parseGitHubRepoUrl('https://github.com/Owner.Name/repo_name.git')).toEqual({
            owner: 'Owner.Name',
            name: 'repo_name'
        });
    });

    it('rejects non-GitHub and non-repository URLs', () => {
        expect(() => parseGitHubRepoUrl('http://github.com/owner/repo')).toThrow(/https:\/\/github\.com/);
        expect(() => parseGitHubRepoUrl('https://github.com/owner/repo/tree/main')).toThrow(/owner\/repo/);
        expect(() => parseGitHubRepoUrl('https://example.com/owner/repo')).toThrow(/https:\/\/github\.com/);
    });

    it('rejects invalid owner or repository characters', () => {
        expect(() => parseGitHubRepoUrl('https://github.com/owner%2Fname/repo')).toThrow(/letters/);
        expect(() => parseGitHubRepoUrl('https://github.com/owner/repo@example')).toThrow(/letters/);
    });

    it('rejects an empty repository name after trimming .git', () => {
        expect(() => parseGitHubRepoUrl('https://github.com/owner/.git')).toThrow(/letters/);
    });
});

describe('ExtensionFetchServiceImpl redirects', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('rejects a final response URL on an unexpected origin', async () => {
        globalThis.fetch = jest.fn().mockResolvedValue(responseWithUrl('ok', 'https://evil.example/file')) as typeof fetch;

        await expect(new TestExtensionFetchService().fetchPublic(
            'https://raw.githubusercontent.com/owner/repo/main/main.html',
            'https://raw.githubusercontent.com'
        )).rejects.toThrow(/unexpected origin/);
    });

    it('allows a final response URL on the expected origin', async () => {
        globalThis.fetch = jest.fn().mockResolvedValue(responseWithUrl('ok', 'https://raw.githubusercontent.com/owner/repo/main/main.html')) as typeof fetch;

        await expect(new TestExtensionFetchService().fetchPublic(
            'https://raw.githubusercontent.com/owner/repo/main/main.html',
            'https://raw.githubusercontent.com'
        )).resolves.toBe('ok');
    });
});
