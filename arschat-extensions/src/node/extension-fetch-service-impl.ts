import { injectable } from '@theia/core/shared/inversify';
import {
    ExtensionFetchRequest,
    ExtensionFetchResult,
    ExtensionFetchService
} from '../common/extension-fetch-protocol';
import { parseManifestText, validateManifest } from '../common/extension-manifest';

const USER_AGENT = 'ArsChat-Theia/0.0.1';
const FETCH_TIMEOUT_MS = 10000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;

interface GitHubRepoApiResponse {
    readonly default_branch?: string;
}

@injectable()
export class ExtensionFetchServiceImpl implements ExtensionFetchService {

    async fetchFromGitHub(request: ExtensionFetchRequest): Promise<ExtensionFetchResult> {
        const repo = parseGitHubRepoUrl(request.url);
        const repoMeta = await this.fetchJson<GitHubRepoApiResponse>(`https://api.github.com/repos/${repo.owner}/${repo.name}`, MAX_MANIFEST_BYTES);
        const branch = repoMeta.default_branch;
        if (!branch) {
            throw new Error('GitHub repository response did not include default_branch');
        }

        const base = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodeURIComponent(branch)}`;
        const manifestText = await this.fetchText(`${base}/arschat-extension.json`, MAX_MANIFEST_BYTES);
        const manifest = validateManifest(parseManifestText(manifestText));
        const html = await this.fetchText(`${base}/${manifest.entry}`, MAX_HTML_BYTES);
        return { manifestText, manifest, html };
    }

    protected async fetchJson<T>(url: string, maxBytes: number): Promise<T> {
        const text = await this.fetchText(url, maxBytes, 'application/vnd.github+json');
        return JSON.parse(text) as T;
    }

    protected async fetchText(url: string, maxBytes: number, accept = 'text/plain,*/*;q=0.8'): Promise<string> {
        const res = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                Accept: accept
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (!res.ok) {
            throw new Error(`Extension fetch failed: HTTP ${res.status} ${res.statusText}`);
        }
        const text = await res.text();
        if (new TextEncoder().encode(text).byteLength > maxBytes) {
            throw new Error(`Extension fetch exceeded ${maxBytes} bytes`);
        }
        return text;
    }
}

function parseGitHubRepoUrl(url: string): { owner: string; name: string } {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('Expected a GitHub repository URL');
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
        throw new Error('Expected a https://github.com/owner/repo URL');
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error('Expected a https://github.com/owner/repo URL');
    }
    return { owner: parts[0], name: parts[1].replace(/\.git$/, '') };
}
