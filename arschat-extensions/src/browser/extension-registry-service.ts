import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event, ILogger, URI } from '@theia/core';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileUri } from '@theia/core/lib/common/file-uri';
import {
    ArschatExtensionManifest,
    ExtensionPermissionId,
    isValidExtensionName,
    parseManifestText,
    validateManifest
} from '../common/extension-manifest';
import { calculateNewPermissions, mergeGrantedPermissionsForManifest } from '../common/extension-permission-diff';
import { ExtensionFetchService } from '../common/extension-fetch-protocol';

export type ExtensionSource =
    | { readonly kind: 'github'; readonly url: string }
    | { readonly kind: 'local'; readonly path: string }
    | { readonly kind: 'autotest' };

export interface InstalledExtension {
    readonly name: string;
    readonly displayName: string;
    readonly version: string;
    readonly description?: string;
    readonly source: ExtensionSource;
    readonly manifestPermissions: ExtensionPermissionId[];
    readonly grantedPermissions: ExtensionPermissionId[];
    readonly enabled: boolean;
    readonly installedAt: string;
}

export interface ExtensionData {
    readonly manifestText: string;
    readonly manifest: ArschatExtensionManifest;
    readonly html: string;
}

export interface ExtensionPermissionApprovalRequest {
    readonly extension: InstalledExtension;
    readonly manifest: ArschatExtensionManifest;
    readonly newPermissions: ExtensionPermissionId[];
}

export type ExtensionPermissionApprover = (request: ExtensionPermissionApprovalRequest) => Promise<boolean>;

export interface ExtensionUpdateOptions {
    readonly notifyWhenUnchanged?: boolean;
}

interface RegistryFileShape {
    readonly extensions?: InstalledExtension[];
}

@injectable()
export class ExtensionRegistryService {

    @inject(EnvVariablesServer)
    protected readonly envServer!: EnvVariablesServer;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(ILogger)
    protected readonly logger!: ILogger;

    @inject(ExtensionFetchService)
    protected readonly fetchService!: ExtensionFetchService;

    protected extensions: InstalledExtension[] = [];
    protected loadingPromise: Promise<void> | undefined;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    get onDidChange(): Event<void> {
        return this.onDidChangeEmitter.event;
    }

    @postConstruct()
    protected init(): void {
        this.loadingPromise = this.load();
    }

    async ready(): Promise<void> {
        if (this.loadingPromise) {
            await this.loadingPromise;
        }
    }

    getExtensions(): InstalledExtension[] {
        return [...this.extensions];
    }

    getExtension(name: string): InstalledExtension | undefined {
        return this.extensions.find(ext => ext.name === name);
    }

    async installFromLocalPath(localPath: string, grantedPermissions: readonly ExtensionPermissionId[]): Promise<InstalledExtension> {
        const { manifestText, html } = await this.readLocalExtensionData(localPath);
        return this.installFromData(
            manifestText,
            html,
            { kind: 'local', path: localPath },
            grantedPermissions
        );
    }

    async readLocalManifest(localPath: string): Promise<ArschatExtensionManifest> {
        const { manifest } = await this.readLocalExtensionData(localPath);
        return manifest;
    }

    async readLocalExtensionData(localPath: string): Promise<ExtensionData> {
        return this.readLocalExtension(localPath);
    }

    async installFromData(
        manifestText: string,
        html: string,
        source: ExtensionSource,
        grantedPermissions: readonly ExtensionPermissionId[]
    ): Promise<InstalledExtension> {
        await this.ready();
        const manifest = validateManifest(parseManifestText(manifestText));
        this.validateGrantedPermissions(manifest, grantedPermissions);
        const normalizedGrantedPermissions = mergeGrantedPermissionsForManifest(manifest.permissions, grantedPermissions, []);
        const existing = this.getExtension(manifest.name);
        const installedAt = existing?.installedAt ?? new Date().toISOString();
        const entry: InstalledExtension = {
            name: manifest.name,
            displayName: manifest.displayName,
            version: manifest.version,
            description: manifest.description,
            source,
            manifestPermissions: [...manifest.permissions],
            grantedPermissions: normalizedGrantedPermissions,
            enabled: existing?.enabled ?? true,
            installedAt
        };
        await this.writeExtensionFiles(manifest.name, html);
        this.extensions = [...this.extensions.filter(ext => ext.name !== manifest.name), entry]
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
        await this.persist();
        this.onDidChangeEmitter.fire();
        return entry;
    }

