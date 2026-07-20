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
const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_RAW_ORIGIN = 'https://raw.githubusercontent.com';
const GITHUB_REPO_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

interface GitHubRepoApiResponse {
    readonly default_branch?: string;
}

@injectable()
export class ExtensionFetchServiceImpl implements ExtensionFetchService {

    async fetchFromGitHub(request: ExtensionFetchRequest): Promise<ExtensionFetchResult> {
        const repo = parseGitHubRepoUrl(request.url);
        const repoMeta = await this.fetchJson<GitHubRepoApiResponse>(
            `${GITHUB_API_ORIGIN}/repos/${encodePathPart(repo.owner)}/${encodePathPart(repo.name)}`,
            MAX_MANIFEST_BYTES,
            GITHUB_API_ORIGIN
        );
        const branch = repoMeta.default_branch;
        if (!branch) {
            throw new Error('GitHub repository response did not include default_branch');
        }

        const base = `${GITHUB_RAW_ORIGIN}/${encodePathPart(repo.owner)}/${encodePathPart(repo.name)}/${encodePath(branch)}`;
        const manifestText = await this.fetchText(`${base}/arschat-extension.json`, MAX_MANIFEST_BYTES, 'text/plain,*/*;q=0.8', GITHUB_RAW_ORIGIN);
        const manifest = validateManifest(parseManifestText(manifestText));
        const html = await this.fetchText(`${base}/${encodePath(manifest.entry)}`, MAX_HTML_BYTES, 'text/plain,*/*;q=0.8', GITHUB_RAW_ORIGIN);
        return { manifestText, manifest, html };
    }

    protected async fetchJson<T>(url: string, maxBytes: number, expectedOrigin: string): Promise<T> {
        const text = await this.fetchText(url, maxBytes, 'application/vnd.github+json', expectedOrigin);
        return JSON.parse(text) as T;
    }

    protected async fetchText(
        url: string,
        maxBytes: number,
        accept = 'text/plain,*/*;q=0.8',
        expectedOrigin?: string
    ): Promise<string> {
        const res = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                Accept: accept
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (expectedOrigin && new URL(res.url).origin !== expectedOrigin) {
            throw new Error(`Extension fetch redirected to an unexpected origin: ${res.url}`);
        }
        if (!res.ok) {
            throw new Error(`Extension fetch failed: HTTP ${res.status} ${res.statusText}`);
        }
        const contentLength = res.headers.get('content-length');
        if (contentLength && Number(contentLength) > maxBytes) {
            throw new Error(`Extension fetch exceeded ${maxBytes} bytes`);
        }
        return this.readLimitedText(res, maxBytes);
    }

    protected async readLimitedText(res: Response, maxBytes: number): Promise<string> {
        if (!res.body) {
            const text = await res.text();
            if (new TextEncoder().encode(text).byteLength > maxBytes) {
                throw new Error(`Extension fetch exceeded ${maxBytes} bytes`);
            }
            return text;
        }

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (value) {
                    total += value.byteLength;
                    if (total > maxBytes) {
                        await reader.cancel();
                        throw new Error(`Extension fetch exceeded ${maxBytes} bytes`);
                    }
                    chunks.push(value);
                }
            }
        } finally {
            reader.releaseLock();
        }

        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new TextDecoder().decode(body);
    }
}

export function parseGitHubRepoUrl(url: string): { owner: string; name: string } {
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
    const owner = parts[0];
    const name = parts[1].replace(/\.git$/i, '');
    if (!GITHUB_REPO_PART_PATTERN.test(owner) || !GITHUB_REPO_PART_PATTERN.test(name)) {
        throw new Error('Expected GitHub owner and repository names to contain only letters, numbers, underscore, dot, or hyphen');
    }
    return { owner, name };
}

function encodePath(path: string): string {
    return path.split('/').map(encodePathPart).join('/');
}

function encodePathPart(part: string): string {
    return encodeURIComponent(part);
}
