import { ArschatExtensionManifest } from './extension-manifest';

export const arschatExtensionFetchServicePath = '/services/arschat-extension-fetch';

export const ExtensionFetchService = Symbol('ExtensionFetchService');

export interface ExtensionFetchRequest {
    readonly url: string;
}

export interface ExtensionFetchResult {
    readonly manifestText: string;
    readonly manifest: ArschatExtensionManifest;
    readonly html: string;
}

export interface ExtensionFetchService {
    fetchFromGitHub(request: ExtensionFetchRequest): Promise<ExtensionFetchResult>;
}