    async setEnabled(name: string, enabled: boolean): Promise<void> {
        await this.ready();
        let changed = false;
        this.extensions = this.extensions.map(ext => {
            if (ext.name !== name) {
                return ext;
            }
            changed = true;
            return { ...ext, enabled };
        });
        if (changed) {
            await this.persist();
            this.onDidChangeEmitter.fire();
        }
    }

    async uninstall(name: string): Promise<void> {
        await this.ready();
        const before = this.extensions.length;
        this.extensions = this.extensions.filter(ext => ext.name !== name);
        const dir = await this.extensionDirUri(name);
        if (await this.fileService.exists(dir)) {
            await this.fileService.delete(dir, { recursive: true });
        }
        if (this.extensions.length !== before) {
            await this.persist();
            this.onDidChangeEmitter.fire();
        }
    }

    async update(
        name: string,
        approveNewPermissions?: ExtensionPermissionApprover,
        options: ExtensionUpdateOptions = {}
    ): Promise<InstalledExtension | undefined> {
        await this.ready();
        const existing = this.getExtension(name);
        if (!existing) {
            throw new Error(`Extension not installed: ${name}`);
        }
        if (existing.source.kind === 'autotest') {
            throw new Error('Autotest extensions cannot be updated');
        }

        const data = await this.fetchSourceData(existing.source);
        if (data.manifest.name !== existing.name) {
            throw new Error(`Extension update changed manifest name from '${existing.name}' to '${data.manifest.name}'`);
        }

        const newPermissions = calculateNewPermissions(data.manifest.permissions, existing.grantedPermissions);
        if (newPermissions.length > 0) {
            if (!approveNewPermissions) {
                throw new Error(`Extension update requires approval for new permissions: ${newPermissions.join(', ')}`);
            }
            const approved = await approveNewPermissions({
                extension: existing,
                manifest: data.manifest,
                newPermissions
            });
            if (!approved) {
                return undefined;
            }
        }

        const grantedPermissions = mergeGrantedPermissionsForManifest(
            data.manifest.permissions,
            existing.grantedPermissions,
            newPermissions
        );
        const updated: InstalledExtension = {
            ...existing,
            displayName: data.manifest.displayName,
            version: data.manifest.version,
            description: data.manifest.description,
            manifestPermissions: [...data.manifest.permissions],
            grantedPermissions
        };

        const changed = !this.sameExtension(existing, updated);
        if (changed) {
            this.extensions = [...this.extensions.filter(ext => ext.name !== updated.name), updated]
                .sort((a, b) => a.displayName.localeCompare(b.displayName));
            await this.persist();
        }
        if (existing.source.kind === 'github') {
            // Persist the approved permissions before replacing HTML. If the HTML
            // write then fails, the old HTML runs with the new (possibly narrower)
            // grants, which is fail-safe; the reverse could leave new HTML running
            // with stale, broader permissions.
            await this.writeExtensionFiles(data.manifest.name, data.html);
        }
        if (changed || options.notifyWhenUnchanged !== false) {
            this.onDidChangeEmitter.fire();
        }
        return this.getExtension(updated.name);
    }

    async getInstalledHtml(name: string): Promise<string> {
        const extension = this.getExtension(name);
        if (extension?.source.kind === 'local') {
            const { manifest, html } = await this.readLocalExtensionData(extension.source.path);
            if (manifest.name !== extension.name) {
                throw new Error(`Local extension manifest name changed from '${extension.name}' to '${manifest.name}'`);
            }
            const newlyDeclared = manifest.permissions.filter(permission => !extension.grantedPermissions.includes(permission));
            if (newlyDeclared.length > 0) {
                throw new Error(`Local extension requests unapproved permissions: ${newlyDeclared.join(', ')}`);
            }
            return html;
        }
        const uri = (await this.extensionDirUri(name)).resolve('main.html');
        return (await this.fileService.read(uri)).value;
    }

    async getStorage(name: string, key?: string): Promise<unknown> {
        const store = await this.readStorage(name);
        return key === undefined ? store : store[key];
    }

    async setStorage(name: string, key: string, value: unknown): Promise<void> {
        const store = await this.readStorage(name);
        store[key] = value;
        await this.writeStorage(name, store);
    }

    protected async readLocalExtension(localPath: string): Promise<ExtensionData> {
        const inputUri = this.toFileUri(localPath);
        const stat = await this.fileService.resolve(inputUri);
        const manifestUri = stat.isDirectory ? inputUri.resolve('arschat-extension.json') : inputUri;
        const manifestText = (await this.fileService.read(manifestUri)).value;
        const manifest = validateManifest(parseManifestText(manifestText));
        const entryUri = manifestUri.parent.resolve(manifest.entry);
        const html = (await this.fileService.read(entryUri)).value;
        return { manifestText, manifest, html };
    }

    protected async fetchSourceData(source: ExtensionSource): Promise<ExtensionData> {
        if (source.kind === 'github') {
            const fetched = await this.fetchService.fetchFromGitHub({ url: source.url });
            return {
                manifestText: fetched.manifestText,
                manifest: fetched.manifest,
                html: fetched.html
            };
        }
        if (source.kind === 'local') {
            return this.readLocalExtensionData(source.path);
        }
        throw new Error('Autotest extensions do not have an update source');
    }

    protected toFileUri(pathOrUri: string): URI {
        const trimmed = pathOrUri.trim();
        if (trimmed.includes('://')) {
            return new URI(trimmed);
        }
        if (typeof URI.fromFilePath === 'function') {
            return URI.fromFilePath(trimmed);
        }
        return FileUri.create(trimmed);
    }

    protected validateGrantedPermissions(manifest: ArschatExtensionManifest, grantedPermissions: readonly ExtensionPermissionId[]): void {
        const declared = new Set(manifest.permissions);
        const invalid = grantedPermissions.filter(permission => !declared.has(permission));
        if (invalid.length > 0) {
            throw new Error(`Granted permissions must be declared by the manifest: ${invalid.join(', ')}`);
        }
    }

    protected async registryFileUri(): Promise<URI> {
        return (await this.extensionsRootUri()).resolve('registry.json');
    }

    protected async extensionsRootUri(): Promise<URI> {
        const configDir = await this.envServer.getConfigDirUri();
        return new URI(configDir).resolve('arschat').resolve('extensions');
    }

    protected async extensionDirUri(name: string): Promise<URI> {
        if (!isValidExtensionName(name)) {
            throw new Error(`Invalid extension name: ${name}`);
        }
        return (await this.extensionsRootUri()).resolve(name);
    }

    protected async load(): Promise<void> {
        try {
            const uri = await this.registryFileUri();
            if (await this.fileService.exists(uri)) {
                const parsed = JSON.parse((await this.fileService.read(uri)).value) as RegistryFileShape;
                this.extensions = Array.isArray(parsed.extensions) ? parsed.extensions.filter(ext => this.isValidPersistedExtension(ext)) : [];
            }
        } catch (e) {
            this.logger.warn(`[arschat-extensions] failed to read registry.json: ${e instanceof Error ? e.message : String(e)}`);
            this.extensions = [];
        }
    }

    protected isValidPersistedExtension(extension: unknown): extension is InstalledExtension {
        if (!extension || typeof extension !== 'object') {
            return false;
        }
        const name = (extension as Partial<InstalledExtension>).name;
        if (typeof name === 'string' && isValidExtensionName(name)) {
            return true;
        }
        this.logger.warn(`[arschat-extensions] skipped registry entry with invalid name: ${typeof name === 'string' ? name : '<missing>'}`);
        return false;
    }

    protected async persist(): Promise<void> {
        const uri = await this.registryFileUri();
        const dir = uri.parent;
        if (!(await this.fileService.exists(dir))) {
            await this.fileService.createFolder(dir);
        }
        await this.fileService.write(uri, JSON.stringify({ extensions: this.extensions }, null, 2));
    }

    protected async writeExtensionFiles(name: string, html: string): Promise<void> {
        const dir = await this.extensionDirUri(name);
        if (!(await this.fileService.exists(dir))) {
            await this.fileService.createFolder(dir);
        }
        await this.fileService.write(dir.resolve('main.html'), html);
    }

    protected sameExtension(a: InstalledExtension, b: InstalledExtension): boolean {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    protected async readStorage(name: string): Promise<Record<string, unknown>> {
        const uri = (await this.extensionDirUri(name)).resolve('storage.json');
        if (!(await this.fileService.exists(uri))) {
            return {};
        }
        try {
            const parsed = JSON.parse((await this.fileService.read(uri)).value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
            return {};
        }
    }

    protected async writeStorage(name: string, store: Record<string, unknown>): Promise<void> {
        const dir = await this.extensionDirUri(name);
        if (!(await this.fileService.exists(dir))) {
            await this.fileService.createFolder(dir);
        }
        await this.fileService.write(dir.resolve('storage.json'), JSON.stringify(store, null, 2));
    }
}
